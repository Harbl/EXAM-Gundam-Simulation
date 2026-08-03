const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getRemainingHP, getKeywords } = require('../src/rules/management');
const { dealEffectDamage } = require('../src/rules/effects');
const { canAfford } = require('../src/rules/cost');
const registry = require('../src/effects/registry');

test('Gundam Aerial Rebuild GD04-024: Deploy reveals an (Academy) Unit/Command from the top 3 of the deck', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const nonAcademy = { number: 'D1', type: 'unit', traits: [] };
  const match = { number: 'D2', type: 'command', traits: ['Academy'] };
  player.deck.push(createInstance(nonAcademy, 0), createInstance(match, 0));

  registry.gundamAerialRebuildDeploy(state, player);
  assert.ok(player.hand.some((c) => c.def === match), '(Academy) Command added to hand');
  assert.equal(player.deck.length, 1, 'the non-matching card returned to the deck');
});

test("Gundvolva GD04-025: Destroyed places an EX Resource during your turn if another (Dawn of Fold) Unit is in play", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  registry.gundvolvaDestroyed(state, player);
  assert.equal(player.resourceArea.length, 0, 'no other (Dawn of Fold) Unit in play -- no EX Resource');

  deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, traits: ['Dawn of Fold'] });
  registry.gundvolvaDestroyed(state, player);
  assert.equal(player.resourceArea.length, 1, 'another (Dawn of Fold) Unit in play -- EX Resource placed');
});

test("Garma's Dopp GD04-026: Deploy buries a non-Unit/Base top card, leaves a Unit/Base on top", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const command = createInstance({ number: 'D1', type: 'command' }, 0);
  player.deck.push(command);
  registry.garmasDoppDeploy(state, player);
  assert.equal(player.deck.length, 0, 'Command card buried to trash');
  assert.ok(player.trash.includes(command));

  const unit = createInstance({ number: 'D2', type: 'unit' }, 0);
  player.deck.push(unit);
  registry.garmasDoppDeploy(state, player);
  assert.equal(player.deck[0], unit, 'Unit card left on top');
});

test('Zakrello GD04-028: Attack grants an active enemy Unit <Blocker> for the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-028'));
  const rested = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 1 });
  rested.rested = true;
  const weakest = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });
  deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 5, hp: 1 });

  registry.zakrelloAttack(state, player, instance, {});
  assert.equal(getKeywords(weakest).blocker, true, 'weakest active enemy gains Blocker');
  assert.equal(getKeywords(rested).blocker, undefined, 'rested Unit not eligible');
});

test('Gundam Dynames (GN Full Shield) GD04-029: Once per Turn reduces enemy damage by 1 while a (CB) Pilot is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-029'));

  dealEffectDamage(state, opponent, player, instance, 2);
  assert.equal(getRemainingHP(instance), 1, 'no (CB) Pilot in play -- full 2 damage taken');

  const cbUnit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  const pilot = createInstance({ number: 'P', type: 'pilot', traits: ['CB'] }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, cbUnit, pilot);

  dealEffectDamage(state, opponent, player, instance, 2);
  assert.equal(getRemainingHP(instance), 0, '(CB) Pilot in play -- reduced by 1 (2 -> 1 more taken)');

  dealEffectDamage(state, opponent, player, instance, 1);
  assert.equal(getRemainingHP(instance), -1, 'Once per Turn already used -- no second reduction');

  dealEffectDamage(state, player, player, instance, 1);
  assert.equal(getRemainingHP(instance), -2, 'friendly-sourced damage never reduces (isEnemyDamage false) and reduction already spent');
});

test("Chuchu's Demi Trainer GD04-030: Attack lets another (Academy) Unit target an active Lv<=3 enemy this turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-030'));
  const nonAcademy = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  const academy = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['Academy'] });

  registry.chuchusDemiTrainerGD04030Attack(state, player, instance, {});
  assert.ok(academy.buffs.some((b) => b.activeTargetLevelCap === 3 && b.scope === 'turn'), '(Academy) ally gets the grant');
  assert.equal(nonAcademy.buffs.length, 0, 'non-(Academy) Unit unaffected');
});

test('Neo Zeong (LR+) GD04-033: reacts to its own or another friendly (Neo Zeon) Unit deploying, and grants the trait to all friendly Units While Linked', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  const neoZeong = deployUnit(state, player, lookupCard('GD04-033'));
  assert.equal(getRemainingHP(target), 2, "Neo Zeong's own deploy triggers the damage");

  const nonNeoZeon = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  assert.equal(getRemainingHP(target), 2, 'non-(Neo Zeon) Unit deployed, not Linked -- no reaction');

  neoZeong.isLinkUnit = true;
  const nonNeoZeon2 = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  assert.equal(getRemainingHP(target), -1, 'While Linked, all friendly Units count as (Neo Zeon) -- deploy triggers the damage');
});

