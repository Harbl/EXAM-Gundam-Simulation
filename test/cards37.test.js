const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { resolveUnitBattleDamage } = require('../src/rules/combat');
const registry = require('../src/effects/registry');

test('Privileged Position GD03-102 Action: sets a friendly (Titans) Link Unit active if it is in the current battle', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const titansLink = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, traits: ['Titans'] });
  titansLink.isLinkUnit = true;
  titansLink.rested = true;
  const nonLink = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['Titans'] });
  nonLink.rested = true;
  const instance = createInstance(lookupCard('GD03-102'), 0);

  registry.privilegedPositionCommand(state, player, instance, { attacker: nonLink, defender: undefined });
  assert.equal(nonLink.rested, true, 'not a Link Unit -- no reaction');

  registry.privilegedPositionCommand(state, player, instance, { attacker: titansLink, defender: undefined });
  assert.equal(titansLink.rested, false, '(Titans) Link Unit in the current battle -- set active');
});

test('Field Directive GD03-103: Burst rests a 2-or-less-HP enemy, Main deals 2 damage to a rested enemy if 3+ enemies in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weak = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 2 });
  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3 });

  registry.fieldDirectiveBurst(state, player);
  assert.equal(weak.rested, true, '2-or-less-HP enemy -- rested');

  registry.fieldDirectiveCommand(state, player);
  assert.ok(opponent.battleArea.includes(weak), 'fewer than 3 enemy Units in play -- no damage');

  deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 3 }).rested = true;
  registry.fieldDirectiveCommand(state, player);
  assert.ok(!opponent.battleArea.includes(weak), '3+ enemies in play -- 2 damage kills the lowest-remaining-HP rested enemy');
});

test("Reccoa's Shadow GD03-104: rests 1 enemy Unit, or 2 with a friendly (Jupitris) Link Unit in play", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3 });

  registry.reccoasShadowCommand(state, player);
  assert.equal(opponent.battleArea.filter((u) => u.rested).length, 1, 'no (Jupitris) Link Unit -- rests only 1');

  for (const u of opponent.battleArea) u.rested = false;
  const jupitris = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, traits: ['Jupitris'] });
  jupitris.isLinkUnit = true;
  registry.reccoasShadowCommand(state, player);
  assert.equal(opponent.battleArea.filter((u) => u.rested).length, 2, 'friendly (Jupitris) Link Unit -- rests 2');
});

test('Bridge Crew (R+) GD03-105: grants a friendly Unit permission to target an active no-Pilot enemy Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 3, hp: 3 });
  const instance = createInstance(lookupCard('GD03-105'), 0);

  registry.bridgeCrewRPlusBurst(state, player, instance);
  assert.ok(player.hand.includes(instance), 'Burst -- added to hand');

  registry.bridgeCrewRPlusCommand(state, player);
  assert.ok(unit.buffs.some((b) => b.activeTargetNoPilot), 'chosen friendly Unit gains the activeTargetNoPilot buff');
});

test('M.A.V. Tactics GD03-106: deploys 2 rested Unit tokens', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));

  registry.mavTacticsCommand(state, player);
  const tokens = player.battleArea.filter((u) => u.def.isToken);
  assert.equal(tokens.length, 2, 'deployed 2 tokens');
  assert.ok(tokens.every((t) => t.rested), 'both tokens deployed rested');
});

test('Over the River and Through the Woods GD03-107: deals damage equal to friendly Unit token count', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5, level: 3 });

  registry.overTheRiverAndThroughTheWoodsCommand(state, player);
  assert.equal(enemy.damage, 0, 'no friendly tokens -- no damage');

  deployUnit(state, player, { number: 'T1', type: 'unit', ap: 1, hp: 1, isToken: true });
  deployUnit(state, player, { number: 'T2', type: 'unit', ap: 1, hp: 1, isToken: true });
  registry.overTheRiverAndThroughTheWoodsCommand(state, player);
  assert.equal(enemy.damage, 2, '2 friendly tokens -- 2 damage');
});

test('How Many Miles to the Battlefield? GD03-108: deploys 1 active Hy-Gogg token', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));

  registry.howManyMilesToTheBattlefieldCommand(state, player);
  const token = player.battleArea.find((u) => u.def.isToken);
  assert.ok(token, 'token deployed');
  assert.equal(token.rested, false, 'deployed active, not rested');
});

