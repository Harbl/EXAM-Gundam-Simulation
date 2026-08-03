const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { getKeywords } = require('../src/rules/management');
const registry = require('../src/effects/registry');

test('Sinanju ST03-001: duringPairKeywords grants High Maneuver while paired; destroysShield deals 2 to an enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 4, duringPairKeywords: { highManeuver: true } });
  assert.equal(getKeywords(instance).highManeuver, undefined, 'not paired: no High Maneuver');
  instance.pilot = createInstance({ number: 'P1', type: 'pilot', apBonus: 1, hpBonus: 1 }, 0);
  assert.equal(getKeywords(instance).highManeuver, true);

  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });
  registry.sinanjuST03001DestroysShield(state, player, instance, {});
  assert.equal(target.damage, 2);
});

test('Gouf ST03-009: Deploy deploys 1 rested Zaku II token (AP1/HP1)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  registry.goufST03009Deploy(state, player);
  const token = player.battleArea.find((u) => u.def.name === 'Zaku II');
  assert.ok(token);
  assert.equal(token.rested, true);
  assert.equal(token.def.ap, 1);
  assert.equal(token.def.hp, 1);
});

test('Full Frontal ST03-010: whenPaired may deploy a Lv.4-or-lower (Neo Zeon)/(Zeon) Unit from hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const tooHigh = createInstance({ number: 'U1', type: 'unit', ap: 3, hp: 3, level: 5, traits: ['Zeon'] }, 0);
  const eligible = createInstance({ number: 'U2', type: 'unit', ap: 2, hp: 2, level: 3, traits: ['Neo Zeon'] }, 0);
  player.hand.push(tooHigh, eligible);
  registry.fullFrontalWhenPaired(state, player, null, {});
  assert.equal(player.battleArea.some((u) => u.def.number === 'U2'), true);
  assert.equal(player.hand.includes(eligible), false);
  assert.equal(player.hand.includes(tooHigh), true, 'Lv.5 is out of range: stays in hand');
});

test('Indignation ST03-012: Command gives a friendly Unit AP+2 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  registry.indignationCommand(state, player, null, {});
  assert.equal(unit.buffs.some((b) => b.ap === 2), true);
});

test("The Blue Giant ST03-014: Command grants battle immunity to enemy AP<=2 for the battle", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  registry.theBlueGiantST03014Command(state, player, null, {});
  assert.equal(unit.buffs.some((b) => b.lowAPEnemyDamageImmuneCap === 2), true);
});

test("Falmel ST03-016: Deploy adds a shield to hand and, on your turn, deploys a rested Char's Zaku II token", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));
  state.activePlayerIdx = 0;
  registry.falmelDeploy(state, player);
  assert.equal(player.hand.length, 1);
  const token = player.battleArea.find((u) => u.def.name === "Char's Zaku II");
  assert.ok(token);
  assert.equal(token.rested, true);
});
