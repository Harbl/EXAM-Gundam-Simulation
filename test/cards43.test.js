const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getRemainingHP, getKeywords, getAP } = require('../src/rules/management');
const { effectiveCost } = require('../src/rules/cost');
const { resolveUnitBattleDamage } = require('../src/rules/combat');
const registry = require('../src/effects/registry');

test('Turn A Gundam GD04-073: ActivateMain pays (1) for AP+2 this turn, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-073'));
  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource' }, 0));

  const first = registry.turnAGundamGD04073ActivateMain(state, player, instance);
  assert.equal(first, true, 'activates with an active resource available');
  assert.equal(getAP(instance), 5, 'AP+2 applied (base 3)');
  assert.equal(player.resourceArea[0].rested, true, 'resource spent');
  assert.deepEqual(player.abilityCostsPaidThisTurn, [{ source: instance, amount: 1 }]);

  const second = registry.turnAGundamGD04073ActivateMain(state, player, instance);
  assert.equal(second, false, 'once per turn -- second activation refused');
});

test('Kapool GD04-074: Attack may pay (1) to draw 1 then discard 1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource' }, 0));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  player.hand.push(createInstance({ number: 'H1', type: 'unit' }, 0));

  registry.kapoolAttack(state, player, {}, {});
  assert.equal(player.resourceArea[0].rested, true, 'paid the (1)');
  assert.equal(player.hand.length, 1, 'drew 1 then discarded 1 -- net unchanged');
  assert.equal(player.trash.length, 1, 'discarded card landed in trash');
});

test('Kapool GD04-074: no active resource -- Attack does nothing', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));

  registry.kapoolAttack(state, player, {}, {});
  assert.equal(player.hand.length, 0, 'no resource to pay -- no draw');
});

test('GN-X GD04-075: hand cost reduced by 1 per (UN)/(Superpower Bloc) Command card in trash', () => {
  const player = createPlayer(0);
  const def = lookupCard('GD04-075');
  assert.equal(effectiveCost(player, def), 6, 'no matching cards in trash yet');

  player.trash.push(createInstance({ number: 'C1', type: 'command', traits: ['UN'] }, 0));
  player.trash.push(createInstance({ number: 'C2', type: 'command', traits: ['Superpower Bloc'] }, 0));
  player.trash.push(createInstance({ number: 'C3', type: 'command', traits: ['Zeon'] }, 0));
  assert.equal(effectiveCost(player, def), 4, '2 matching Command cards in trash -- cost -2');
});

test('Alvatore GD04-080: Destroyed deploys a rested Alvaaron token only with another (UN)/(Superpower Bloc) Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  registry.alvatoreDestroyed(state, player);
  assert.equal(player.battleArea.length, 0, 'no other (UN)/(Superpower Bloc) Unit -- no token');

  deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, traits: ['UN'] });
  registry.alvatoreDestroyed(state, player);
  const token = player.battleArea.find((u) => u.def.name === 'Alvaaron');
  assert.ok(token, 'Alvaaron token deployed');
  assert.equal(token.rested, true, 'deployed rested');
  assert.equal(getAP(token), 4);
});

test('Rosamia Badam GD04-082: When Linked deals 1 damage to a rested Unit, preferring an enemy target', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemyRested = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  enemyRested.rested = true;
  const friendlyRested = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 3 });
  friendlyRested.rested = true;

  registry.rosamiaBadamWhenLinked(state, player, {}, {});
  assert.equal(getRemainingHP(enemyRested), 2, 'enemy rested Unit takes the damage');
  assert.equal(getRemainingHP(friendlyRested), 3, 'friendly rested Unit untouched while an enemy option exists');
});

test('Rosamia Badam GD04-082: falls back to a friendly rested Unit when no enemy one is legal', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const friendlyRested = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 3 });
  friendlyRested.rested = true;

  registry.rosamiaBadamWhenLinked(state, player, {}, {});
  assert.equal(getRemainingHP(friendlyRested), 2, 'mandatory choice reaches the only legal (friendly) target');
});

test('Marbet Fingerhat GD04-083: startOfTurn grants AP+1 to all (League Militaire) Unit tokens', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const token = deployUnit(state, player, { number: 'T1', type: 'unit', ap: 2, hp: 2, traits: ['League Militaire'], isToken: true });
  const nonToken = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['League Militaire'] });

  registry.marbetFingerhatStartOfTurn(state, player);
  assert.equal(getAP(token), 3, 'League Militaire token gets AP+1');
  assert.equal(getAP(nonToken), 2, 'non-token League Militaire Unit unaffected');
});