test('Eliminate Target GD03-110: destroys a Pilot paired with a Lv.5-or-lower enemy Unit, leaving the Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1, level: 5 });
  const pilotInstance = createInstance({ number: 'P', type: 'pilot', apBonus: 1 }, 1);
  pairPilot(state, opponent, unit, pilotInstance);

  registry.eliminateTargetCommand(state, player);
  assert.equal(unit.pilot, null, 'Pilot unpaired');
  assert.ok(opponent.trash.includes(pilotInstance), 'Pilot sent to trash');
  assert.ok(opponent.battleArea.includes(unit), 'Unit itself stays in play');
});

test('Infiltrator Present GD03-111: chosen friendly (Mafty) Unit gets AP+3 during this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const mafty = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, traits: ['Mafty'] });
  deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });

  registry.infiltratorPresentCommand(state, player);
  assert.equal(getAP(mafty), 4, '(Mafty) Unit -- AP+3');
});

test('Warped Intent GD03-112: all Units paired with a Pilot get AP+2, both sides', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const friendlyPaired = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, friendlyPaired, createInstance({ number: 'P', type: 'pilot' }, 0));
  const friendlyUnpaired = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  const enemyPaired = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, opponent, enemyPaired, createInstance({ number: 'P2', type: 'pilot' }, 1));

  registry.warpedIntentCommand(state, player);
  assert.equal(getAP(friendlyPaired), 3, 'friendly paired Unit -- AP+2');
  assert.equal(getAP(friendlyUnpaired), 1, 'friendly unpaired Unit -- untouched');
  assert.equal(getAP(enemyPaired), 3, 'enemy paired Unit -- AP+2 too, printed text has no side qualifier');
});

test('Human Karma GD03-113: rests the highest-Lv active friendly Unit, then deals 3 damage to an eligible-Lv enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const source = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, level: 4 });
  const tooHigh = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5, level: 5 });
  const eligible = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5, level: 4 });

  registry.humanKarmaCommand(state, player);
  assert.equal(source.rested, true, 'friendly Unit rested as the cost');
  assert.equal(tooHigh.damage, 0, 'higher-Lv enemy than the rested Unit -- untouched');
  assert.equal(eligible.damage, 3, 'Lv <= rested Unit -- 3 damage');
});

test('Look of Determination (R+) GD03-114: destroys an active Lv.2-or-lower enemy, or Lv.4-or-lower with 10+ trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowLv = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 2 });
  const midLv = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 4 });

  registry.lookOfDeterminationCommand(state, player);
  assert.ok(!opponent.battleArea.includes(lowLv), 'Lv.2 enemy destroyed');
  assert.ok(opponent.battleArea.includes(midLv), 'Lv.4 enemy untouched -- trash below 10');

  for (let i = 0; i < 10; i++) player.trash.push({ def: {} });
  registry.lookOfDeterminationCommand(state, player);
  assert.ok(!opponent.battleArea.includes(midLv), '10+ cards in trash -- Lv.4 enemy now a valid target');
});

test('Distant Reunion GD03-115: friendly Unit paired with an (X-Rounder) Pilot ignores battle damage from 2-or-less-AP enemies', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 5 });
  pairPilot(state, player, unit, createInstance({ number: 'P', type: 'pilot', traits: ['X-Rounder'] }, 0));
  const weakAttacker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 5 });
  const strongAttacker = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 3, hp: 5 });

  registry.distantReunionCommand(state, player);
  resolveUnitBattleDamage(state, opponent, player, weakAttacker, unit, {});
  assert.equal(unit.damage, 0, '2 AP enemy -- no battle damage received');

  resolveUnitBattleDamage(state, opponent, player, strongAttacker, unit, {});
  assert.equal(unit.damage, 3, '3 AP enemy -- above the cap, damage still applies');
});

test('Towards Destiny GD03-116: deals 2 damage to a friendly (Vagan) Unit and 1 enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const vagan = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 5, traits: ['Vagan'] });
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5 });

  registry.towardsDestinyCommand(state, player);
  assert.equal(vagan.damage, 2, 'friendly (Vagan) Unit -- 2 damage');
  assert.equal(enemy.damage, 2, 'enemy Unit -- 2 damage');
});
