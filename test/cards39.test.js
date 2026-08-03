const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, playCommand, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { resolveUnitBattleDamage } = require('../src/rules/combat');
const { dealEffectDamage } = require('../src/rules/effects');
const registry = require('../src/effects/registry');

test('Psycho Gundam Mk-II GD04-004: Once per Turn draws when a (Cyber-Newtype) Pilot is paired with a friendly blue Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 3; i++) player.deck.push(createInstance({ number: `D${i}`, type: 'unit' }, 0));
  const instance = deployUnit(state, player, lookupCard('GD04-004'));

  const nonBlueUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, color: 'green' });
  const nonCyberPilot = createInstance({ number: 'P1', type: 'pilot', traits: [] }, 0);
  player.hand.push(nonCyberPilot);
  pairPilot(state, player, nonBlueUnit, nonCyberPilot);
  assert.equal(player.hand.length, 0, 'non-blue Unit paired -- no draw');

  const blueUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, color: 'blue' });
  const cyberPilot = createInstance({ number: 'P2', type: 'pilot', traits: ['Cyber-Newtype'] }, 0);
  player.hand.push(cyberPilot);
  pairPilot(state, player, blueUnit, cyberPilot);
  assert.equal(player.hand.length, 1, '(Cyber-Newtype) Pilot paired with a blue Unit -- drew 1');

  const blueUnit2 = deployUnit(state, player, { number: 'U3', type: 'unit', ap: 1, hp: 1, color: 'blue' });
  const cyberPilot2 = createInstance({ number: 'P3', type: 'pilot', traits: ['Cyber-Newtype'] }, 0);
  player.hand.push(cyberPilot2);
  pairPilot(state, player, blueUnit2, cyberPilot2);
  assert.equal(player.hand.length, 1, 'Once per Turn already used -- no second draw');
});

test('Victory Gundam Hexa GD04-007: During Pair, Attack deploys a [Parts] token', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-007'));

  registry.victoryGundamHexaAttack(state, player, instance);
  assert.equal(player.battleArea.filter((u) => u.def.name === 'Parts').length, 0, 'not paired -- no token');

  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, instance, pilot);
  registry.victoryGundamHexaAttack(state, player, instance);
  const token = player.battleArea.find((u) => u.def.name === 'Parts');
  assert.ok(token, 'paired -- [Parts] token deployed');
  assert.equal(token.def.cannotAttackPlayer, true);
});

test('Gundam (GD04-008): [During Link] gains <High-Maneuver>', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-008'));

  assert.equal(getKeywords(instance).highManeuver, undefined, 'not linked -- no High-Maneuver');
  instance.isLinkUnit = true;
  assert.equal(getKeywords(instance).highManeuver, true, 'linked -- gains High-Maneuver');
});

test('Guncannon (108) & Guncannon (109) (R+) GD04-009: [When Linked] sets a rested Lv.4+ (White Base Team) ally active', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-009'));
  const tooLow = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, level: 3, traits: ['White Base Team'] });
  tooLow.rested = true;
  const eligible = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, level: 4, traits: ['White Base Team'] });
  eligible.rested = true;

  registry.guncannon108109WhenLinked(state, player, instance);
  assert.equal(tooLow.rested, true, 'Lv.3 ally left rested');
  assert.equal(eligible.rested, false, 'Lv.4 ally set active');
});

test('Core Fighter GD04-013: while rested, all friendly (League Militaire) Unit tokens gain <Blocker>', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-013'));
  const token = deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 1, isToken: true, traits: ['League Militaire'] });
  const nonToken = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, traits: ['League Militaire'] });

  registry.coreFighterStartOfTurn(state, player, instance);
  assert.equal(getKeywords(token).blocker, false, 'Core Fighter active -- no Blocker grant');

  instance.rested = true;
  registry.coreFighterStartOfTurn(state, player, instance);
  assert.equal(getKeywords(token).blocker, true, 'Core Fighter rested -- token gains Blocker');
  assert.equal(getKeywords(nonToken).blocker, undefined, 'non-token Unit unaffected');
});

test('Gundam Pharact (LR+) GD04-018: Once per Turn during your turn, places an EX Resource when another friendly (Academy) Unit receives damage from an enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-018'));
  const nonAcademy = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 5 });
  const academy = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 5, traits: ['Academy'] });
  state.activePlayerIdx = 0;

  dealEffectDamage(state, opponent, player, nonAcademy, 1);
  assert.equal(player.resourceArea.length, 0, 'non-(Academy) target -- no reaction');

  dealEffectDamage(state, opponent, player, instance, 1);
  assert.equal(player.resourceArea.length, 0, 'damage to itself -- no reaction (must be an OTHER Academy Unit)');

  dealEffectDamage(state, opponent, player, academy, 1);
  assert.equal(player.resourceArea.length, 1, 'other (Academy) Unit receives enemy effect damage -- EX Resource placed');

  const academy2 = deployUnit(state, player, { number: 'U3', type: 'unit', ap: 1, hp: 5, traits: ['Academy'] });
  dealEffectDamage(state, opponent, player, academy2, 1);
  assert.equal(player.resourceArea.length, 1, 'Once per Turn already used -- no second EX Resource');
});

