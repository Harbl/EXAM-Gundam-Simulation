const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { applyRepairAtEndOfTurn } = require('../src/rules/effects');
const { resolveUnitBattleDamage } = require('../src/rules/combat');

function resource() {
  return createInstance({ number: 'RESOURCE', name: 'Resource', type: 'resource' }, 0);
}

test('Gundam Aerial GD01-082 Activate·Action costs 2 Resources, Once per Turn, only while paired, debuffs an enemy Unit AP-1 for the battle', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const aerial = deployUnit(state, player, lookupCard('GD01-082'));
  player.resourceArea.push(resource(), resource());
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 3, hp: 5 }, 1);
  opponent.battleArea.push(enemy);

  assert.equal(aerial.def.effects.activateAction(state, player, aerial, { target: enemy }), false, 'not paired yet');

  pairPilot(state, player, aerial, createInstance({ number: 'P', type: 'pilot' }, 0));
  assert.equal(aerial.def.effects.activateAction(state, player, aerial, { target: enemy }), true);
  assert.equal(getAP(enemy), 2);
  assert.equal(player.resourceArea.every((r) => r.rested), true, 'costs 2 Resources');
  assert.equal(aerial.def.effects.activateAction(state, player, aerial, { target: enemy }), false, 'Once per Turn');
});

test('Sayla Mass GD01-087 grants Repair 1 to her paired Unit only while it is blue', () => {
  const player = createPlayer(0);
  const blueUnit = deployUnit({ turnNumber: 1 }, player, { number: 'BU', type: 'unit', color: 'blue', hp: 3 });
  const greenUnit = deployUnit({ turnNumber: 1 }, player, { number: 'GU', type: 'unit', color: 'green', hp: 3 });
  pairPilot({ turnNumber: 1 }, player, blueUnit, createInstance(lookupCard('GD01-087'), 0));
  pairPilot({ turnNumber: 1 }, player, greenUnit, createInstance(lookupCard('GD01-087'), 0));
  blueUnit.damage = 2;
  greenUnit.damage = 2;
  const blueHp = getRemainingHP(blueUnit); // hp 3 + Sayla's own hpBonus 1, minus 2 damage
  const greenHp = getRemainingHP(greenUnit);
  applyRepairAtEndOfTurn({}, player);
  assert.equal(getRemainingHP(blueUnit), blueHp + 1, 'blue -- Repair 1 applied');
  assert.equal(getRemainingHP(greenUnit), greenHp, 'green -- no Repair from Sayla');
});

test('Banagher Links GD01-088 draws 1 When Linked', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.players[0].deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const unicorn = deployUnit(state, player, lookupCard('GD01-005'));
  pairPilot(state, player, unicorn, createInstance(lookupCard('GD01-088'), 0));
  assert.equal(unicorn.isLinkUnit, true);
  assert.equal(player.hand.length, 1);
});

test('Riddhe Marcenas GD01-089 grants AP+1 only while the paired Unit has Repair', () => {
  const player = createPlayer(0);
  const repairUnit = deployUnit({ turnNumber: 1 }, player, { number: 'RU', type: 'unit', ap: 2, keywords: { repair: 1 } });
  const plainUnit = deployUnit({ turnNumber: 1 }, player, { number: 'PU', type: 'unit', ap: 2 });
  pairPilot({ turnNumber: 1 }, player, repairUnit, createInstance(lookupCard('GD01-089'), 0));
  pairPilot({ turnNumber: 1 }, player, plainUnit, createInstance(lookupCard('GD01-089'), 0));
  assert.equal(getAP(repairUnit), 4, '2 base + 1 Pilot apBonus + 1 conditional Repair bonus');
  assert.equal(getAP(plainUnit), 3, '2 base + 1 Pilot apBonus, no Repair -- no conditional bonus');
});

test("Duo Maxwell GD01-090 makes its Linked Unit's AP immune to enemy reduction", () => {
  const player = createPlayer(0);
  const duoLinked = deployUnit({ turnNumber: 1 }, player, lookupCard('GD01-025'));
  pairPilot({ turnNumber: 1 }, player, duoLinked, createInstance(lookupCard('GD01-090'), 0));
  assert.equal(duoLinked.isLinkUnit, true, 'GD01-025 links off Duo Maxwell');

  const baseline = getAP(duoLinked); // 5 (card) + 1 (Pilot apBonus)
  duoLinked.buffs.push({ ap: -3, scope: 'turn' });
  assert.equal(getAP(duoLinked), baseline, 'the AP-3 reduction is filtered out entirely while Linked to Duo Maxwell');
  duoLinked.buffs.push({ ap: 2, scope: 'turn' });
  assert.equal(getAP(duoLinked), baseline + 2, 'positive buffs still apply normally');
});

test("M'Quve GD01-092 grants Breach 1 only while the paired Unit is (Zeon)", () => {
  const player = createPlayer(0);
  const zeonUnit = deployUnit({ turnNumber: 1 }, player, { number: 'ZU', type: 'unit', traits: ['Zeon'] });
  const otherUnit = deployUnit({ turnNumber: 1 }, player, { number: 'OU', type: 'unit', traits: [] });
  pairPilot({ turnNumber: 1 }, player, zeonUnit, createInstance(lookupCard('GD01-092'), 0));
  pairPilot({ turnNumber: 1 }, player, otherUnit, createInstance(lookupCard('GD01-092'), 0));
  assert.equal(getKeywords(zeonUnit).breach, 1);
  assert.equal(getKeywords(otherUnit).breach, undefined);
});

