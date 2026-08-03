// Verifies playGame's new per-side engine option (options.engineA/engineB, the plumbing behind the
// skill-slider feature, src/ai/skillPresets.js) actually drives which AI function runs each side --
// not just that the option is accepted without crashing. Patches heuristic.js/mcts.js's exports
// BEFORE requiring singleGame.js, since singleGame.js destructures runMainPhase/runMainPhaseMCTS at
// its own top-level require time (module-cached, so patching after the fact would miss it) -- same
// precedent as scratchpad/trace_game.js. Node's test runner isolates each file in its own process by
// default, so this file-scoped monkeypatch is safe and doesn't leak into other test files.
const test = require('node:test');
const assert = require('node:assert/strict');

const heuristic = require('../src/ai/heuristic');
const mcts = require('../src/ai/mcts');

let lookaheadCalls = 0;
let mctsCalls = 0;
const origRunMainPhase = heuristic.runMainPhase;
heuristic.runMainPhase = function (...args) {
  lookaheadCalls++;
  return origRunMainPhase.apply(this, args);
};
const origRunMainPhaseMCTS = mcts.runMainPhaseMCTS;
mcts.runMainPhaseMCTS = function (...args) {
  mctsCalls++;
  return origRunMainPhaseMCTS.apply(this, args);
};

const { playGame } = require('../src/sim/singleGame');
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

test('playGame defaults both sides to MCTS when no engine option is given', () => {
  const deck = buildDeck();
  lookaheadCalls = 0;
  mctsCalls = 0;
  playGame(deck, deck);
  assert.equal(lookaheadCalls, 0, 'no lookahead calls with no engine override');
  assert.ok(mctsCalls > 0, 'MCTS ran for both sides by default');
});

test('playGame routes a side to the old lookahead AI when engineA/engineB is set to "lookahead"', () => {
  const deck = buildDeck();
  lookaheadCalls = 0;
  mctsCalls = 0;
  playGame(deck, deck, { engineA: 'lookahead' });
  assert.ok(lookaheadCalls > 0, 'Deck A ran on the lookahead engine');
  assert.ok(mctsCalls > 0, 'Deck B still ran on MCTS (default)');

  lookaheadCalls = 0;
  mctsCalls = 0;
  playGame(deck, deck, { engineA: 'lookahead', engineB: 'lookahead' });
  assert.ok(lookaheadCalls > 0);
  assert.equal(mctsCalls, 0, 'neither side touched MCTS when both are set to lookahead');
});
