const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, playCommand } = require('../src/rules/actions');
const { dealDamage, getRemainingHP, getKeywords } = require('../src/rules/management');
const { runStartPhase } = require('../src/rules/phases');

test('Widespread Annihilation destroys every Lv.4-or-lower Unit on either side of the field, leaving higher-Lv Units untouched', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  const smallFriendly = deployUnit(state, player, { number: 'SF', type: 'unit', level: 3, ap: 1, hp: 1 });
  const bigFriendly = deployUnit(state, player, { number: 'BF', type: 'unit', level: 6, ap: 1, hp: 1 });
  const smallEnemy = createInstance({ number: 'SE', type: 'unit', level: 4, ap: 1, hp: 1 }, 1);
  const bigEnemy = createInstance({ number: 'BE', type: 'unit', level: 5, ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(smallEnemy, bigEnemy);

  playCommand(state, player, lookupCard('GD05-114'));

  assert.equal(player.battleArea.includes(smallFriendly), false);
  assert.equal(player.battleArea.includes(bigFriendly), true, 'Lv.6 is above the Lv.4 threshold, so it survives');
  assert.equal(opponent.battleArea.includes(smallEnemy), false);
  assert.equal(opponent.battleArea.includes(bigEnemy), true);
});

test("Silver Bullet's Deploy grants a permanent effect-damage reduction that does not touch battle damage", () => {
  const player = createPlayer(0);
  const silverBullet = deployUnit(createGame(player, createPlayer(1)), player, lookupCard('GD04-068'));

  dealDamage(silverBullet, 2, { isBattleDamage: true });
  assert.equal(getRemainingHP(silverBullet), 2, 'battle damage is untouched by effectDamageReduction (4 HP - 2)');

  dealDamage(silverBullet, 2); // no isBattleDamage flag -- an effect, e.g. a Command dealing damage
  assert.equal(getRemainingHP(silverBullet), 2, '2 effect damage was fully absorbed by the Reduce-3 buff');
});

test('Freedom Gundam only gains Suppression while a friendly Base is in play, re-checked at the start of every turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const freedom = deployUnit(state, player, lookupCard('ST09-004'));

  runStartPhase(state);
  assert.equal(!!getKeywords(freedom).suppression, false, 'no Base in play yet');

  player.base = createInstance({ number: 'B', type: 'base', ap: 0, hp: 5 }, 0);
  runStartPhase(state);
  assert.equal(getKeywords(freedom).suppression, true, 'a friendly Base is now in play');

  player.base = null;
  runStartPhase(state);
  assert.equal(!!getKeywords(freedom).suppression, false, 'the Base is gone again');
});

test('Striker Pack deploys the Aile Strike Gundam token via Burst, but only if no (Earth Alliance) Unit token is already in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const strikerPack = createInstance(lookupCard('ST04-012'), 0);

  strikerPack.def.effects.burst(state, player, strikerPack);
  assert.equal(player.battleArea.length, 1);
  assert.equal(player.battleArea[0].def.number, 'TOKEN-AILE-STRIKE');

  const second = createInstance(lookupCard('ST04-012'), 0);
  second.def.effects.burst(state, player, second);
  assert.equal(player.battleArea.length, 1, 'a second copy does nothing while an (Earth Alliance) token is already in play');
});