test('Gundam Pharact (LR+) GD04-018 also reacts to enemy battle damage (not just effect damage)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('GD04-018'));
  const academy = deployUnit(state, player, { number: 'U', type: 'unit', ap: 0, hp: 5, traits: ['Academy'] });
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 1, hp: 5 });

  resolveUnitBattleDamage(state, opponent, player, attacker, academy, {});
  assert.equal(player.resourceArea.length, 1, 'friendly (Academy) Unit takes enemy battle damage -- EX Resource placed');
});

test('GN Armor Type-D (Trans-Am) GD04-019: Destroyed reveals a Lv<=5 (CB) Unit from the top 3 of the deck', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const nonCB = { number: 'D1', type: 'unit', traits: [] };
  const tooHigh = { number: 'D2', type: 'unit', traits: ['CB'], level: 6 };
  const match = { number: 'D3', type: 'unit', traits: ['CB'], level: 5 };
  player.deck.push(createInstance(nonCB, 0), createInstance(tooHigh, 0), createInstance(match, 0));

  registry.gnArmorTypeDTransAmDestroyed(state, player);
  assert.ok(player.hand.some((c) => c.def === match), 'Lv<=5 (CB) Unit added to hand');
  assert.equal(player.deck.length, 2, 'other 2 cards returned to the deck');
});

test('Gundam Lfrith Ur GD04-020: Once per Turn during your turn, draws 1 when a (Dawn of Fold) Command is played using an EX Resource', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('GD04-020'));
  for (let i = 0; i < 3; i++) player.deck.push(createInstance({ number: `D${i}`, type: 'unit' }, 0));
  state.activePlayerIdx = 0;
  const dawnOfFoldCommand = { number: 'C', type: 'command', traits: ['Dawn of Fold'] };
  const otherCommand = { number: 'C2', type: 'command', traits: [] };

  playCommand(state, player, otherCommand, { usedExResource: true });
  assert.equal(player.hand.length, 0, 'non-(Dawn of Fold) Command -- no draw');

  playCommand(state, player, dawnOfFoldCommand, { usedExResource: false });
  assert.equal(player.hand.length, 0, "didn't use an EX Resource -- no draw");

  playCommand(state, player, dawnOfFoldCommand, { usedExResource: true });
  assert.equal(player.hand.length, 1, '(Dawn of Fold) Command played using an EX Resource -- drew 1');

  playCommand(state, player, dawnOfFoldCommand, { usedExResource: true });
  assert.equal(player.hand.length, 1, 'Once per Turn already used -- no second draw');
});

test('Gundam Lfrith Thorn (R+) GD04-021: pairs a played (Dawn of Fold) Command from trash onto a "Gundam Lfrith"-named Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const thorn = deployUnit(state, player, lookupCard('GD04-021'));
  // Thorn's own name also contains "Gundam Lfrith", so it's itself a legal target -- already pairing
  // it off isolates the check to the OTHER matching Unit below.
  const dummyPilot = createInstance({ number: 'P0', type: 'pilot' }, 0);
  player.hand.push(dummyPilot);
  pairPilot(state, player, thorn, dummyPilot);
  const lfrithUnit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, name: 'Gundam Lfrith Zaku' });
  state.activePlayerIdx = 0;
  const dawnOfFoldCommand = { number: 'C', type: 'command', traits: ['Dawn of Fold'] };

  const trashed = playCommand(state, player, dawnOfFoldCommand, { usedExResource: true });
  assert.equal(lfrithUnit.pilot, trashed, 'played Command paired from trash onto the "Gundam Lfrith"-named Unit');
  assert.ok(!player.trash.includes(trashed), 'no longer sitting in trash once paired');
});

test('Kikeroga (MS Mode) (GQ) (R+) GD04-022: friendly Unit tokens gain <Breach 1>; While Linked, Lv<=3 non-token deploys enter rested (both players)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-022'));
  const token = deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 1, isToken: true });
  registry.kikerogaMsModeStartOfTurn(state, player);
  assert.equal(getKeywords(token).breach, 1, 'friendly Unit token gains Breach 1');

  const lowLv = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 2 });
  assert.equal(lowLv.rested, false, 'not linked yet -- deploys normally');

  instance.isLinkUnit = true;
  const lowLv2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 3 });
  assert.equal(lowLv2.rested, true, 'Linked -- enemy Lv.3 Unit deploys rested too (symmetric, both players)');
  const highLv = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 1, level: 4 });
  assert.equal(highLv.rested, false, 'Lv.4 is above the cap -- deploys active');
  const tokenDeploy = deployUnit(state, opponent, { number: 'E4', type: 'unit', ap: 1, hp: 1, level: 1, isToken: true });
  assert.equal(tokenDeploy.rested, false, 'Unit tokens are excluded from the aura');
});

test('Gundam Kyrios (Tail Booster) GD04-023: Deploy lets a Unit paired with a (Super Soldier) Pilot target an active Lv<=4 enemy this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unpairedUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  registry.gundamKyriosTailBoosterDeploy(state, player);
  assert.equal(unpairedUnit.buffs.length, 0, 'no Unit paired with a (Super Soldier) Pilot -- no grant');

  const superSoldierUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  const pilot = createInstance({ number: 'P', type: 'pilot', traits: ['Super Soldier'] }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, superSoldierUnit, pilot);
  registry.gundamKyriosTailBoosterDeploy(state, player);
  assert.ok(
    superSoldierUnit.buffs.some((b) => b.activeTargetLevelCap === 4 && b.scope === 'turn'),
    'paired with a (Super Soldier) Pilot -- may target an active Lv<=4 enemy this turn'
  );
});
