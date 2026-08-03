const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const registry = require('../src/effects/registry');

test('Strike Gundam ST04-002: Deploy draws 1 then discards the highest-cost card in hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit', cost: 5 }, 0));
  player.hand.push(createInstance({ number: 'H1', type: 'unit', cost: 1 }, 0));
  registry.strikeGundamST04002Deploy(state, player);
  assert.equal(player.hand.length, 1);
  assert.equal(player.hand[0].def.number, 'H1');
  assert.equal(player.trash.some((c) => c.def.number === 'D1'), true);
});

test('Miguel\'s Ginn ST04-009: During Pair, Destroyed draws 1 only if wasPaired and another Link Unit is in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 1 });

  registry.miguelsGinnST04009Destroyed(state, player, instance, { wasPaired: false });
  assert.equal(player.hand.length, 0, 'not paired: no draw');

  registry.miguelsGinnST04009Destroyed(state, player, instance, { wasPaired: true });
  assert.equal(player.hand.length, 0, 'no other Link Unit: no draw');

  const other = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 2 });
  other.isLinkUnit = true;
  registry.miguelsGinnST04009Destroyed(state, player, instance, { wasPaired: true });
  assert.equal(player.hand.length, 1);
});

test('Hawk of Endymion ST04-013: Command bounces a 3-or-less-HP enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  registry.hawkOfEndymionCommand(state, player, null, {});
  assert.equal(opponent.battleArea.includes(target), false);
  assert.equal(opponent.hand.includes(target), true);
});

test('The Magic Bullet of Dusk ST04-014: Command grants First Strike for the turn to a Lv.2-or-lower friendly Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const eligible = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, level: 2 });
  const tooHigh = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 4, hp: 4, level: 3 });
  registry.theMagicBulletOfDuskCommand(state, player, null, {});
  assert.equal(eligible.buffs.some((b) => b.keyword === 'firstStrike'), true);
  assert.equal(tooHigh.buffs.some((b) => b.keyword === 'firstStrike'), false);
});

test('Vesalius ST04-016: Activate Main rests itself and gives a friendly Unit AP+1 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = { rested: false };
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  const result = registry.vesaliusActivateMain(state, player, instance, {});
  assert.equal(result, true);
  assert.equal(instance.rested, true);
  assert.equal(target.buffs.some((b) => b.ap === 1), true);
});
