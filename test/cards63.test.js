const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { chooseAttackTarget } = require('../src/ai/heuristic');
const registry = require('../src/effects/registry');

test('Gundam Dynames (LR) ST07-005: destroysEnemy recovers 2 HP', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 4 });
  instance.damage = 3;
  registry.gundamDynamesLRDestroysEnemy(state, player, instance);
  assert.equal(instance.damage, 1);
});

test('Gundam Kyrios (ST07-007) startOfTurn: gains AP+2 for the turn only on your turn with a (CB) Pilot in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3 });
  state.activePlayerIdx = 1;
  registry.gundamKyriosST07007StartOfTurn(state, player, instance);
  assert.equal(getAP(instance), 2, "not your turn: no buff");

  state.activePlayerIdx = 0;
  registry.gundamKyriosST07007StartOfTurn(state, player, instance);
  assert.equal(getAP(instance), 2, 'your turn but no CB Pilot in play: no buff');

  const cbUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  cbUnit.pilot = createInstance({ number: 'P1', type: 'pilot', apBonus: 0, hpBonus: 0, traits: ['CB'] }, 0);
  registry.gundamKyriosST07007StartOfTurn(state, player, instance);
  assert.equal(getAP(instance), 4);
});

test('Tieria Erde ST07-010: Destroyed draws 1 only on the opponent\'s turn for a (CB) Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  const cbUnit = { def: { traits: ['CB'] } };
  const nonCbUnit = { def: { traits: [] } };

  state.activePlayerIdx = 0;
  registry.tieriaErdeST07010Destroyed(state, player, cbUnit);
  assert.equal(player.hand.length, 0, "controller's own turn: no draw");

  state.activePlayerIdx = 1;
  registry.tieriaErdeST07010Destroyed(state, player, nonCbUnit);
  assert.equal(player.hand.length, 0, 'not a CB Unit: no draw');

  registry.tieriaErdeST07010Destroyed(state, player, cbUnit);
  assert.equal(player.hand.length, 1);
});

test('Lockon Stratos (Neil) ST07-011: whenPaired lets a (CB) Unit target an active enemy at or below its own level', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3, level: 4, traits: ['CB'] });
  const activeTarget = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 4 });

  assert.equal(chooseAttackTarget(opponent, attacker, true), null, 'no grant yet');
  registry.lockonStratosNeilWhenPaired(state, player, attacker);
  const result = chooseAttackTarget(opponent, attacker, true);
  assert.equal(result.instance, activeTarget);
});

test('Allelujah Haptism ST07-012 startOfTurn: grants AP<=3 battle immunity for the turn only on your turn with a (CB) Link Unit in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  state.activePlayerIdx = 0;
  registry.allelujahHaptismStartOfTurn(state, player, instance);
  assert.equal(instance.buffs.some((b) => b.lowAPEnemyDamageImmuneCap === 3), false, 'no CB Link Unit yet');

  const linkUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['CB'] });
  linkUnit.isLinkUnit = true;
  registry.allelujahHaptismStartOfTurn(state, player, instance);
  assert.equal(instance.buffs.some((b) => b.lowAPEnemyDamageImmuneCap === 3), true);
});

test('Armed Intervention ST07-013: Burst draws 1; Command redirects the battle target to a rested friendly (CB) Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  registry.armedInterventionBurst(state, player);
  assert.equal(player.hand.length, 1);

  const redirect = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['CB'] });
  redirect.rested = true;
  const battleTarget = { type: 'player' };
  registry.armedInterventionCommand(state, player, null, { battleTarget });
  assert.equal(battleTarget.type, 'unit');
  assert.equal(battleTarget.instance, redirect);
});

test('Tactical Visionary ST07-014: Main looks at top 3, takes a matching (CB) Unit/Pilot card, sends the rest to the bottom', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const nonMatch1 = createInstance({ number: 'D1', type: 'unit', traits: [] }, 0);
  const match = createInstance({ number: 'D2', type: 'pilot', traits: ['CB'] }, 0);
  const nonMatch2 = createInstance({ number: 'D3', type: 'unit', traits: [] }, 0);
  player.deck.push(nonMatch1, match, nonMatch2);

  registry.tacticalVisionaryCommand(state, player);
  assert.equal(player.hand.includes(match), true);
  assert.equal(player.deck.length, 2);
  assert.equal(player.deck.includes(nonMatch1) && player.deck.includes(nonMatch2), true);
});
