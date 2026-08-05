const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { canAfford, payCost } = require('../src/rules/cost');
const { placeExResource } = require('../src/rules/effects');
const { chooseAttackTarget } = require('../src/ai/heuristic');

function resource() {
  return createInstance({ number: 'RESOURCE', name: 'Resource', type: 'resource' }, 0);
}

test('Full Armor Unicorn Gundam (Unicorn Mode) GD03-016 is vanilla (Lv5/cost3/5AP/4HP)', () => {
  const def = lookupCard('GD03-016');
  assert.equal(def.level, 5);
  assert.equal(def.cost, 3);
  assert.equal(def.ap, 5);
  assert.equal(def.hp, 4);
  assert.equal(def.effectRefs, undefined);
});

test('Gundam AGE-2 Normal (LR+) GD03-019: During Pair taunt forces enemies to attack it while rested, and When Linked places 1 EX Resource', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const age2 = deployUnit(state, player, lookupCard('GD03-019'));
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 3, hp: 3 });

  age2.rested = true;
  assert.notEqual(chooseAttackTarget(player, attacker).instance, age2, 'unpaired -- taunt is inactive');

  const before = player.resourceArea.length;
  pairPilot(state, player, age2, createInstance({ number: 'P', name: 'Asemu Asuno', type: 'pilot' }, 0));
  assert.equal(player.resourceArea.length, before + 1, 'When Linked placed 1 EX Resource');

  age2.rested = true;
  const target = chooseAttackTarget(player, attacker);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, age2, 'paired and rested -- enemies must choose it as their attack target');
});

test('Zaku II FZ (R+) GD03-020: When Paired deploys 2 rested Ad Balloon tokens only at 4+ (Cyclops Team) trash cards, and grants battle-damage immunity while one is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 3; i++) player.trash.push(createInstance({ number: 'C' + i, type: 'unit', traits: ['Cyclops Team'] }, 0));
  const zaku = deployUnit(state, player, lookupCard('GD03-020'));
  pairPilot(state, player, zaku, createInstance({ number: 'P1', name: 'Bernard Wiseman', type: 'pilot' }, 0));
  assert.equal(player.battleArea.length, 1, 'fewer than 4 (Cyclops Team) cards in trash -- no tokens');

  player.trash.push(createInstance({ number: 'C3', type: 'unit', traits: ['Cyclops Team'] }, 0));
  const zaku2 = deployUnit(state, player, lookupCard('GD03-020'));
  pairPilot(state, player, zaku2, createInstance({ number: 'P2', name: 'Bernard Wiseman', type: 'pilot' }, 0));
  const tokens = player.battleArea.filter((u) => u.def.name === 'Ad Balloon');
  assert.equal(tokens.length, 2);
  assert.ok(tokens.every((t) => t.rested && t.def.cannotBeSetActive));

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 5, hp: 5 });
  resolveAttack(state, 1, enemy, { type: 'unit', instance: zaku2 });
  assert.equal(zaku2.damage, 0, "can't receive enemy battle damage while an Ad Balloon token is in play");
});

test('Gundam Deathscythe Hell GD03-021 Deploy lets an (Operation Meteor)/(G Team) Unit target an active enemy Unit this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 10, hp: 10, traits: ['G Team'] });
  const activeEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 3 });
  activeEnemy.rested = false;

  assert.notEqual(chooseAttackTarget(opponent, ally).type, 'unit', 'without the grant, an active enemy is not a legal target');

  deployUnit(state, player, lookupCard('GD03-021'));
  const target = chooseAttackTarget(opponent, ally);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, activeEnemy, 'the grant lets it choose the active enemy Unit');
});

test('Gundam Kyrios (R+) GD03-022: During Link, destroying an enemy with battle damage deals 1 damage to all enemy Units Lv.3 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { gundamKyriosRPlusDestroysEnemy } = require('../src/effects/registry');
  const kyrios = deployUnit(state, player, lookupCard('GD03-022'));
  const lowLv = deployUnit(state, opponent, { number: 'L', type: 'unit', ap: 1, hp: 5, level: 2 });
  const highLv = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 1, hp: 5, level: 5 });

  gundamKyriosRPlusDestroysEnemy(state, player, kyrios);
  assert.equal(lowLv.damage, 0, 'not a Link Unit yet -- no effect');

  kyrios.isLinkUnit = true;
  gundamKyriosRPlusDestroysEnemy(state, player, kyrios);
  assert.equal(lowLv.damage, 1, 'Lv.2 enemy takes 1 damage');
  assert.equal(highLv.damage, 0, 'Lv.5 enemy is above the Lv.3 threshold');
});

