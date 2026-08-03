const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { canAfford, effectiveCost } = require('../src/rules/cost');
const registry = require('../src/effects/registry');

test('Kayra\'s Jegan GD05-028: Deploy grants a chosen (Londo Bell) Unit activeTargetAPThreshold 4 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const nonMatching = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 9, hp: 1 });
  const londoBell = deployUnit(state, player, { number: 'F2', type: 'unit', ap: 6, hp: 1, traits: ['Londo Bell'] });
  const instance = deployUnit(state, player, { number: 'GD05-028', type: 'unit', ap: 2, hp: 3, traits: ['Londo Bell'] });

  registry.kayrasJeganDeploy(state, player, instance, {});
  assert.ok(londoBell.buffs.some((b) => b.activeTargetAPThreshold === 4 && b.scope === 'turn'), 'the higher-AP Londo Bell Unit was chosen by default');
  assert.equal(nonMatching.buffs.length, 0, 'non-matching Unit never a candidate');
});

test('Gaia Gundam (LR+) GD05-034: During Pair, Once per Turn, enemy discards their cheapest card when this Unit destroys a shield with battle damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'GD05-034', type: 'unit', ap: 3, hp: 3 });
  pairPilot(state, player, instance, createInstance({ number: 'P1', type: 'pilot' }, 0));
  const cheap = createInstance({ number: 'C1', type: 'unit', cost: 1 }, 1);
  const expensive = createInstance({ number: 'C2', type: 'unit', cost: 5 }, 1);
  opponent.hand.push(expensive, cheap);

  registry.gaiaGundamLRPlusDestroysShield(state, player, instance, {});
  assert.equal(opponent.hand.includes(cheap), false, 'the cheapest card was discarded');
  assert.equal(opponent.trash.includes(cheap), true);
  assert.equal(player.enemyDiscardedByEffectThisTurn, true);

  opponent.hand.push(createInstance({ number: 'C3', type: 'unit', cost: 1 }, 1));
  registry.gaiaGundamLRPlusDestroysShield(state, player, instance, {});
  assert.equal(opponent.hand.length, 2, 'Once per Turn -- no second discard this turn');
});

test('Gaia Gundam (LR+) GD05-034: not During Pair -- no effect', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'GD05-034', type: 'unit', ap: 3, hp: 3 });
  const card = createInstance({ number: 'C1', type: 'unit', cost: 1 }, 1);
  opponent.hand.push(card);

  registry.gaiaGundamLRPlusDestroysShield(state, player, instance, {});
  assert.equal(opponent.hand.includes(card), true, 'no paired Pilot -- During Pair gate blocks it');
});

test('Gaia Gundam (LR+) GD05-034: enemy has no cards to discard -- controller may deploy a Lv.4-or-lower (Phantom Pain) Unit from hand instead', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'GD05-034', type: 'unit', ap: 3, hp: 3 });
  pairPilot(state, player, instance, createInstance({ number: 'P1', type: 'pilot' }, 0));
  const tooHighLevel = createInstance({ number: 'U1', type: 'unit', level: 5, traits: ['Phantom Pain'] }, 0);
  const wrongTrait = createInstance({ number: 'U2', type: 'unit', level: 3, ap: 1, hp: 1 }, 0);
  const eligible = createInstance({ number: 'U3', type: 'unit', level: 4, ap: 2, hp: 2, traits: ['Phantom Pain'] }, 0);
  player.hand.push(tooHighLevel, wrongTrait, eligible);

  registry.gaiaGundamLRPlusDestroysShield(state, player, instance, {});
  assert.ok(player.battleArea.some((u) => u.def.number === 'U3'), 'the eligible Unit was deployed for free');
  assert.equal(player.hand.includes(eligible), false);
  assert.equal(player.hand.includes(tooHighLevel), true, 'Lv.5 is too high to qualify');
});

