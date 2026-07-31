const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck, resolveResourceDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { decideMulligan, runMainPhase } = require('../src/ai/heuristic');
const { createPlayer, createInstance } = require('../src/rules/state');
const { createGame } = require('../src/rules/state');
const { playGame } = require('../src/sim/singleGame');
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
  assert.equal(validation.valid, true, validation.errors.join('; '));
  const resourceEntries = resolveResourceDeck(parsed.resource, validation.colors);
  return buildGameDeck({ main: parsed.main, resource: resourceEntries }, lookupCard);
}

test('decideMulligan keeps a hand with an early play and mulligans one without', () => {
  const cheap = { def: { type: 'unit', cost: 1 } };
  const expensive = { def: { type: 'unit', cost: 5 } };
  assert.equal(decideMulligan([cheap, expensive]), false);
  assert.equal(decideMulligan([expensive, expensive]), true);
});

test('runMainPhase deploys the highest-cost affordable Unit from hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.activePlayerIdx = 0;
  for (let i = 0; i < 3; i++) {
    const r = createInstance({ number: 'R', type: 'resource', color: 'blue' }, 0);
    player.resourceArea.push(r);
  }
  const cheap = createInstance({ number: 'A', type: 'unit', cost: 1, level: 1, color: 'blue', ap: 1, hp: 1 }, 0);
  const pricier = createInstance({ number: 'B', type: 'unit', cost: 2, level: 1, color: 'blue', ap: 2, hp: 2 }, 0);
  player.hand.push(cheap, pricier);

  runMainPhase(state, 0);

  assert.equal(player.battleArea.some((u) => u.def.number === 'B'), true, 'affordable higher-cost Unit gets deployed first');
});

test("Jake's corrected deck mirrored against itself plays out sane, crash-free games", () => {
  const deck = buildJakesDeck();
  const games = 20;
  let winsA = 0;
  let winsB = 0;

  for (let i = 0; i < games; i++) {
    const result = playGame(deck, deck);
    assert.ok(result.turns > 0 && result.turns <= 61, `implausible game length: ${result.turns}`);
    if (result.winner === 0) winsA++;
    else if (result.winner === 1) winsB++;
  }

  assert.ok(winsA + winsB > 0, 'at least some games should resolve with a winner rather than timing out');
  assert.ok(winsA > 0 && winsB > 0, 'a mirror match should not be lopsided to one side across 20 games');
});
