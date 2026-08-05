const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { buildBracket, playMatch, runTournament, deckStats } = require('../src/sim/tournament');
const banlist = require('../data/banlist.json');

const JAKES_DECKLIST = `
4 GM ST01-005
4 Guntank GD01-008
4 Zaku II ST03-008
4 Char's Zaku II GD01-026
4 Char's Zaku II ST03-006
4 Char Aznable ST03-011
4 Rick Dom GD01-030
4 ReZEL GD01-018
4 Amuro Ray ST01-010
4 Gundam ST01-001
4 A Show of Resolve GD01-100
2 Delta Plus GD01-006
2 Jaburo GD04-122
2 Zeong GD04-017
`;

function buildJakesDeck() {
  const parsed = parseDecklistText(JAKES_DECKLIST);
  validateDeck(parsed, lookupCard, banlist);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

function makeEntrants(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i, name: `Deck ${i}`, deck: buildJakesDeck() }));
}

test('buildBracket pads to the next power of 2 with byes and keeps every entrant exactly once', () => {
  const entrants = makeEntrants(5);
  const slots = buildBracket(entrants);

  assert.equal(slots.length, 8);
  const presentIds = slots.filter(Boolean).map((e) => e.id).sort();
  assert.deepEqual(presentIds, [0, 1, 2, 3, 4]);
  assert.equal(slots.filter((s) => s === null).length, 3);
});

test('buildBracket leaves an already-power-of-2 field untouched in size, just shuffled', () => {
  const entrants = makeEntrants(4);
  const slots = buildBracket(entrants);
  assert.equal(slots.length, 4);
  assert.equal(slots.filter(Boolean).length, 4);
});

test('playMatch stops at the first majority and reports a consistent score', () => {
  const deck = buildJakesDeck();
  const result = playMatch(deck, deck, 3);

  assert.ok(result.winnerIdx === 0 || result.winnerIdx === 1);
  assert.ok(result.scoreA === 2 || result.scoreB === 2);
  assert.ok(result.scoreA < 2 || result.scoreB < 2);
  assert.equal(result.games.length, result.scoreA + result.scoreB);
});

test('runTournament crowns a champion and never leaks deck objects into the bracket output', () => {
  const entrants = makeEntrants(3);
  const events = [];
  const { rounds, champion } = runTournament(entrants, 1, (e) => events.push(e));

  assert.ok(champion);
  assert.ok([0, 1, 2].includes(champion.id));
  assert.equal(champion.deck, undefined);

  // 3 entrants -> round 1 has a bye (2 slots) then 1 real match, round 2 is the final.
  assert.equal(rounds.length, 2);
  const round1Matches = rounds[0].filter((m) => m.result);
  assert.equal(round1Matches.length, 1);
  const byes = rounds[0].filter((m) => !m.result);
  assert.equal(byes.length, 1);
  for (const round of rounds) {
    for (const match of round) {
      if (match.a) assert.equal(match.a.deck, undefined);
      if (match.b) assert.equal(match.b.deck, undefined);
    }
  }
  assert.ok(events.length >= 1, 'onProgress should fire for at least the real (non-bye) matches');
});

test('runTournament fires a seeded event first, with the full bracket shape (later rounds as TBD placeholders)', () => {
  const entrants = makeEntrants(4);
  const events = [];
  runTournament(entrants, 1, (e) => events.push(e));

  assert.equal(events[0].phase, 'seeded');
  assert.equal(events[0].rounds.length, 2, '4 entrants -> a 2-round bracket (semifinal-less: round 0 + final)');
  assert.equal(events[0].rounds[0].length, 2);
  assert.equal(events[0].rounds[1].length, 1);
  for (const match of events[0].rounds[0]) {
    assert.ok(match.a && match.b, '4 entrants is already a power of 2, so round 0 has no byes');
  }
  // The final hasn't been paired yet at seed time -- both its slots are still unknown.
  assert.equal(events[0].rounds[1][0].a, null);
  assert.equal(events[0].rounds[1][0].b, null);

  const rest = events.slice(1);
  assert.ok(rest.every((e) => e.phase === 'match'));
});

test('runTournament reveals a winner into the next round\'s slot as soon as their match resolves, not just at round end', () => {
  const entrants = makeEntrants(4);
  const events = [];
  const { rounds: finalRounds } = runTournament(entrants, 1, (e) => events.push(e));

  const firstMatchEvent = events.find((e) => e.phase === 'match' && e.round === 0 && e.matchIndex === 0);
  assert.ok(firstMatchEvent);
  // Round 0 match 0's winner should already be seated in the final's 'a' slot on this same event --
  // the whole point of streaming per-match snapshots is that the UI doesn't have to wait for match 1
  // to also finish before it can show who match 0's winner will face.
  const revealedWinner = firstMatchEvent.rounds[1][0].a;
  assert.ok(revealedWinner);
  assert.equal(revealedWinner.id, firstMatchEvent.rounds[0][0].result.winnerIdx === 0
    ? firstMatchEvent.rounds[0][0].a.id
    : firstMatchEvent.rounds[0][0].b.id);

  // And the final returned rounds agree with what was streamed.
  assert.equal(finalRounds[1][0].a.id, revealedWinner.id);
});

test('a bye advances its entrant into the next round without ever playing a game', () => {
  const entrants = makeEntrants(3);
  const { rounds } = runTournament(entrants, 1);

  const byeMatch = rounds[0].find((m) => m.bye);
  assert.ok(byeMatch);
  const byeEntrant = byeMatch.a || byeMatch.b;
  assert.ok(byeEntrant);
  const finalMatch = rounds[1][0];
  assert.ok(
    [finalMatch.a && finalMatch.a.id, finalMatch.b && finalMatch.b.id].includes(byeEntrant.id),
    'the bye entrant should show up in the final without a played match'
  );
});

test('deckStats tallies a champion\'s full record across every real match they played', () => {
  const entrants = makeEntrants(4);
  const { rounds, champion } = runTournament(entrants, 1);

  const stats = deckStats(champion.id, rounds);
  assert.equal(stats.matchesPlayed, 2, 'a 4-entrant bracket is 2 rounds, so an undefeated champion played 2 matches');
  assert.equal(stats.matchesWon, 2);
  assert.equal(stats.eliminatedRound, null);
  assert.ok(stats.gamesPlayed >= stats.matchesPlayed);
  assert.ok(stats.winRate > 0);
});

test('deckStats records the elimination round for a non-champion who lost', () => {
  const entrants = makeEntrants(4);
  const { rounds, champion } = runTournament(entrants, 1);
  const loserId = entrants.map((e) => e.id).find((id) => id !== champion.id);

  const stats = deckStats(loserId, rounds);
  assert.ok(stats.matchesPlayed >= 1);
  assert.ok(stats.eliminatedRound === 0 || stats.eliminatedRound === 1);
});
