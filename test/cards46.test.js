const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getRemainingHP, getAP, dealDamage } = require('../src/rules/management');
const { dealEffectDamage } = require('../src/rules/effects');
const { canAfford, effectiveCost, payCost } = require('../src/rules/cost');
const { EX_RESOURCE_DEF } = require('../src/rules/setup');
const registry = require('../src/effects/registry');

test('Akatsuki (Oowashi) GD05-004: hand Lv/cost scale down 1 per (Orb) Unit in play while no Lv.6+ friendly Unit is in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const def = { number: 'GD05-004', type: 'unit', level: 6, cost: 6, handLevelAndCostReductionPerTrait: { trait: 'Orb', gateNoUnitLevelAtLeast: 6 } };
  assert.equal(effectiveCost(player, def), 6, 'no Orb Units in play -- unreduced');
  deployUnit(state, player, { number: 'O1', type: 'unit', ap: 1, hp: 1, traits: ['Orb'] });
  deployUnit(state, player, { number: 'O2', type: 'unit', ap: 1, hp: 1, traits: ['Orb'] });
  assert.equal(effectiveCost(player, def), 4, '2 Orb Units in play -- cost reduced by 2');
  for (let i = 0; i < 4; i++) player.resourceArea.push({ rested: false, def: {} });
  assert.equal(canAfford(player, def), true, 'level effectively 4, satisfied by 4 resources');
  deployUnit(state, player, { number: 'H1', type: 'unit', ap: 1, hp: 1, level: 6 });
  assert.equal(effectiveCost(player, def), 6, 'a Lv.6+ friendly Unit in play cancels the reduction entirely');
});

test('Akatsuki (Oowashi) GD05-004: [When Linked] bounces the highest-AP enemy Unit that is Lv.4 or lower, ignores higher-level ones', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const low = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 3, level: 4 });
  const high = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 5, hp: 3, level: 5 });

  registry.akatsukiOowashiWhenLinked(state, player, {}, {});
  assert.equal(opponent.battleArea.includes(low), false, 'Lv.4 target bounced');
  assert.equal(opponent.hand.includes(low), true);
  assert.equal(opponent.battleArea.includes(high), true, 'Lv.5 target untouched');
});

test('Asshimar GD05-007: During Link gets AP+2 and Repair 1 (data-only)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'GD05-007', type: 'unit', ap: 1, hp: 4, duringLinkAp: 2, duringLinkKeywords: { repair: 1 } });
  assert.equal(getAP(unit), 1, 'not linked -- no bonus');
  unit.isLinkUnit = true;
  assert.equal(getAP(unit), 3, 'linked -- AP+2');
});

test('Dijeh GD05-008: hand cost -2 while a non-blue (Newtype) Pilot is in play, unaffected by a blue one', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const def = { number: 'GD05-008', type: 'unit', cost: 3, handCostReduction: { pilotTrait: 'Newtype', excludeColor: 'blue', count: 1, amount: 2 } };
  assert.equal(effectiveCost(player, def), 3, 'no Newtype Pilot in play');
  const blueUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, blueUnit, createInstance({ number: 'P1', type: 'pilot', color: 'blue', traits: ['Newtype'] }, 0));
  assert.equal(effectiveCost(player, def), 3, 'blue Newtype Pilot excluded');
  const redUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, redUnit, createInstance({ number: 'P2', type: 'pilot', color: 'red', traits: ['Newtype'] }, 0));
  assert.equal(effectiveCost(player, def), 1, 'non-blue Newtype Pilot -- reduced by 2');
});

test('Calamity Gundam & Raider Gundam GD05-011: Deploy rests an (Earth Alliance) Unit then deals 2 to a rested enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const helper = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 1, traits: ['Earth Alliance'] });
  const nonMatching = deployUnit(state, player, { number: 'F2', type: 'unit', ap: 5, hp: 1 });
  const restedEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  restedEnemy.rested = true;
  const instance = deployUnit(state, player, { number: 'GD05-011', type: 'unit', ap: 4, hp: 4 });

  registry.calamityRaiderGundamDeploy(state, player, instance, {});
  assert.equal(helper.rested, true, 'the (Earth Alliance) Unit was rested');
  assert.equal(nonMatching.rested, false, 'non-matching Unit never a candidate');
  assert.equal(getRemainingHP(restedEnemy), 1, 'rested enemy took 2 damage');
});

