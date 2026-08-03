const test = require('node:test');
const assert = require('node:assert/strict');

const { mulberry32 } = require('../src/rules/rng');
const { shuffle } = require('../src/rules/state');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const banlist = require('../data/banlist.json');

test('mulberry32 is deterministic given the same seed and produces values in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1);
  }
});

test('mulberry32 with a different seed produces a different sequence', () => {
  const seqA = Array.from({ length: 5 }, mulberry32(1));
  const seqB = Array.from({ length: 5 }, mulberry32(2));
  assert.notDeepEqual(seqA, seqB);
});

test('shuffle is deterministic when given a seeded rng, and defaults to Math.random when not', () => {
  const cardsA = [1, 2, 3, 4, 5, 6, 7, 8];
  const cardsB = [1, 2, 3, 4, 5, 6, 7, 8];
  shuffle(cardsA, mulberry32(7));
  shuffle(cardsB, mulberry32(7));
  assert.deepEqual(cardsA, cardsB);
});

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

test('playGame with the same seed reproduces an identical game end-to-end', () => {
  const deck = buildJakesDeck();
  const resultA = playGame(deck, deck, { seed: 12345 });
  const resultB = playGame(deck, deck, { seed: 12345 });
  assert.deepEqual(resultA, resultB);
});

test('playGame with a different seed can produce a different game', () => {
  const deck = buildJakesDeck();
  const results = Array.from({ length: 8 }, (_, i) => playGame(deck, deck, { seed: i }));
  const distinctTurns = new Set(results.map((r) => r.turns));
  assert.ok(distinctTurns.size > 1, 'expected at least some variation in game length across different seeds');
});