test('Yzak Jule GD01-094 draws 1, Once per Turn, only when its Unit destroys an enemy Link Unit with battle damage while attacking', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.players[0].deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  const attacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 10, hp: 10 });
  pairPilot(state, player, attacker, createInstance(lookupCard('GD01-094'), 0));

  const nonLinkDefender = createInstance({ number: 'NL', type: 'unit', ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(nonLinkDefender);
  resolveUnitBattleDamage(state, player, opponent, attacker, nonLinkDefender, {});
  assert.equal(player.hand.length, 0, 'destroyed a non-Link Unit -- no draw');

  const linkDefender = createInstance({ number: 'LD', type: 'unit', ap: 1, hp: 1 }, 1);
  linkDefender.isLinkUnit = true;
  opponent.battleArea.push(linkDefender);
  resolveUnitBattleDamage(state, player, opponent, attacker, linkDefender, {});
  assert.equal(player.hand.length, 1, 'destroyed an enemy Link Unit -- draws 1');

  const linkDefender2 = createInstance({ number: 'LD2', type: 'unit', ap: 1, hp: 1 }, 1);
  linkDefender2.isLinkUnit = true;
  opponent.battleArea.push(linkDefender2);
  resolveUnitBattleDamage(state, player, opponent, attacker, linkDefender2, {});
  assert.equal(player.hand.length, 1, 'Once per Turn -- no second draw');
});

test('Dearka Elthman GD01-095 discards 1 then draws 1 When Linked', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.players[0].deck.push(createInstance({ number: 'DRAWN', type: 'unit' }, 0));
  const hand1 = createInstance({ number: 'H1', type: 'unit', cost: 1 }, 0);
  player.hand.push(hand1);
  const dinn = deployUnit(state, player, lookupCard('GD01-064'));
  pairPilot(state, player, dinn, createInstance(lookupCard('GD01-095'), 0));
  // DINN has no linkCondition, so pairing never links -- fire the Pilot's own whenLinked directly.
  dinn.pilot.def.effects.whenLinked(state, player);
  assert.equal(player.hand.includes(hand1), false, 'discarded');
  assert.equal(player.hand.some((c) => c.def.number === 'DRAWN'), true, 'then drew 1');
});

test('Cagalli Yula Athha GD01-096 grants Blocker to her paired Unit only while it is white', () => {
  const player = createPlayer(0);
  const whiteUnit = deployUnit({ turnNumber: 1 }, player, { number: 'WU', type: 'unit', color: 'white' });
  const otherUnit = deployUnit({ turnNumber: 1 }, player, { number: 'OU2', type: 'unit', color: 'red' });
  pairPilot({ turnNumber: 1 }, player, whiteUnit, createInstance(lookupCard('GD01-096'), 0));
  pairPilot({ turnNumber: 1 }, player, otherUnit, createInstance(lookupCard('GD01-096'), 0));
  assert.equal(getKeywords(whiteUnit).blocker, true);
  assert.equal(getKeywords(otherUnit).blocker, undefined);
});

test("Guel Jeturk GD01-097 Activate·Main sets its Unit active (and unable to attack) only if the opponent has 8+ cards in hand, Once per Turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const dilanza = deployUnit(state, player, lookupCard('GD01-083'));
  pairPilot(state, player, dilanza, createInstance(lookupCard('GD01-097'), 0));
  dilanza.rested = true;
  for (let i = 0; i < 7; i++) opponent.hand.push(createInstance({ number: `H${i}`, type: 'unit' }, 1));

  assert.equal(dilanza.pilot.def.effects.activateMain(state, player, dilanza), false, 'only 7 cards -- not enough');
  opponent.hand.push(createInstance({ number: 'H7', type: 'unit' }, 1));
  assert.equal(dilanza.pilot.def.effects.activateMain(state, player, dilanza), true, '8 cards -- now legal');
  assert.equal(dilanza.rested, false);
  assert.equal(dilanza.buffs.some((b) => b.cannotAttack), true);
});

test('Elan Ceres GD01-098 Activate·Action recovers 1 HP, Once per Turn, only if an enemy Unit with 1 or less AP is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const beguir = deployUnit(state, player, lookupCard('GD01-084'));
  pairPilot(state, player, beguir, createInstance(lookupCard('GD01-098'), 0));
  beguir.damage = 2;
  const beforeHeal = getRemainingHP(beguir);
  const strongEnemy = createInstance({ number: 'SE', type: 'unit', ap: 3, hp: 3 }, 1);
  opponent.battleArea.push(strongEnemy);

  assert.equal(beguir.pilot.def.effects.activateAction(state, player, beguir), false, 'no weak enemy yet');
  const weakEnemy = createInstance({ number: 'WE', type: 'unit', ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(weakEnemy);
  assert.equal(beguir.pilot.def.effects.activateAction(state, player, beguir), true);
  assert.equal(getRemainingHP(beguir), beforeHeal + 1, 'recovered 1 of the 2 damage taken');
});