test('Calamity Gundam & Raider Gundam GD05-011: no eligible (Earth Alliance) Unit -- no damage happens', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const restedEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  restedEnemy.rested = true;
  const instance = deployUnit(state, player, { number: 'GD05-011', type: 'unit', ap: 4, hp: 4 });

  registry.calamityRaiderGundamDeploy(state, player, instance, {});
  assert.equal(getRemainingHP(restedEnemy), 3, 'nothing rested to pay the cost, so no damage');
});

test('Forbidden Gundam GD05-012: [When Linked] bounces a rested Lv.3-or-lower enemy, ignores active or higher-level ones', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const activeLow = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3, level: 2 });
  const restedHigh = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3, level: 4 });
  restedHigh.rested = true;
  const restedLow = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 2, hp: 3, level: 3 });
  restedLow.rested = true;

  registry.forbiddenGundamWhenLinked(state, player, {}, {});
  assert.equal(opponent.battleArea.includes(restedLow), false, 'rested Lv.3 target bounced');
  assert.equal(opponent.battleArea.includes(activeLow), true, 'active Unit untouched despite low level');
  assert.equal(opponent.battleArea.includes(restedHigh), true, 'rested but Lv.4 untouched');
});

test('Murasame GD05-016: gains High-Maneuver during this turn when a friendly (Orb) Unit deploys, ignores non-Orb deploys', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const murasameDef = { number: 'GD05-016', type: 'unit', ap: 2, hp: 4, traits: ['Orb'], effects: { friendlyUnitDeployed: registry.murasameFriendlyUnitDeployed } };
  const murasame = deployUnit(state, player, murasameDef);
  assert.equal(getKeywordsHighManeuver(murasame), true, 'fires off its own (Orb) deploy too');

  murasame.buffs = [];
  deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 1 });
  assert.equal(getKeywordsHighManeuver(murasame), false, 'non-Orb deploy does not grant it');

  deployUnit(state, player, { number: 'F2', type: 'unit', ap: 1, hp: 1, traits: ['Orb'] });
  assert.equal(getKeywordsHighManeuver(murasame), true, 'another friendly Orb deploy grants it');
});
function getKeywordsHighManeuver(instance) {
  return instance.buffs.some((b) => b.keyword === 'highManeuver');
}

test('Gundam Calibarn GD05-018: Deploy places 3 EX Resources; exiling one lets you buff a chosen Unit\'s damageReduction', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'GD05-018', type: 'unit', ap: 7, hp: 5 });

  registry.gundamCalibarnDeploy(state, player);
  assert.equal(player.resourceArea.length, 3);
  assert.ok(player.resourceArea.every((r) => r.def.isToken));

  const otherUnit = deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 10 });
  registry.gundamCalibarnFriendlyExResourceExiled(state, player, instance, { hooks: { chooseUnit: () => otherUnit } });
  assert.ok(otherUnit.buffs.some((b) => b.damageReduction === 3 && b.scope === 'turn'), 'hook-chosen Unit gets the buff');
});

test('Gundam Calibarn GD05-018: exiling an EX Resource via a real payCost triggers the broadcast end-to-end', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const calibarn = deployUnit(state, player, { number: 'GD05-018', type: 'unit', ap: 7, hp: 5 });
  calibarn.def.effects = { friendlyExResourceExiled: registry.gundamCalibarnFriendlyExResourceExiled };
  player.resourceArea.push(createInstance(EX_RESOURCE_DEF, player.id));

  const usedExResource = payCost(player, { cost: 1 }, { state });
  assert.equal(usedExResource, true);
  assert.ok(calibarn.buffs.some((b) => b.damageReduction === 3), 'Calibarn itself is a valid target and got buffed');
});

test('Gundam AGE-2 Double Bullet GD05-021: Activate Action pays (1), Once per Turn, for AP+4 during this battle', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'GD05-021', type: 'unit', ap: 4, hp: 5 });
  player.resourceArea.push({ rested: false, def: {} });

  assert.equal(getAP(unit), 4);
  assert.equal(registry.gundamAge2DoubleBulletActivateAction(state, player, unit), true);
  assert.equal(getAP(unit), 8);
  assert.equal(registry.gundamAge2DoubleBulletActivateAction(state, player, unit), false, 'Once per Turn -- already used');
});

