const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, pairPilot, playCommand } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { resolveAttack, destroyAndFireEffect } = require('../src/rules/combat');
const { runStartPhase } = require('../src/rules/phases');
const { dealEffectDamage } = require('../src/rules/effects');

function noBlockHooks() {
  return { chooseBlocker: () => null, chooseBurst: () => false };
}

test('Psycho Gundam (LR+) GD02-001 recovers 2 HP when a paired (Cyber-Newtype) Pilot is in and any of your (Titans) Units destroys an enemy shield with damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  opponent.shields.push(createInstance({ number: 'S', type: 'unit' }, 1));

  const psycho = deployUnit(state, player, lookupCard('GD02-001'));
  psycho.damage = 3;
  const cyberNewtype = createInstance({ number: 'P', type: 'pilot', traits: ['Cyber-Newtype'] }, 0);
  pairPilot(state, player, psycho, cyberNewtype);

  const titansAttacker = deployUnit(state, player, { number: 'T', type: 'unit', traits: ['Titans'], ap: 3, hp: 3 });
  resolveAttack(state, 0, titansAttacker, { type: 'player' }, noBlockHooks());

  assert.equal(getRemainingHP(psycho), 4, '5 - 3 + 2 recovered');
});

test('Psycho Gundam (LR+) GD02-001 does not recover if the attacker lacks the (Titans) trait', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  opponent.shields.push(createInstance({ number: 'S', type: 'unit' }, 1));

  const psycho = deployUnit(state, player, lookupCard('GD02-001'));
  psycho.damage = 3;
  pairPilot(state, player, psycho, createInstance({ number: 'P', type: 'pilot', traits: ['Cyber-Newtype'] }, 0));

  const nonTitansAttacker = deployUnit(state, player, { number: 'X', type: 'unit', traits: [], ap: 3, hp: 3 });
  resolveAttack(state, 0, nonTitansAttacker, { type: 'player' }, noBlockHooks());

  assert.equal(getRemainingHP(psycho), 2, 'no recovery -- attacker is not a (Titans) Unit');
});

test('Gundam Epyon (LR+) GD02-002: During Link, Once per Turn, sets itself active when any friendly Unit destroys an enemy Unit with battle damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const epyon = deployUnit(state, player, lookupCard('GD02-002'));
  epyon.isLinkUnit = true;
  epyon.rested = true;

  const killer = deployUnit(state, player, { number: 'K', type: 'unit', ap: 5, hp: 5 });
  const weakEnemy = createInstance({ number: 'W', type: 'unit', ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(weakEnemy);

  resolveAttack(state, 0, killer, { type: 'unit', instance: weakEnemy }, noBlockHooks());

  assert.equal(epyon.rested, false, "set active by an ally's kill, even though Epyon itself didn't attack");
});

test('Gundam Mk-II (Titans) (R+) GD02-003: Destroyed, if paired with a Lv.3-or-lower Pilot, may discard a Unit card to return the paired Pilot to hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const mk2 = deployUnit(state, player, lookupCard('GD02-003'));
  const pilot = createInstance({ number: 'P', type: 'pilot', level: 3 }, 0);
  pairPilot(state, player, mk2, pilot);
  const unitInHand = createInstance({ number: 'U', type: 'unit', cost: 2 }, 0);
  player.hand.push(unitInHand);
  mk2.damage = 999;

  destroyAndFireEffect(state, player, mk2);

  assert.equal(player.hand.includes(unitInHand), false, 'discarded the Unit card');
  assert.equal(player.hand.includes(pilot), true, "paired Pilot returned to hand");
});

test("Gundam Mk-II (Titans) (R+) GD02-003 doesn't trigger when the paired Pilot is above Lv.3", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const mk2 = deployUnit(state, player, lookupCard('GD02-003'));
  const pilot = createInstance({ number: 'P', type: 'pilot', level: 4 }, 0);
  pairPilot(state, player, mk2, pilot);
  player.hand.push(createInstance({ number: 'U', type: 'unit', cost: 2 }, 0));
  mk2.damage = 999;

  destroyAndFireEffect(state, player, mk2);

  assert.equal(player.hand.includes(pilot), false, 'Pilot stays in trash -- too high level to trigger');
});

test('Byarlant GD02-004: When Paired, a rested enemy Unit with <=3 HP stays rested through its own next start phase', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const byarlant = deployUnit(state, player, lookupCard('GD02-004'));
  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  const target = createInstance({ number: 'E', type: 'unit', hp: 3 }, 1);
  target.rested = true;
  opponent.battleArea.push(target);

  pairPilot(state, player, byarlant, pilot);
  assert.equal(target.skipNextUntap, true);

  state.activePlayerIdx = 1;
  runStartPhase(state); // opponent's next start phase -- skipped
  assert.equal(target.rested, true, 'stayed rested through the skip');

  state.activePlayerIdx = 0;
  runStartPhase(state);
  state.activePlayerIdx = 1;
  runStartPhase(state); // the turn after -- untaps normally
  assert.equal(target.rested, false);
});

test('Tallgeese (R+) GD02-005: During Link, Attack rests an enemy Unit with <=2 HP', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const tallgeese = deployUnit(state, player, lookupCard('GD02-005'));
  tallgeese.isLinkUnit = true;
  const lowHp = createInstance({ number: 'L', type: 'unit', hp: 2 }, 1);
  const highHp = createInstance({ number: 'H', type: 'unit', hp: 5 }, 1);
  state.players[1].battleArea.push(lowHp, highHp);

  tallgeese.def.effects.attack(state, player, tallgeese, {});

  assert.equal(lowHp.rested, true);
  assert.equal(highHp.rested, false, 'too much HP to qualify');
});

