const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const registry = require('../src/effects/registry');

test('Saviour Gundam ST09-003: whenLinked deals 2 damage to all AP<=5 Units on both sides, gated on 5+ purple trash cards', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const friendlyLow = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 3 });
  const friendlyHigh = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 6, hp: 3 });
  const enemyLow = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 3 });

  registry.saviourGundamWhenLinked(state, player);
  assert.equal(friendlyLow.damage, 0, 'fewer than 5 purple cards in trash: no trigger');

  for (let i = 0; i < 5; i++) player.trash.push(createInstance({ number: 'T' + i, type: 'unit', color: 'purple' }, 0));
  registry.saviourGundamWhenLinked(state, player);
  assert.equal(friendlyLow.damage, 2);
  assert.equal(friendlyHigh.damage, 0, 'AP 6 is out of range');
  assert.equal(enemyLow.damage, 2, 'hits both sides');
});

test('Giant Killing ST09-009: Command destroys an active enemy Unit with 4 or less AP outright', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 4, hp: 10 });
  const restedOutOfRange = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });
  restedOutOfRange.rested = true;
  const tooHighAP = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 5, hp: 1 });

  registry.giantKillingCommand(state, player, null, {});
  assert.equal(opponent.battleArea.includes(target), false);
  assert.equal(opponent.battleArea.includes(restedOutOfRange), true, 'rested: not a legal target');
  assert.equal(opponent.battleArea.includes(tooHighAP), true, 'AP 5 is out of range');
});
