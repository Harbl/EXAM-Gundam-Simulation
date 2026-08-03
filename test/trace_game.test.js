const test = require('node:test');
const assert = require('node:assert/strict');

// Must be required first in this file -- see the big comment at the top of src/sim/traceGame.js.
// node --test runs each test file in its own process by default, so this ordering only needs to
// hold within this one file, same precedent as test/skill_engine.test.js.
const { traceGame } = require('../src/sim/traceGame');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
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

test('traceGame returns a structured event log, mulligan decisions first, gameStart before real turns, gameEnd last', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);

  assert.ok(events.length > 2);
  // Mulligan decisions happen inside initializeGame's own setup, chronologically before the turn
  // loop begins -- any that appear lead the log, one per player, each other event coming after.
  const mulliganEvents = events.filter((e) => e.type === 'mulligan');
  assert.equal(mulliganEvents.length, 2, 'exactly one mulligan decision per player');
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ['mulligan', 'mulligan']);

  const gameStart = events[2];
  assert.equal(gameStart.type, 'gameStart');
  assert.ok(gameStart.firstPlayer === 0 || gameStart.firstPlayer === 1);

  const last = events[events.length - 1];
  assert.equal(last.type, 'gameEnd');
  assert.ok(last.winner === 0 || last.winner === 1 || last.draw || last.timedOut);

  // Real gameplay decisions -- draws, resource placement, deploys, and attacks -- should show up.
  assert.ok(events.some((e) => e.type === 'draw'));
  assert.ok(events.some((e) => e.type === 'resource'));
  assert.ok(events.some((e) => e.type === 'deploy'));
  assert.ok(events.some((e) => e.type === 'attack'));
});

// `instance.id` comes from a process-lifetime global counter (state.js's nextInstanceId), not from
// the seed -- it's a bookkeeping value that legitimately differs between two separate traceGame()
// calls in the same process, even though every seed-derived decision (deploys/attacks/targets/
// outcome) lines up exactly. Stripped out here since it isn't part of the seeded-determinism contract.
function stripIds(events) {
  return JSON.parse(JSON.stringify(events, (key, value) => (key === 'id' ? undefined : value)));
}

test('traceGame with the same seed reproduces the exact same event log', () => {
  const deck = buildJakesDeck();
  const eventsA = traceGame(deck, deck, 555);
  const eventsB = traceGame(deck, deck, 555);
  assert.deepEqual(stripIds(eventsA), stripIds(eventsB));
});

test('mulligan events carry a real player id and a boolean decision, one per player', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const mulliganEvents = events.filter((e) => e.type === 'mulligan');
  const players = mulliganEvents.map((e) => e.player).sort();
  assert.deepEqual(players, [0, 1]);
  for (const e of mulliganEvents) assert.equal(typeof e.mulliganed, 'boolean');
});

test('resource events fire for the active player only, once per turn they place one', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const resourceEvents = events.filter((e) => e.type === 'resource');
  assert.ok(resourceEvents.length > 0);
  // Each resource event's player must match the turnStart immediately preceding it (the active
  // player for that turn) -- resources are never placed for the non-active side.
  let lastTurnStart = null;
  for (const e of events) {
    if (e.type === 'turnStart') lastTurnStart = e;
    if (e.type === 'resource') assert.equal(e.player, lastTurnStart.player);
  }
});

test('a real Burst reveal (Jaburo, seed 1) logs the shield card and whether it activated', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 1);
  const burst = events.find((e) => e.type === 'burst');
  assert.ok(burst, 'expected at least one Burst reveal in this seeded game');
  assert.equal(burst.card.number, 'GD04-122');
  assert.equal(burst.activated, true);
  assert.ok(burst.player === 0 || burst.player === 1);
});

test('traceGame only logs real decisions, not the AI search\'s cloned-state scratch trials', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 111);
  // A real full game between two 50-card decks plays out over many turns with, at most, a modest
  // number of actual attacks -- if the search's internal scratch trials were leaking through, this
  // would be in the hundreds/thousands instead.
  const attackEvents = events.filter((e) => e.type === 'attack');
  assert.ok(attackEvents.length < 200, `expected a plausible real attack count, got ${attackEvents.length}`);
});
