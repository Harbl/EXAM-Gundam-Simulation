const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { dealDamage } = require('../src/rules/management');
const registry = require('../src/effects/registry');

test('Kudelia Aina Bernstein & Isaribi EB01-085: Deploy adds a shield to hand and may rest a friendly blue (G Generation) Unit + 1 enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));
  const friendly = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, color: 'blue', traits: ['G Generation'] });
  const nonBlue = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 3, hp: 3, color: 'green', traits: ['G Generation'] });
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });

  registry.kudeliaAinaBernsteinIsaribiDeploy(state, player);
  assert.equal(player.hand.length, 1, 'shield added to hand');
  assert.equal(friendly.rested, true);
  assert.equal(nonBlue.rested, false, 'non-blue not eligible');
  assert.equal(enemy.rested, true);
});

test('Kycilia Zabi & Gwazine EB01-086: allyPaired grants Repair 2 for the turn when a friendly (G Generation) Unit links, Once per Turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const base = { def: registry, activationsUsed: {} };
  const instance = { activationsUsed: {} };
  const linked = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['G Generation'] });
  linked.isLinkUnit = true;

  registry.kyciliaZabiGwazineAllyPaired(state, player, instance, { pairedUnit: linked });
  assert.equal(linked.buffs.some((b) => b.repair === 2), true);

  const secondLink = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['G Generation'] });
  secondLink.isLinkUnit = true;
  registry.kyciliaZabiGwazineAllyPaired(state, player, instance, { pairedUnit: secondLink });
  assert.equal(secondLink.buffs.some((b) => b.repair === 2), false, 'Once per Turn: no second grant');
});

test('Marina Ismail & Ptolemaios 2 EB01-087: friendlyUnitDestroysEnemy heals a friendly Unit 2, gated on a green (G Generation) attacker, Once per Turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = { activationsUsed: {} };
  const damaged = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 5 });
  dealDamage(damaged, 3);
  const nonGreenAttacker = { def: { color: 'blue', traits: ['G Generation'] } };
  registry.marinaIsmailPtolemaios2FriendlyUnitDestroysEnemy(state, player, instance, { attacker: nonGreenAttacker });
  assert.equal(damaged.damage, 3, 'non-green attacker: no heal');

  const greenAttacker = { def: { color: 'green', traits: ['G Generation'] } };
  registry.marinaIsmailPtolemaios2FriendlyUnitDestroysEnemy(state, player, instance, { attacker: greenAttacker });
  assert.equal(damaged.damage, 1);
});

test('Miorine Rembran & Academy Ship EB01-088: startOfTurn grants AP+1 to friendly (G Generation) Lv.3 Units only during the opponent\'s turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = {};
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['G Generation'], level: 3 });

  state.activePlayerIdx = 0;
  registry.miorineRembranAcademyShipStartOfTurn(state, player, instance);
  assert.equal(target.buffs.length, 0, "controller's own turn: no grant");

  state.activePlayerIdx = 1;
  registry.miorineRembranAcademyShipStartOfTurn(state, player, instance);
  assert.equal(target.buffs.some((b) => b.ap === 1), true);
});

test('Lacus Clyne & Eternal EB01-089: Deploy sets a rested friendly white (G Generation) Unit active and locks it from attacking', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3, color: 'white', traits: ['G Generation'] });
  target.rested = true;
  registry.lacusClyneEternalDeploy(state, player);
  assert.equal(target.rested, false);
  assert.equal(target.buffs.some((b) => b.cannotAttack), true);
});

test('Tiffa Adill & Freeden EB01-090: Deploy bounces a 2-or-less-HP enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 2 });
  registry.tiffaAdillFreedenDeploy(state, player);
  assert.equal(opponent.battleArea.includes(target), false);
  assert.equal(opponent.hand.includes(target), true);
});
