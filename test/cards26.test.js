const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { triggerEvent } = require('../src/rules/effects');
const { resolveAttack } = require('../src/rules/combat');

function noBlockHooks() {
  return { chooseBlocker: () => null, chooseBurst: () => false };
}

test("Sayla's Light-Type Guncannon GD02-046 Deploy deals 2 damage to an enemy Unit token, and does nothing if the opponent has none", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  deployUnit(state, player, lookupCard('GD02-046'));
  assert.equal(opponent.battleArea.length, 0, 'no tokens to hit -- Deploy is a no-op');

  const token = deployUnit(state, opponent, { number: 'T', type: 'unit', ap: 1, hp: 3, isToken: true });
  const nonToken = deployUnit(state, opponent, { number: 'N', type: 'unit', ap: 5, hp: 5 });
  deployUnit(state, player, lookupCard('GD02-046'));
  assert.equal(token.damage, 2);
  assert.equal(nonToken.damage, 0, 'only tokens are valid targets');
});

test('Gaza C GD02-047 Activate*Main destroys itself and deals 1 damage to a Lv.5 or lower enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const gazaC = deployUnit(state, player, lookupCard('GD02-047'));
  const lowLevel = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 5, ap: 1, hp: 3 });
  const highLevel = deployUnit(state, opponent, { number: 'E2', type: 'unit', level: 6, ap: 1, hp: 3 });

  const { gazaCGD02047ActivateMain } = require('../src/effects/registry');
  gazaCGD02047ActivateMain(state, player, gazaC);

  assert.ok(!player.battleArea.includes(gazaC), 'destroyed itself');
  assert.ok(player.trash.includes(gazaC), 'went to trash');
  assert.equal(lowLevel.damage, 1, 'Lv.5 is a legal target');
  assert.equal(highLevel.damage, 0, 'Lv.6 is too high a level');
});

test('Gundam X (LR+) GD02-053: Suppression (data), and During Link grants other friendly (Vulture) Units AP+2 only during its controller\'s own turn with 7+ trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  assert.ok(lookupCard('GD02-053').keywords.suppression);

  const gundamX = deployUnit(state, player, lookupCard('GD02-053'));
  const otherVulture = deployUnit(state, player, { number: 'V', type: 'unit', traits: ['Vulture'], ap: 1, hp: 1 });
  pairPilot(state, player, gundamX, createInstance({ number: 'P', name: 'Garrod Ran', type: 'pilot' }, 0));
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(otherVulture), 1, 'linked but under 7 trash -- no bonus yet');

  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: 'X', type: 'unit' }, 0));
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(otherVulture), 3, '7+ trash on its controller\'s own turn -- AP+2');

  state.activePlayerIdx = 1;
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(otherVulture), 1, "opponent's turn now -- bonus turns off");
});

test('Gundam X GD02-056: Destroyed adds a Lv.5+ (Vulture) Unit from trash to hand, but only During Pair with a (Vulture) Pilot', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const highLevelVulture = createInstance({ number: 'V', type: 'unit', traits: ['Vulture'], level: 5 }, 0);
  player.trash.push(highLevelVulture);

  const gundamX = deployUnit(state, player, lookupCard('GD02-056'));
  gundamX.damage = 999;
  const { destroyAndFireEffect } = require('../src/rules/combat');
  destroyAndFireEffect(state, player, gundamX);
  assert.ok(!player.hand.includes(highLevelVulture), 'not paired with a (Vulture) Pilot -- no effect');

  const gundamX2 = deployUnit(state, player, lookupCard('GD02-056'));
  pairPilot(state, player, gundamX2, createInstance({ number: 'P', type: 'pilot', traits: ['Vulture'] }, 0));
  gundamX2.damage = 999;
  destroyAndFireEffect(state, player, gundamX2);
  assert.ok(player.hand.includes(highLevelVulture), 'paired with a (Vulture) Pilot -- picked up the trashed Unit');
});

test('Zedas GD02-057 During Pair Attack sacrifices another friendly Unit only to secure a kill on a Lv.4 or lower enemy Unit', () => {
  // Attacks target the player directly throughout, so the ability's own damage (to a separate
  // Unit) can be checked without the attack's own battle damage interfering.
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const zedas = deployUnit(state, player, lookupCard('GD02-057'));
  const spare = deployUnit(state, player, { number: 'S', type: 'unit', ap: 1, hp: 1 });
  const healthyLowLevel = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 4, ap: 1, hp: 5 });
  zedas.turnDeployed = -1;
  resolveAttack(state, 0, zedas, { type: 'player' }, noBlockHooks());
  assert.ok(player.battleArea.includes(spare), 'not paired -- During Pair Attack does not fire');

  pairPilot(state, player, zedas, createInstance({ number: 'P', type: 'pilot' }, 0));
  zedas.turnDeployed = -1;
  zedas.rested = false;
  resolveAttack(state, 0, zedas, { type: 'player' }, noBlockHooks());
  assert.ok(player.battleArea.includes(spare), 'target has too much HP for 2 damage to secure a kill -- no sacrifice');

  const nearDead = deployUnit(state, opponent, { number: 'E2', type: 'unit', level: 4, ap: 1, hp: 2 });
  zedas.turnDeployed = -1;
  zedas.rested = false;
  resolveAttack(state, 0, zedas, { type: 'player' }, noBlockHooks());
  assert.ok(!player.battleArea.includes(spare), 'sacrificed the spare Unit to secure the kill');
  assert.equal(nearDead.damage, 2);
  assert.equal(healthyLowLevel.damage, 0, 'the ability picked the killable target, not the healthy one');
});

test('Gundam Leopard (U+) GD02-060 Deploy rests a Lv.4 or lower enemy Unit, but only with 7+ cards in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const lowLevel = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 4, ap: 1, hp: 5 });
  deployUnit(state, player, lookupCard('GD02-060'));
  assert.equal(lowLevel.rested, false, 'under 7 trash -- Deploy did not fire');

  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: 'X', type: 'unit' }, 0));
  deployUnit(state, player, lookupCard('GD02-060'));
  assert.ok(lowLevel.rested, '7+ trash now -- rested the low-level enemy');
});

test("Hyakuri GD02-061 When Paired: Purple Pilot rests a 3-AP-or-less enemy Unit, but only with 3+ (Teiwaz)/(Tekkadan) cards in trash", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const lowAP = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 3 });
  const hyakuri = deployUnit(state, player, lookupCard('GD02-061'));
  pairPilot(state, player, hyakuri, createInstance({ number: 'P', type: 'pilot', color: 'purple' }, 0));
  assert.equal(lowAP.rested, false, 'under 3 (Teiwaz)/(Tekkadan) trash -- no effect yet');

  for (let i = 0; i < 3; i++) player.trash.push(createInstance({ number: 'X', type: 'unit', traits: ['Teiwaz'] }, 0));
  const hyakuri2 = deployUnit(state, player, lookupCard('GD02-061'));
  pairPilot(state, player, hyakuri2, createInstance({ number: 'P2', type: 'pilot', color: 'purple' }, 0));
  assert.ok(lowAP.rested, '3+ (Teiwaz) trash now -- rested the low-AP enemy');
});