test('Destroy Gundam (R+) GD05-037: hand Lv/cost -3 while the enemy has 7+ cards in trash; During Link gains Breach 3', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const def = { number: 'GD05-037', type: 'unit', level: 9, cost: 8, enemyTrashLevelAndCostReduction: { count: 7, amount: 3 } };
  assert.equal(effectiveCost(player, def, { state }), 8, 'enemy trash below threshold -- unreduced');
  for (let i = 0; i < 7; i++) opponent.trash.push(createInstance({ number: `T${i}`, type: 'unit' }, 1));
  assert.equal(effectiveCost(player, def, { state }), 5, 'enemy trash at threshold -- cost reduced by 3');

  const { getKeywords } = require('../src/rules/management');
  const unit = deployUnit(state, player, { number: 'GD05-037', type: 'unit', ap: 6, hp: 6, duringLinkKeywords: { breach: 3 } });
  assert.equal(getKeywords(unit).breach, undefined, 'not linked -- no Breach yet');
  unit.isLinkUnit = true;
  assert.equal(getKeywords(unit).breach, 3);
});

test('Chaos Gundam GD05-039: Attack grants a chosen (Phantom Pain) Linked Unit High-Maneuver during this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const notLinked = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 5, hp: 1, traits: ['Phantom Pain'] });
  const linked = deployUnit(state, player, { number: 'F2', type: 'unit', ap: 2, hp: 1, traits: ['Phantom Pain'] });
  linked.isLinkUnit = true;
  const instance = deployUnit(state, player, { number: 'GD05-039', type: 'unit', ap: 4, hp: 2 });

  registry.chaosGundamAttack(state, player, instance);
  assert.ok(linked.buffs.some((b) => b.keyword === 'highManeuver' && b.scope === 'turn'));
  assert.equal(notLinked.buffs.length, 0, 'not a Link Unit -- not a candidate');
});

test('Gaia Gundam (MA Mode) (U+) GD05-041: hand cost -2 during a turn the enemy discarded due to one of your effects', () => {
  const player = createPlayer(0);
  const def = { number: 'GD05-041', type: 'unit', cost: 3, costReductionIfEnemyDiscardedByEffect: 2 };
  assert.equal(effectiveCost(player, def), 3, 'no discard flag yet');
  player.enemyDiscardedByEffectThisTurn = true;
  assert.equal(effectiveCost(player, def), 1);
});

test('Gundam Rose GD05-044: During Link, Attack activates the paired Pilot\'s own Activate-Main ability', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'GD05-044', type: 'unit', ap: 3, hp: 3 });
  let fired = false;
  pairPilot(state, player, unit, createInstance({ number: 'P1', type: 'pilot', effects: { activateMain: () => { fired = true; } } }, 0));

  registry.gundamRoseAttack(state, player, unit);
  assert.equal(fired, false, 'not a Link Unit yet -- no-op');
  unit.isLinkUnit = true;
  registry.gundamRoseAttack(state, player, unit);
  assert.equal(fired, true);
});

test('Abyss Gundam (MA Mode) GD05-046: When Paired with a (Phantom Pain) Pilot, enemy discards 1 if they have 4+ cards in hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const abyssMAModeDef = { number: 'GD05-046', type: 'unit', ap: 3, hp: 3, effects: { whenPaired: registry.abyssGundamMAModeWhenPaired } };
  const unit = deployUnit(state, player, abyssMAModeDef);
  for (let i = 0; i < 3; i++) opponent.hand.push(createInstance({ number: `H${i}`, type: 'unit', cost: 5 - i }, 1));
  const cheapest = createInstance({ number: 'H3', type: 'unit', cost: 0 }, 1);
  opponent.hand.push(cheapest);

  pairPilot(state, player, unit, createInstance({ number: 'P1', type: 'pilot', traits: ['Newtype'] }, 0));
  assert.equal(opponent.hand.length, 4, 'wrong Pilot trait -- no discard');

  const unit2 = deployUnit(state, player, abyssMAModeDef);
  pairPilot(state, player, unit2, createInstance({ number: 'P2', type: 'pilot', traits: ['Phantom Pain'] }, 0));
  assert.equal(opponent.hand.length, 3, '(Phantom Pain) Pilot paired with 4+ enemy cards in hand -- 1 discarded');
  assert.equal(opponent.hand.includes(cheapest), false, 'cheapest card discarded');
});

test('Abyss Gundam (MA Mode) GD05-046: enemy below 4 cards in hand -- no discard', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'GD05-046', type: 'unit', ap: 3, hp: 3, effects: { whenPaired: registry.abyssGundamMAModeWhenPaired } });
  opponent.hand.push(createInstance({ number: 'H1', type: 'unit' }, 1));

  pairPilot(state, player, unit, createInstance({ number: 'P1', type: 'pilot', traits: ['Phantom Pain'] }, 0));
  assert.equal(opponent.hand.length, 1);
});