test('Gundam AGE-2 Double Bullet GD05-021: Once per Turn enemy-damage reduction is conditional on an (Earth Federation) Pilot in play (data-only)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const def = { number: 'GD05-021', type: 'unit', hp: 5, oncePerTurnEnemyDamageReduction: { amount: 2, pilotTraitInPlay: 'Earth Federation' } };
  const unit = deployUnit(state, player, def);

  dealDamage(unit, 3, { isEnemyDamage: true, player });
  assert.equal(getRemainingHP(unit), 2, 'no Earth Federation Pilot in play -- full damage');

  const unit2 = deployUnit(state, player, def);
  const pilotHost = deployUnit(state, player, { number: 'H1', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, pilotHost, createInstance({ number: 'P1', type: 'pilot', traits: ['Earth Federation'] }, 0));
  dealDamage(unit2, 3, { isEnemyDamage: true, player });
  assert.equal(getRemainingHP(unit2), 4, 'Earth Federation Pilot in play -- reduced by 2');
});

test('Gundam Schwarzette GD05-022: <Breach 3> (data), Activate Action exiles 2 Commands from trash for a battle-scoped damageReduction 2', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'GD05-022', type: 'unit', ap: 5, hp: 4, keywords: { breach: 3 } });
  const { getKeywords } = require('../src/rules/management');
  assert.equal(getKeywords(unit).breach, 3);

  assert.equal(registry.gundamSchwarzetteActivateAction(state, player, unit), false, 'not enough Commands in trash yet');
  player.trash.push(
    createInstance({ number: 'C1', type: 'command' }, 0),
    createInstance({ number: 'C2', type: 'command' }, 0)
  );
  assert.equal(registry.gundamSchwarzetteActivateAction(state, player, unit), true);
  assert.equal(player.trash.length, 0);
  assert.equal(player.removal.length, 2);
  assert.ok(unit.buffs.some((b) => b.damageReduction === 2 && b.scope === 'battle'));
  assert.equal(registry.gundamSchwarzetteActivateAction(state, player, unit), false, 'no more Commands left to exile');
});

test('Re-GZ BWS GD05-023: Deploy places 1 EX Resource', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  registry.reGZBWSDeploy(state, player);
  assert.equal(player.resourceArea.length, 1);
  assert.ok(player.resourceArea[0].def.isToken);
});

test('Demi Barding GD05-025: Deploy reveals a Command card from the top 3 to hand, returns the rest to the bottom', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const command = createInstance({ number: 'C1', type: 'command' }, 0);
  const unit1 = createInstance({ number: 'U1', type: 'unit' }, 0);
  const unit2 = createInstance({ number: 'U2', type: 'unit' }, 0);
  player.deck.push(unit1, command, unit2, createInstance({ number: 'U3', type: 'unit' }, 0));

  registry.demiBardingDeploy(state, player);
  assert.ok(player.hand.includes(command));
  assert.equal(player.deck.length, 3, 'the other 2 of the top 3 go to the bottom of the remaining deck');
  assert.equal(player.deck.includes(command), false);
});

test('Demi Barding GD05-025: no Command card among the top 3 -- nothing added to hand, all 3 returned', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(
    createInstance({ number: 'U1', type: 'unit' }, 0),
    createInstance({ number: 'U2', type: 'unit' }, 0),
    createInstance({ number: 'U3', type: 'unit' }, 0)
  );
  registry.demiBardingDeploy(state, player);
  assert.equal(player.hand.length, 0);
  assert.equal(player.deck.length, 3);
});

test('Gundam Aerial Rebuild GD05-026: enemy Units at or below (own matching-name Units + 1) deploy rested; not Link-gated, doesn\'t affect friendly deploys', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, { number: 'GD05-026', type: 'unit', ap: 3, hp: 5, name: 'Gundam Aerial Rebuild', deployRestedAuraNameIncludesAny: ['Gundam Lfrith', 'Gundnode'] });
  // cap starts at 1 (just itself): only Lv.1-or-lower enemy deploys rested.
  const enemyLv1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 1 });
  assert.equal(enemyLv1.rested, true);
  const enemyLv2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 2 });
  assert.equal(enemyLv2.rested, false, 'cap is only 1 so far');

  deployUnit(state, player, { number: 'F1', type: 'unit', ap: 1, hp: 1, name: 'Gundam Lfrith Ur' });
  const enemyLv2b = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 1, level: 2 });
  assert.equal(enemyLv2b.rested, true, 'cap now 2 after a matching-name Unit joined play');

  const friendlyLv1 = deployUnit(state, player, { number: 'F2', type: 'unit', ap: 1, hp: 1, level: 1 });
  assert.equal(friendlyLv1.rested, false, 'aura only affects the aura-owner\'s enemy, not friendly deploys');
});