test("Tallgeese (R+) GD02-005 does nothing when not Linked", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const tallgeese = deployUnit(state, player, lookupCard('GD02-005'));
  const lowHp = createInstance({ number: 'L', type: 'unit', hp: 2 }, 1);
  state.players[1].battleArea.push(lowHp);

  tallgeese.def.effects.attack(state, player, tallgeese, {});

  assert.equal(lowHp.rested, false);
});

test("Forbidden Gundam GD02-006 can't receive battle return damage from an enemy Unit that is Lv.2 or lower", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const forbidden = deployUnit(state, player, lookupCard('GD02-006'));
  assert.equal(getKeywords(forbidden).blocker, true);
  const lowLevelEnemy = createInstance({ number: 'E', type: 'unit', level: 2, ap: 3, hp: 10 }, 1);
  opponent.battleArea.push(lowLevelEnemy);

  resolveAttack(state, 0, forbidden, { type: 'unit', instance: lowLevelEnemy }, noBlockHooks());

  assert.equal(forbidden.damage, 0, 'immune -- enemy is Lv.2');
});

test('Forbidden Gundam GD02-006 still takes return damage from an enemy Unit above Lv.2', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const forbidden = deployUnit(state, player, lookupCard('GD02-006'));
  const higherLevelEnemy = createInstance({ number: 'E', type: 'unit', level: 3, ap: 3, hp: 10 }, 1);
  opponent.battleArea.push(higherLevelEnemy);

  resolveAttack(state, 0, forbidden, { type: 'unit', instance: higherLevelEnemy }, noBlockHooks());

  assert.equal(forbidden.damage, 3, 'not immune -- enemy is Lv.3');
});

test('Gabthley GD02-008: When Linked, deals 1 damage to the lowest-remaining-HP rested enemy Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const gabthley = deployUnit(state, player, lookupCard('GD02-008'));
  const nearDeath = createInstance({ number: 'N', type: 'unit', hp: 1 }, 1);
  nearDeath.rested = true;
  const healthy = createInstance({ number: 'H', type: 'unit', hp: 5 }, 1);
  healthy.rested = true;
  state.players[1].battleArea.push(nearDeath, healthy);
  const pilot = createInstance({ number: 'P', type: 'pilot', traits: ['Titans'] }, 0);

  pairPilot(state, player, gabthley, pilot);

  assert.equal(state.players[1].battleArea.includes(nearDeath), false, 'destroyed by the 1 damage');
  assert.equal(healthy.damage, 0);
});

test("Calamity Gundam GD02-009 Once per Turn deals 2 to the lowest-HP rested enemy when its AP is reduced by an enemy effect", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const calamity = deployUnit(state, player, lookupCard('GD02-009'));
  const target = createInstance({ number: 'T', type: 'unit', hp: 5 }, 1);
  target.rested = true;
  opponent.battleArea.push(target);

  calamity.def.effects.apReducedByEnemy(state, player, calamity, {});
  assert.equal(target.damage, 2);

  const target2 = createInstance({ number: 'T2', type: 'unit', hp: 5 }, 1);
  target2.rested = true;
  opponent.battleArea.push(target2);
  calamity.def.effects.apReducedByEnemy(state, player, calamity, {});
  assert.equal(target2.damage, 0, 'Once per Turn -- already used');
});

test('Raider Gundam GD02-010 draws 1 (Once per Turn) when it receives enemy effect damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const raider = deployUnit(state, player, lookupCard('GD02-010'));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  const handSize = player.hand.length;

  dealEffectDamage(state, opponent, player, raider, 3);
  assert.equal(player.hand.length, handSize + 1);

  dealEffectDamage(state, opponent, player, raider, 1);
  assert.equal(player.hand.length, handSize + 1, 'Once per Turn -- no second draw');
});

test("Raider Gundam GD02-010 doesn't draw from its own controller's effect damage", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const raider = deployUnit(state, player, lookupCard('GD02-010'));
  const handSize = player.hand.length;

  dealEffectDamage(state, player, player, raider, 3);
  assert.equal(player.hand.length, handSize);
});

test('Moebius (Peacemaker Team) GD02-011 Activate:Action destroys itself and deals 6 to the enemy Base/Shield being battled', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const moebius = deployUnit(state, player, lookupCard('GD02-011'));
  opponent.shields.push(createInstance({ number: 'S', type: 'unit' }, 1));

  const result = moebius.def.effects.activateAction(state, player, moebius, { target: { type: 'player' }, hooks: { chooseBurst: () => false } });

  assert.equal(result, true);
  assert.equal(player.battleArea.includes(moebius), false, 'destroyed itself as the cost');
  assert.equal(opponent.shields.length, 0, '6 damage destroys the 1 Shield');
});

test("Moebius (Peacemaker Team) GD02-011 refuses to activate without a live battle target", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const moebius = deployUnit(state, player, lookupCard('GD02-011'));

  const result = moebius.def.effects.activateAction(state, player, moebius, {});

  assert.equal(result, false);
  assert.equal(player.battleArea.includes(moebius), true, 'not destroyed -- ability did not activate');
});

test('Galbaldy Beta GD02-014 Deploy buffs the highest-AP friendly (Titans) Unit by AP+1 this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const strongTitans = deployUnit(state, player, { number: 'S', type: 'unit', traits: ['Titans'], ap: 5, hp: 3 });
  const weakTitans = deployUnit(state, player, { number: 'W', type: 'unit', traits: ['Titans'], ap: 2, hp: 3 });

  deployUnit(state, player, lookupCard('GD02-014'));

  assert.equal(getAP(strongTitans), 6);
  assert.equal(getAP(weakTitans), 2, 'only the highest-AP candidate is chosen');
});
