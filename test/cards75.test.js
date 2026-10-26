const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { runStartPhase, drawCard } = require('../src/rules/phases');
const { resolveUnitBattleDamage, applyBlockDecision, fireDealsBattleDamage, isBaseImmuneToLowLevelDamage } = require('../src/rules/combat');
const { canAfford, payCost } = require('../src/rules/cost');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// GD06 "Stardust Trails" -- Pilots (GD06-080 through GD06-100). Covers 4 new engine hooks: a
// persistent "drew with an effect this turn" flag (Kou Uraki), a Pilot-granted cost reduction for
// pairing with a specific link target (Mashymre Cello/Corin Nander), a new 'activatesBlocker'
// broadcast (Harry Ord), and a Pilot-granted Lv.-scaled Base damage immunity (Duo Maxwell), plus a
// spot-check of the rest of this slice.

test('Kou Uraki GD06-080: Activate*Action heals 2 HP, once per turn, only if the controller drew with an effect this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 5 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD06-080'), 0));
  unit.damage = 3;

  assert.equal(registry.kouUrakiGD06080ActivateAction(state, player, unit, { target: unit }), false, "hasn't drawn with an effect yet");

  player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));
  drawCard(state, player);
  assert.equal(player.drewWithEffectThisTurn, true);
  assert.equal(registry.kouUrakiGD06080ActivateAction(state, player, unit, { target: unit }), true);
  assert.equal(unit.damage, 1);
  assert.equal(registry.kouUrakiGD06080ActivateAction(state, player, unit, { target: unit }), false, 'once per turn');

  runStartPhase(state);
  assert.equal(player.drewWithEffectThisTurn, false, "cleared each start phase, until it's actually drawn by an effect again");
});

test('Mashymre Cello GD06-086: cost -1 only when paired with a Unit whose link condition is [Mashymre Cello]', () => {
  const player = createPlayer(0);
  const mashymreCello = lookupCard('GD06-086');
  assert.equal(mashymreCello.level, 3);
  assert.equal(mashymreCello.cost, 1);
  // Level (3) is met by Resource count alone, active or rested (2-9-1); 0 active Resources means
  // Cost must be fully discounted to 0 to be affordable.
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  player.resourceArea.forEach((r) => (r.rested = true));
  const matchingUnit = { number: 'M', type: 'unit', linkCondition: 'Mashymre Cello' };
  const nonMatchingUnit = { number: 'N', type: 'unit', linkCondition: 'Someone Else' };

  assert.equal(canAfford(player, mashymreCello, { pairUnit: { def: nonMatchingUnit } }), false, 'no discount -- 0 active Resources can\'t pay cost 1');
  assert.equal(canAfford(player, mashymreCello, { pairUnit: { def: matchingUnit } }), true, 'discounted to 0 against its own link target');
});

test('Harry Ord GD06-097: sets itself active once per turn when it activates Blocker', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const blocker = deployUnit(state, player, { number: 'B', type: 'unit', ap: 1, hp: 5, keywords: { blocker: true } });
  pairPilot(state, player, blocker, createInstance(lookupCard('GD06-097'), 0));
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 1, hp: 5 });

  applyBlockDecision(state, player, attacker, { type: 'player' }, blocker);
  assert.equal(blocker.rested, false, 'set active immediately after activating Blocker');
});

test('Duo Maxwell GD06-098: While rested and Linked, friendly Bases are immune to battle damage from enemies at or below its own Lv.', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.base = createInstance({ number: 'Base', type: 'base', hp: 5 }, 0);
  const duoMaxwell = deployUnit(state, player, { number: 'D', type: 'unit', level: 4, ap: 1, hp: 5, linkCondition: 'Duo Maxwell' });
  const lowLevelAttacker = { def: { level: 3 } };
  const highLevelAttacker = { def: { level: 9 } };

  assert.equal(isBaseImmuneToLowLevelDamage(player, lowLevelAttacker), false, 'not paired/Linked yet');

  pairPilot(state, player, duoMaxwell, createInstance(lookupCard('GD06-098'), 0));
  assert.equal(duoMaxwell.isLinkUnit, true);
  duoMaxwell.rested = false;
  assert.equal(isBaseImmuneToLowLevelDamage(player, lowLevelAttacker), false, 'not rested yet');

  duoMaxwell.rested = true;
  assert.equal(isBaseImmuneToLowLevelDamage(player, lowLevelAttacker), true, 'rested + Linked, attacker Lv. <= its own');
  assert.equal(isBaseImmuneToLowLevelDamage(player, highLevelAttacker), false, 'attacker Lv. too high');
});

test('Nyaan GD06-094 When Paired: grants a friendly Unit a this-turn execute vs. Lv.4-or-lower enemies', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const nyaan = deployUnit(state, player, { number: 'N', type: 'unit', ap: 0, hp: 1 });
  const attacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 10 });
  const defender = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 4, ap: 1, hp: 10 });

  registry.nyaanGD06094WhenPaired(state, player);
  fireDealsBattleDamage(state, player, opponent, attacker, defender);
  assert.equal(defender.damage, defender.def.hp, 'executed despite only 1 AP of real damage');
});

test("Anavel Gato GD06-093: reduces battle damage by 2 from an enemy whose Lv. is <= the paired Unit's own", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', level: 5, ap: 1, hp: 10 });
  const lowLevelEnemy = deployUnit(state, opponent, { number: 'L', type: 'unit', level: 3, ap: 4, hp: 10 });
  const highLevelEnemy = deployUnit(state, opponent, { number: 'H', type: 'unit', level: 9, ap: 4, hp: 10 });

  registry.anavelGatoGD06093Attack(state, player, unit, { target: { type: 'unit', instance: lowLevelEnemy } });
  resolveUnitBattleDamage(state, player, opponent, unit, lowLevelEnemy, {});
  assert.equal(unit.damage, 2, 'reduced from 4 to 2 against the lower-Lv. enemy');

  unit.damage = 0;
  unit.buffs = []; // resolveUnitBattleDamage alone (bypassing a full resolveAttack) never clears battle-scope buffs
  registry.anavelGatoGD06093Attack(state, player, unit, { target: { type: 'unit', instance: highLevelEnemy } });
  resolveUnitBattleDamage(state, player, opponent, unit, highLevelEnemy, {});
  assert.equal(unit.damage, 4, 'no reduction against the higher-Lv. enemy');
});

test('Judau Ashta GD06-088: During Link, Destroyed recovers the cheapest-cost (Gundam Team) Unit from trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, linkCondition: 'Judau Ashta' });
  pairPilot(state, player, unit, createInstance({ number: 'Judau Ashta', type: 'pilot', name: 'Judau Ashta' }, 0));
  player.trash.push(
    createInstance({ number: 'G1', type: 'unit', level: 2, cost: 2, traits: ['Gundam Team'] }, 0),
    createInstance({ number: 'G2', type: 'unit', level: 2, cost: 4, traits: ['Gundam Team'] }, 0)
  );

  registry.judauAshtaGD06088Destroyed(state, player, unit);
  assert.equal(player.hand.some((c) => c.def.number === 'G2'), true, 'picked the pricier match');
  assert.equal(player.trash.some((c) => c.def.number === 'G2'), false);
});
