const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { canAfford } = require('../src/rules/cost');
const { chooseBlocker, chooseAttackTarget } = require('../src/ai/heuristic');
const registry = require('../src/effects/registry');

test('Xi Gundam (LR) ST08-001: handLevelAndCostReductionPerEnemyUnit scales with enemy Unit count, gated on no Lv.6+ friendly Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const def = { level: 9, cost: 8, handLevelAndCostReductionPerEnemyUnit: { gateNoUnitLevelAtLeast: 6 } };
  for (let i = 0; i < 8; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));

  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });
  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });
  assert.equal(canAfford(player, def, { state }), true, 'Lv.9-2=7 <= 8 resources, cost 8-2=6 <= active');

  deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 5, level: 6 });
  assert.equal(canAfford(player, def, { state }), false, 'a Lv.6+ friendly Unit turns off the reduction entirely');
});

test('Xi Gundam (LR) ST08-001: whenPaired deals 3 damage to the highest-Lv. enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const low = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5, level: 2 });
  const high = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5, level: 7 });
  registry.xiGundamST08001WhenPaired(state, player);
  assert.equal(high.damage, 3);
  assert.equal(low.damage, 0);
});

test('Xi Gundam (ST08-002): Deploy deals 1 damage to an enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  registry.xiGundamST08002Deploy(state, player, null, {});
  assert.equal(target.damage, 1);
});

test('Messer Type-F01 ST08-004: Attack deals 1 damage to an enemy Unit only when attacking an enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  registry.messerTypeF01Attack(state, player, null, { target: { type: 'player' } });
  assert.equal(target.damage, 0, 'attacking the player: no trigger');

  registry.messerTypeF01Attack(state, player, null, { target: { type: 'unit', instance: target } });
  assert.equal(target.damage, 1);
});

test("Penelope (LR) ST08-006: During Pair, Once per Turn, attacking the player recycles a friendly (Earth Federation) Unit card from hand for 2 draws", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  const efCard = createInstance({ number: 'H1', type: 'unit', traits: ['Earth Federation'] }, 0);
  player.hand.push(efCard);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 5 });

  registry.penelopeLRAttack(state, player, instance, { target: { type: 'player' } });
  assert.equal(player.hand.includes(efCard), true, 'not paired: no trigger');

  instance.pilot = createInstance({ number: 'P1', type: 'pilot', apBonus: 0, hpBonus: 0 }, 0);
  registry.penelopeLRAttack(state, player, instance, { target: { type: 'unit', instance: {} } });
  assert.equal(player.hand.includes(efCard), true, 'attacking a Unit, not the player: no trigger');

  registry.penelopeLRAttack(state, player, instance, { target: { type: 'player' } });
  assert.equal(player.hand.includes(efCard), false);
  assert.equal(player.deck.includes(efCard), true);
  assert.equal(player.hand.length, 2, 'drew 2');

  const efCard2 = createInstance({ number: 'H2', type: 'unit', traits: ['Earth Federation'] }, 0);
  player.hand.push(efCard2);
  registry.penelopeLRAttack(state, player, instance, { target: { type: 'player' } });
  assert.equal(player.hand.includes(efCard2), true, 'Once per Turn: no second activation');
});

test('Gustav Karl Type-00 ST08-008: gains Blocker only while the attacking side has 3+ Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const blocker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 4, blockerWhileEnemyUnitCountAtLeast: 3 });
  const attacker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });

  assert.equal(chooseBlocker(player, attacker, { type: 'player' }, opponent), null, 'only 1 enemy Unit in play');

  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });
  deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 1 });
  const result = chooseBlocker(player, attacker, { type: 'player' }, opponent);
  assert.equal(result, blocker);
});

test('Jegan Ground Type-A (Man Hunter) ST08-009: Deploy sets skipNextUntap on a rested Lv.2-or-lower enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 2 });
  target.rested = true;
  const tooHigh = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 3 });
  tooHigh.rested = true;
  registry.jeganGroundTypeAManHunterDeploy(state, player, null, {});
  assert.equal(target.skipNextUntap, true);
  assert.equal(tooHigh.skipNextUntap, undefined);
});

test('Hathaway Noa ST08-010: whenPaired grants a (Mafty) Unit activeTargetIfDamaged only if the pairing Unit is (Mafty)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const maftyTarget = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3, traits: ['Mafty'] });
  const nonMaftyPairing = { def: { traits: [] } };

  registry.hathawayNoaWhenPaired(state, player, nonMaftyPairing, {});
  assert.equal(maftyTarget.buffs.some((b) => b.activeTargetIfDamaged), false);

  const maftyPairing = { def: { traits: ['Mafty'] } };
  registry.hathawayNoaWhenPaired(state, player, maftyPairing, {});
  assert.equal(maftyTarget.buffs.some((b) => b.activeTargetIfDamaged), true);
});

test('Lane Aim ST08-011: drawing via an effect grants a blue Unit High Maneuver for the turn, not a phase draw', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  const blueUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, color: 'blue' });
  blueUnit.pilot = createInstance({ number: 'P1', type: 'pilot', apBonus: 0, hpBonus: 0 }, 0);
  blueUnit.pilot.def.effects = { drawnByEffect: registry.laneAimDrawnByEffect };

  const { drawCard, runDrawPhase } = require('../src/rules/phases');
  runDrawPhase(state);
  assert.equal(blueUnit.buffs.some((b) => b.keyword === 'highManeuver'), false, 'phase draw: no trigger');

  drawCard(state, player);
  assert.equal(blueUnit.buffs.some((b) => b.keyword === 'highManeuver'), true);
});

test('Words for Hathaway ST08-012: Command grants a friendly Link Unit Breach 1 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const linkUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  linkUnit.isLinkUnit = true;
  registry.wordsForHathawayCommand(state, player, null, {});
  assert.equal(linkUnit.buffs.some((b) => b.breach === 1), true);
});

test('Lady Luck ST08-013: Command deals 1 damage, or 2 with a friendly (Mafty) Link Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  registry.ladyLuckCommand(state, player, null, {});
  assert.equal(target.damage, 1);

  const maftyLink = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, traits: ['Mafty'] });
  maftyLink.isLinkUnit = true;
  registry.ladyLuckCommand(state, player, null, {});
  assert.equal(target.damage, 3);
});

test('Valiant ST08-014: Deploy adds a shield to hand and gives a friendly Unit AP+2 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  registry.valiantDeploy(state, player, null, {});
  assert.equal(player.hand.length, 1);
  assert.equal(target.buffs.some((b) => b.ap === 2), true);
});

test('Davao ST08-015: Activate Main, Once per Turn, pays 2 to heal a friendly Unit 2', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = { activationsUsed: {} };
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 5 });
  target.damage = 3;
  for (let i = 0; i < 2; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));

  const result = registry.davaoActivateMain(state, player, instance, {});
  assert.equal(result, true);
  assert.equal(target.damage, 1);
  assert.equal(player.resourceArea.filter((r) => r.rested).length, 2);

  registry.davaoActivateMain(state, player, instance, {});
  assert.equal(target.damage, 1, 'Once per Turn: no second activation');
});