test("Sleggar Law GD04-084: Attack buffs the controller's highest-AP (White Base Team) Unit", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const low = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['White Base Team'] });
  const high = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 4, hp: 2, traits: ['White Base Team'] });

  registry.sleggarLawAttack(state, player);
  assert.equal(getAP(high), 5, 'highest-AP ally gets AP+1');
  assert.equal(getAP(low), 2, 'other ally untouched');
});

test('Suletta Mercury (R+) GD04-085: During Link, once per turn, places a rested EX Resource when an (Academy) Command uses an EX Resource and none remain', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  unit.isLinkUnit = true;
  const command = createInstance({ number: 'C1', type: 'command', traits: ['Academy'] }, 0);

  registry.sulettaMercuryRPlusFriendlyPlaysCommand(state, player, unit, { usedExResource: true, commandInstance: command });
  assert.equal(player.resourceArea.length, 1, 'EX Resource placed');
  assert.equal(player.resourceArea[0].rested, true, 'placed rested');
  assert.equal(unit.activationsUsed.placeExResource, true);

  registry.sulettaMercuryRPlusFriendlyPlaysCommand(state, player, unit, { usedExResource: true, commandInstance: command });
  assert.equal(player.resourceArea.length, 1, 'once per turn -- no second placement');
});

test('Suletta Mercury (R+) GD04-085: no placement without Link, without EX Resource usage, or with EX Resources remaining', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  const command = createInstance({ number: 'C1', type: 'command', traits: ['Academy'] }, 0);

  registry.sulettaMercuryRPlusFriendlyPlaysCommand(state, player, unit, { usedExResource: true, commandInstance: command });
  assert.equal(player.resourceArea.length, 0, 'not a Link Unit -- no placement');

  unit.isLinkUnit = true;
  registry.sulettaMercuryRPlusFriendlyPlaysCommand(state, player, unit, { usedExResource: false, commandInstance: command });
  assert.equal(player.resourceArea.length, 0, 'no EX Resource used -- no placement');
});

test('Garma Zabi GD04-086: a paired Pilot\'s own [Destroyed] fires through real combat destruction (During Link, no EX Resources)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, linkCondition: 'Garma Zabi' });
  const pilot = createInstance(lookupCard('GD04-086'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, attacker, pilot);
  assert.equal(attacker.isLinkUnit, true, 'link condition matched by pilot name');

  const defender = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 1 });
  resolveUnitBattleDamage(state, player, opponent, attacker, defender, {});

  assert.equal(player.resourceArea.length, 1, "the destroyed Unit's paired Pilot's own Destroyed ability fired and placed an EX Resource");
});

test("Elan Ceres (Enhanced Person Number 5) GD04-087: During Link, Attack redirects this battle's return damage to a chosen ally", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, traits: ['Academy'] });
  attacker.isLinkUnit = true;
  const tank = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 10, traits: ['Academy'] });
  const defender = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 5 });

  registry.elanCeresEnhancedPersonAttack(state, player, attacker);
  assert.ok(attacker.buffs.some((b) => b.redirectDamageTarget === tank && b.scope === 'battle'));

  resolveUnitBattleDamage(state, player, opponent, attacker, defender, {});
  assert.equal(getRemainingHP(tank), 5, 'the redirect target takes the 5 return damage instead');
  assert.equal(attacker.damage, 0, 'the attacker itself takes none of its own return damage');
});

test('Deux Murasame GD04-091: a paired Pilot\'s own [Destroyed] deals 1 damage to an undamaged enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  const pilot = createInstance(lookupCard('GD04-091'), 0);
  player.hand.push(pilot);
  pairPilot(state, player, attacker, pilot);

  const undamaged = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 3 });
  const damaged = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 5, hp: 3 });
  damaged.damage = 1;
  const defender = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 5, hp: 1 });

  resolveUnitBattleDamage(state, player, opponent, attacker, defender, {});
  assert.equal(getRemainingHP(undamaged), 2, 'undamaged enemy takes the 1 damage');
  assert.equal(getRemainingHP(damaged), 2, 'already-damaged enemy is not a legal target -- untouched');
});

test('Michael Trinity GD04-092: When Linked deals 1 damage to a damaged enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const undamaged = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  const damaged = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3 });
  damaged.damage = 1;

  registry.michaelTrinityWhenLinked(state, player);
  assert.equal(getRemainingHP(damaged), 1, 'damaged enemy takes the extra 1 damage');
  assert.equal(getRemainingHP(undamaged), 3, 'undamaged enemy is not a legal target -- untouched');
});
