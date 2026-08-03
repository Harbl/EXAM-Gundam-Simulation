// Verifies runBatch's new options param (added alongside the skill-slider feature) actually reaches
// playGame for every game in the batch, not just accepted and dropped. Same file-scoped monkeypatch-
// before-require approach as test/skill_engine.test.js, for the same reason (singleGame.js's engine
// functions are destructured at require time, so the patch must land first).
const test = require('node:test');
const assert = require('node:assert/strict');

const heuristic = require('../src/ai/heuristic');

let lookaheadCalls = 0;
const origRunMainPhase = heuristic.runMainPhase;
heuristic.runMainPhase = function (...args) {
  lookaheadCalls++;
  return origRunMainPhase.apply(this, args);
};

const { runBatch } = require('../src/sim/batch');
const { parseDecklistText } = require('../src/deck/parser');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { validateDeck } = require('../src/deck/validator');
const banlist = require('../data/banlist.json');

const DECKLIST = `
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

function buildDeck() {
  const parsed = parseDecklistText(DECKLIST);
  const validation = validateDeck(parsed, lookupCard, banlist);
  assert.equal(validation.valid, true, validation.errors.join('; '));
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

test('runBatch threads its options param through to every game', async () => {
  const deck = buildDeck();
  lookaheadCalls = 0;
  await runBatch(deck, deck, 3, null, { engineA: 'lookahead', engineB: 'lookahead' });
  assert.ok(lookaheadCalls >= 3, 'the lookahead engine ran for both sides across all 3 games');
});

test('runBatch defaults to no options (MCTS both sides) when none are given, unchanged from before', async () => {
  const deck = buildDeck();
  lookaheadCalls = 0;
  await runBatch(deck, deck, 3, null);
  assert.equal(lookaheadCalls, 0);
});