test('G-Bouncer GD03-023: placing an EX Resource lets an (AGE System) Unit gain <High-Maneuver> for the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const ageUnit = deployUnit(state, player, { number: 'A', type: 'unit', ap: 2, hp: 2, traits: ['AGE System'] });
  deployUnit(state, player, lookupCard('GD03-023'));

  placeExResource(state, player);
  assert.equal(getKeywords(ageUnit).highManeuver, true);
});

test("Auda's Maganac GD03-028 gets AP+2 during this battle only when attacking a Unit, not the player", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { audasManganacAttack } = require('../src/effects/registry');
  const unit = deployUnit(state, player, lookupCard('GD03-028'));
  const baseAP = getAP(unit);

  audasManganacAttack(state, player, unit, { target: { type: 'player' } });
  assert.equal(getAP(unit), baseAP, 'attacking the player -- no bonus');

  audasManganacAttack(state, player, unit, { target: { type: 'unit' } });
  assert.equal(getAP(unit), baseAP + 2, 'attacking a Unit -- AP+2');
});

test('Gundam Heavyarms Custom GD03-029: destroying an enemy with battle damage deals 2 damage to all enemy Units with <Blocker>', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { gundamHeavyarmsCustomDestroysEnemy } = require('../src/effects/registry');
  const blocker = deployUnit(state, opponent, { number: 'B', type: 'unit', ap: 1, hp: 5, keywords: { blocker: true } });
  const plain = deployUnit(state, opponent, { number: 'P', type: 'unit', ap: 1, hp: 5 });

  gundamHeavyarmsCustomDestroysEnemy(state, player);
  assert.equal(blocker.damage, 2);
  assert.equal(plain.damage, 0);
});

test('Gundam Kyrios (Tail Unit Flight Mode) GD03-030: hand cost is 3 normally, drops to 2 while a (CB) Link Unit is in play', () => {
  const player = createPlayer(0);
  const def = lookupCard('GD03-030'); // Lv.3, cost 3
  player.resourceArea.push(resource(), resource(), resource());
  player.resourceArea[2].rested = true; // 2 active, satisfies Lv.3

  const cbUnit = { def: { traits: ['CB'] }, isLinkUnit: false };
  player.battleArea.push(cbUnit);
  assert.equal(canAfford(player, def), false, '(CB) Unit present but not a Link Unit -- full cost of 3, not payable by 2 active');

  cbUnit.isLinkUnit = true;
  assert.equal(canAfford(player, def), true, '(CB) Link Unit in play drops the cost to 2, payable by 2 active');
});

test('Gundam AGE-1 Flat GD03-031 is vanilla (Lv4/cost2/4AP/3HP)', () => {
  const def = lookupCard('GD03-031');
  assert.equal(def.level, 4);
  assert.equal(def.cost, 2);
  assert.equal(def.ap, 4);
  assert.equal(def.hp, 3);
  assert.equal(def.effectRefs, undefined);
});

test('Providence Gundam (LR+) GD03-033: During Pair (ZAFT) Pilot buffs all (ZAFT) Units AP+2 during your turn; Attack deals 1 damage per 4 AP to a chosen enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { providenceGundamLRStartOfTurn, providenceGundamLRAttack } = require('../src/effects/registry');
  const providence = deployUnit(state, player, lookupCard('GD03-033'));
  const zaftAlly = deployUnit(state, player, { number: 'Z', type: 'unit', ap: 2, hp: 2, traits: ['ZAFT'] });
  const otherAlly = deployUnit(state, player, { number: 'O', type: 'unit', ap: 2, hp: 2, traits: ['G Team'] });

  providence.pilot = createInstance({ number: 'P', name: 'Rau', type: 'pilot', traits: ['Earth Federation'] }, 0);
  providenceGundamLRStartOfTurn(state, player, providence);
  assert.equal(getAP(zaftAlly), 2, 'paired Pilot is not (ZAFT) -- no buff');

  providence.pilot = createInstance({ number: 'P2', name: 'Rau Le Creuset', type: 'pilot', traits: ['ZAFT'] }, 0);
  providenceGundamLRStartOfTurn(state, player, providence);
  assert.equal(getAP(zaftAlly), 4, '(ZAFT) Pilot paired -- all (ZAFT) Units get AP+2');
  assert.equal(getAP(otherAlly), 2, 'non-(ZAFT) Unit is unaffected');

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 10 });
  providenceGundamLRAttack(state, player, providence, {});
  assert.equal(enemy.damage, Math.floor(getAP(providence) / 4));
});

test('Xi Gundam (Flight Form) (R+) GD03-036 When Linked deals 1 damage to all enemy Units', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const xi = deployUnit(state, player, lookupCard('GD03-036'));
  const e1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  const e2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5 });

  pairPilot(state, player, xi, createInstance({ number: 'P', name: 'Hathaway Noa', type: 'pilot' }, 0));
  assert.equal(e1.damage, 1);
  assert.equal(e2.damage, 1);
});