test('Xi Gundam GD04-035: Deploy grants a (Mafty) ally a conditional draw-on-kill for the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const maftyUnit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 5, hp: 5, traits: ['Mafty'] });
  const instance = deployUnit(state, player, lookupCard('GD04-035'));
  for (let i = 0; i < 5; i++) player.deck.push(createInstance({ number: `D${i}`, type: 'unit' }, 0));

  registry.xiGundamDeploy(state, player, instance, {});
  assert.ok(maftyUnit.buffs.some((b) => b.onKillDrawIfHandAtMost === 3 && b.scope === 'turn'));

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1 });
  const { resolveUnitBattleDamage } = require('../src/rules/combat');
  resolveUnitBattleDamage(state, player, opponent, maftyUnit, enemy, {});
  assert.equal(player.hand.length, 1, '3 or fewer cards in hand when the (Mafty) ally destroys an enemy -- drew 1');
});

test('Gundam Throne Eins (R+) GD04-036: Deploy rests up to 2 other active (CB) allies to damage all enemy Lv<=6 Units', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-036'));
  const cbAlly1 = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 1, traits: ['CB'] });
  const cbAlly2 = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 3, hp: 1, traits: ['CB'] });
  const nonCbAlly = deployUnit(state, player, { number: 'U3', type: 'unit', ap: 1, hp: 1 });
  const lowLvEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3, level: 6 });
  const highLvEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3, level: 7 });

  registry.gundamThroneEinsDeploy(state, player, instance, {});
  assert.equal(cbAlly1.rested, true, 'highest-AP (CB) ally rested');
  assert.equal(cbAlly2.rested, true, 'second (CB) ally rested');
  assert.equal(nonCbAlly.rested, false, 'non-(CB) ally left alone');
  assert.equal(getRemainingHP(lowLvEnemy), 1, 'Lv<=6 enemy takes damage equal to 2 rested allies');
  assert.equal(getRemainingHP(highLvEnemy), 3, 'Lv.7 enemy is above the cap -- untouched');
});

test('Gundam Kyrios (Trans-Am) GD04-037: gains First Strike / Breach 3 based on a team (Super Soldier) Pilot color', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-037'));

  registry.gundamKyriosTransAmStartOfTurn(state, player, instance);
  assert.equal(getKeywords(instance).firstStrike, false);
  assert.equal(getKeywords(instance).breach, 0);

  const redUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  const redPilot = createInstance({ number: 'P1', type: 'pilot', color: 'red', traits: ['Super Soldier'] }, 0);
  player.hand.push(redPilot);
  pairPilot(state, player, redUnit, redPilot);
  registry.gundamKyriosTransAmStartOfTurn(state, player, instance);
  assert.equal(getKeywords(instance).firstStrike, true, 'red (Super Soldier) Pilot in play -- gains First Strike');
  assert.equal(getKeywords(instance).breach, 0, 'no green (Super Soldier) Pilot yet -- no Breach');

  const greenUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  const greenPilot = createInstance({ number: 'P2', type: 'pilot', color: 'green', traits: ['Super Soldier'] }, 0);
  player.hand.push(greenPilot);
  pairPilot(state, player, greenUnit, greenPilot);
  registry.gundamKyriosTransAmStartOfTurn(state, player, instance);
  assert.equal(getKeywords(instance).breach, 3, 'green (Super Soldier) Pilot in play -- gains Breach 3');
});

test('Gundam Exia (GD04-038): Deploy deals 2 damage to a Lv<=2 enemy only if 2+ enemy Units are in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-038'));
  const onlyEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5, level: 1 });

  registry.gundamExia038Deploy(state, player, instance, {});
  assert.equal(getRemainingHP(onlyEnemy), 5, 'only 1 enemy Unit in play -- no damage');

  const secondEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5, level: 3 });
  registry.gundamExia038Deploy(state, player, instance, {});
  assert.equal(getRemainingHP(onlyEnemy), 3, '2+ enemy Units in play -- Lv<=2 enemy takes 2 damage');
  assert.equal(getRemainingHP(secondEnemy), 5, 'Lv.3 enemy is above the cap -- untouched');
});

test('Rozen Zulu GD04-039: cost -4 with 8+ (Neo Zeon) trash cards; Deploy deals 1 (3 vs <Repair>) to an enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const def = lookupCard('GD04-039');
  for (let i = 0; i < 4; i++) player.resourceArea.push(createInstance({ number: `R${i}`, type: 'resource' }, 0));

  assert.equal(canAfford(player, def), false, 'cost 6 with only 4 active Resources -- not affordable');

  for (let i = 0; i < 8; i++) player.trash.push(createInstance({ number: `T${i}`, type: 'unit', traits: ['Neo Zeon'] }, 0));
  assert.equal(canAfford(player, def), true, '8+ (Neo Zeon) trash cards -- cost -4 to 2, now affordable');

  const instance = deployUnit(state, player, def);
  const plainEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  registry.rozenZuluDeploy(state, player, instance, {});
  assert.equal(getRemainingHP(plainEnemy), 4, 'no <Repair> -- takes 1 damage');

  const repairEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, keywords: { repair: true } });
  registry.rozenZuluDeploy(state, player, instance, {});
  assert.equal(getRemainingHP(repairEnemy), -2, 'has <Repair> and is the lowest-remaining-HP target -- takes 3 damage instead');
});
