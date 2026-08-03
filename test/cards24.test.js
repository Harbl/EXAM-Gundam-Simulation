const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');

function noBlockHooks() {
  return { chooseBlocker: () => null, chooseBurst: () => false };
}

function fillResources(player, count) {
  for (let i = 0; i < count; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, player.id));
}

test('Barzam GD02-016: Deploy buffs the highest-AP friendly (Titans) Unit by AP+1 this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const titan = deployUnit(state, player, { number: 'T', type: 'unit', traits: ['Titans'], ap: 3, hp: 3 });
  deployUnit(state, player, lookupCard('GD02-016'));

  assert.equal(getAP(titan), 4);
});

test('Taurus GD02-018 can never be chosen to attack the enemy player directly', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const taurus = deployUnit(state, player, lookupCard('GD02-018'));
  taurus.turnDeployed = -1;
  taurus.isLinkUnit = true;

  const { chooseAttackTarget } = require('../src/ai/heuristic');
  const target = chooseAttackTarget(opponent, taurus, false);
  assert.equal(target, null);
});

test('Elmeth (LR+) GD02-020: Deploy digs top 5 for a green (Zeon) Pilot and adds it to hand; During Link gets AP+2', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const pilot = createInstance({ number: 'P', type: 'pilot', color: 'green', traits: ['Zeon'], cost: 2 }, 0);
  player.deck.push(createInstance({ number: 'F1', type: 'unit' }, 0));
  player.deck.push(pilot);
  player.deck.push(createInstance({ number: 'F2', type: 'unit' }, 0));

  const elmeth = deployUnit(state, player, lookupCard('GD02-020'));
  assert.ok(player.hand.includes(pilot), 'the green (Zeon) Pilot was found and added to hand');

  pairPilot(state, player, elmeth, createInstance({ number: 'L', type: 'pilot', name: 'Lalah Sune' }, 0));
  assert.equal(getAP(elmeth), 6, '4 base + 2 During Link');
});

test('Gundam AGE-1 Normal (LR+) GD02-021: discards a green (Earth Federation) Unit to place an EX Resource, then draws if Lv.7+', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  fillResources(player, 6);

  const discardable = createInstance({ number: 'D', type: 'unit', color: 'green', traits: ['Earth Federation'], cost: 1 }, 0);
  player.hand.push(discardable);
  player.deck.push(createInstance({ number: 'DR', type: 'unit' }, 0));

  deployUnit(state, player, lookupCard('GD02-021'));

  assert.ok(!player.hand.includes(discardable), 'the Earth Federation Unit was discarded');
  assert.ok(player.trash.includes(discardable));
  assert.equal(player.resourceArea.length, 7, '6 starting + 1 placed EX Resource');
  assert.equal(player.hand.length, 1, 'now Lv.7 -- drew 1 card');
});

test('Gundam AGE-1 Normal (LR+) GD02-021 does not draw if placing the EX Resource does not reach Lv.7', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  fillResources(player, 3);

  const discardable = createInstance({ number: 'D', type: 'unit', color: 'green', traits: ['Earth Federation'], cost: 1 }, 0);
  player.hand.push(discardable);

  deployUnit(state, player, lookupCard('GD02-021'));

  assert.equal(player.resourceArea.length, 4);
  assert.equal(player.hand.length, 0, 'below Lv.7 -- no draw');
});

test('G-Exes GD02-022: Once per Turn, reacts when its controller places an EX Resource by granting Breach 2 to an (AGE System) Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  deployUnit(state, player, lookupCard('GD02-022'));
  const ageUnit = deployUnit(state, player, { number: 'A', type: 'unit', traits: ['AGE System'], ap: 2, hp: 2 });

  const discardable = createInstance({ number: 'D', type: 'unit', color: 'green', traits: ['Earth Federation'], cost: 1 }, 0);
  player.hand.push(discardable);
  deployUnit(state, player, lookupCard('GD02-021'));

  assert.equal(getKeywords(ageUnit).breach, 2);
});

test('G-Exes GD02-022 only fires once per turn even if a second EX Resource is placed', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const gExes = deployUnit(state, player, lookupCard('GD02-022'));
  const { placeExResource } = require('../src/rules/effects');
  placeExResource(state, player);
  placeExResource(state, player);

  assert.equal(gExes.activationsUsed.breachOnExResource, true);
  assert.equal(player.resourceArea.length, 2, 'both EX Resources were still placed');
});

test('Gundam AGE-1 Spallow (R+) GD02-023: still Lv.6, no First Strike -- a lethal trade mutually destroys both Units', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const spallow = deployUnit(state, player, lookupCard('GD02-023'));
  spallow.isLinkUnit = true;
  const defender = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 3 });

  fillResources(player, 6);
  resolveAttack(state, 0, spallow, { type: 'unit', instance: defender }, noBlockHooks());
  assert.ok(!player.battleArea.includes(spallow), 'no First Strike yet -- return damage destroys it too');
  assert.ok(!opponent.battleArea.includes(defender));
});

test('Gundam AGE-1 Spallow (R+) GD02-023 grants First Strike once its controller reaches Lv.7, pre-empting return damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const spallow = deployUnit(state, player, lookupCard('GD02-023'));
  spallow.isLinkUnit = true;
  const defender = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 3 });

  fillResources(player, 7);
  resolveAttack(state, 0, spallow, { type: 'unit', instance: defender }, noBlockHooks());
  assert.ok(player.battleArea.includes(spallow), 'First Strike killed the defender before it could return damage');
  assert.ok(!opponent.battleArea.includes(defender));
});

test('Red Gundam (R+) GD02-024: During Link, gains High-Maneuver', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const redGundam = deployUnit(state, player, lookupCard('GD02-024'));
  assert.ok(!getKeywords(redGundam).highManeuver, 'not linked yet');

  pairPilot(state, player, redGundam, createInstance({ number: 'P', type: 'pilot', traits: ['Clan'] }, 0));
  assert.ok(getKeywords(redGundam).highManeuver);
});

test('Genoace Custom GD02-026: Deploy buffs an (AGE System) Unit by AP+2 only while its controller is Lv.7+', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const ageUnit = deployUnit(state, player, { number: 'A', type: 'unit', traits: ['AGE System'], ap: 2, hp: 2 });
  fillResources(player, 6);
  deployUnit(state, player, lookupCard('GD02-026'));
  assert.equal(getAP(ageUnit), 2, 'below Lv.7 -- no buff');

  fillResources(player, 1);
  deployUnit(state, player, lookupCard('GD02-026'));
  assert.equal(getAP(ageUnit), 4, 'now Lv.7 -- AP+2');
});
