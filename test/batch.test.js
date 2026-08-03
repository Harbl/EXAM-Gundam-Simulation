const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { runBatch } = require('../src/sim/batch');
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
  const validation = validateDeck(parsed, lookupCard, banlist);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

test('runBatch aggregates results, reports progress every game, and yields well-formed stats', async () => {
  const deck = buildJakesDeck();
  const progressEvents = [];

  const stats = await runBatch(deck, deck, 5, (p) => progressEvents.push(p));

  assert.equal(progressEvents.length, 5);
  assert.deepEqual(progressEvents[4], { completed: 5, games: 5 });

  assert.equal(stats.games, 5);
  assert.equal(stats.deckA.wins + stats.deckB.wins + stats.timeouts, 5);
  assert.ok(stats.averageTurns > 0);
  for (const side of [stats.deckA, stats.deckB]) {
    assert.ok(side.winRate >= 0 && side.winRate <= 1);
    assert.ok(side.mulliganRate >= 0 && side.mulliganRate <= 1);
    assert.ok(side.turn1PlayRate <= side.turn2PlayRate);
    assert.ok(side.turn2PlayRate <= side.turn3PlayRate);
  }
});

test('runBatch computes first-player win rate, length spread, margin of victory, and decisive win rate', async () => {
  const deck = buildJakesDeck();
  const stats = await runBatch(deck, deck, 12, null);

  for (const side of [stats.deckA, stats.deckB]) {
    assert.ok(side.winRateWhenFirst >= 0 && side.winRateWhenFirst <= 1);
    assert.ok(side.winRateWhenSecond >= 0 && side.winRateWhenSecond <= 1);
    assert.ok(side.decisiveWinRate >= 0 && side.decisiveWinRate <= 1);
    assert.ok(side.marginOfVictory >= 0 && side.marginOfVictory <= 6, 'margin of victory should be a plausible shield count');
  }

  assert.ok(stats.shortestGame > 0);
  assert.ok(stats.longestGame >= stats.shortestGame);
  assert.ok(stats.medianGame >= stats.shortestGame && stats.medianGame <= stats.longestGame);

  // Decisive win rate should exclude draws/timeouts, so it's normalized over a smaller (or equal)
  // denominator than the headline win rate -- meaning it's never smaller in magnitude terms.
  const decisiveGames = stats.deckA.wins + stats.deckB.wins;
  if (decisiveGames > 0 && decisiveGames < stats.games) {
    assert.ok(stats.deckA.decisiveWinRate >= stats.deckA.winRate);
  }
});

test('runBatch records a per-game seed, so any individual game can be replayed later', async () => {
  const deck = buildJakesDeck();
  const stats = await runBatch(deck, deck, 5, null);

  assert.equal(stats.perGame.length, 5);
  const seeds = new Set();
  for (const game of stats.perGame) {
    assert.equal(typeof game.seed, 'number');
    seeds.add(game.seed);
    assert.ok(game.winner === 0 || game.winner === 1 || game.draw || game.timedOut);
  }
  assert.equal(seeds.size, 5, 'expected every game in the batch to get its own distinct seed');
});
