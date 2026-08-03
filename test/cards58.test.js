const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const registry = require('../src/effects/registry');

test('Gundam Heavyarms ST02-003: During Pair, on your-turn battle-damage kill, deals 1 to all Lv.3-or-lower enemies', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 4 });
  const low = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3, level: 3 });
  const high = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3, level: 4 });
  state.activePlayerIdx = 0;

  registry.gundamHeavyarmsST02003DestroysEnemy(state, player, instance);
  assert.equal(low.damage, 0, 'not paired: no trigger');

  instance.pilot = {};
  registry.gundamHeavyarmsST02003DestroysEnemy(state, player, instance);
  assert.equal(low.damage, 1);
  assert.equal(high.damage, 0, 'Lv.4 is out of range');
});

test('Tallgeese ST02-006: Activate Main, Once per Turn, pays 4 to set itself active', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 4 });
  instance.rested = true;
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));

  assert.equal(registry.tallgeeseST02006ActivateMain(state, player, instance), false, 'only 3 active resources');
  player.resourceArea.push(createInstance({ number: 'R3', type: 'resource' }, 0));
  assert.equal(registry.tallgeeseST02006ActivateMain(state, player, instance), true);
  assert.equal(instance.rested, false);
  assert.equal(player.resourceArea.filter((r) => r.rested).length, 4);
});

test('Zechs Merquise ST02-011: During Link, draws 1 on a your-turn battle-damage kill', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 5 });
  state.activePlayerIdx = 0;

  registry.zechsMerquiseDestroysEnemy(state, player, unit);
  assert.equal(player.hand.length, 0, 'not a Link Unit: no draw');

  unit.isLinkUnit = true;
  registry.zechsMerquiseDestroysEnemy(state, player, unit);
  assert.equal(player.hand.length, 1);
});

test('Simultaneous Fire ST02-012: Command grants a friendly Unit Breach 3 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  registry.simultaneousFireCommand(state, player, null, {});
  assert.equal(unit.buffs.some((b) => b.breach === 3), true);
});

test('Peaceful Timbre ST02-013: Command sets shieldDamageImmuneLevelCap to 4', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  registry.peacefulTimbreCommand(state, player);
  assert.equal(player.shieldDamageImmuneLevelCap, 4);
});

test('Siege Ploy ST02-014: Burst aliases Main, resting a 5-or-less-HP enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  const outOfRange = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 6 });
  registry.siegePloyBurst(state, player, null, {});
  assert.equal(target.rested, true);
  assert.equal(outOfRange.rested, false);
});

test('Saint Gabriel Institute ST02-015: Deploy adds a shield to hand, keeps a Unit/Base on top, sends the other to the bottom', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));
  const command = createInstance({ number: 'D1', type: 'command' }, 0);
  const unitCard = createInstance({ number: 'D2', type: 'unit' }, 0);
  player.deck.push(command, unitCard);

  registry.saintGabrielInstituteDeploy(state, player);
  assert.equal(player.hand.length, 1, 'shield added to hand');
  assert.equal(player.deck[0], unitCard, 'Unit kept on top');
  assert.equal(player.deck[player.deck.length - 1], command, 'Command sent to the bottom');
});
