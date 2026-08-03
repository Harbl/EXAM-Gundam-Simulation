const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getRemainingHP, getKeywords } = require('../src/rules/management');
const { dealEffectDamage, restEnemyByEffect } = require('../src/rules/effects');
const { chooseAttackTarget } = require('../src/ai/heuristic');
const registry = require('../src/effects/registry');

test("Gundam Throne Drei GD04-041: Once per Turn, set active when rested by an opponent's effect", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-041'));

  restEnemyByEffect(state, opponent, player, instance);
  assert.equal(instance.rested, false, "immediately set back active by its own Once per Turn reaction");

  restEnemyByEffect(state, opponent, player, instance);
  assert.equal(instance.rested, true, 'once per turn already used -- stays rested the second time');
});

test('Psycho Gundam (GQ) (U+) GD04-042: During Link, Once per Turn, deals 2 damage on a Cyber-Newtype-paired ally shield kill', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-042'));
  instance.isLinkUnit = true;
  const attacker = deployUnit(state, player, { number: 'U', type: 'unit', ap: 3, hp: 3 });
  const pilot = createInstance({ number: 'P', type: 'pilot', traits: ['Cyber-Newtype'] }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, attacker, pilot);
  const lowAP = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 4, hp: 3 });
  const highAP = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 6, hp: 3 });

  registry.psychoGundamGQUPlusFriendlyUnitDestroysShield(state, player, instance, { attacker });
  assert.equal(getRemainingHP(lowAP), 1, 'AP<=5 enemy takes 2 damage');
  assert.equal(getRemainingHP(highAP), 3, 'AP>5 enemy untouched');

  registry.psychoGundamGQUPlusFriendlyUnitDestroysShield(state, player, instance, { attacker });
  assert.equal(getRemainingHP(lowAP), 1, 'once per turn already used -- second shield kill does nothing');
});

test('Zssa (Sleeves) GD04-043: Deploy deals 1 damage to the enemy Base', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  opponent.base = createInstance({ number: 'B1', type: 'base', ap: 0, hp: 3 }, 1);

  deployUnit(state, player, lookupCard('GD04-043'));
  assert.equal(getRemainingHP(opponent.base), 2, 'enemy Base takes 1 damage');
});

test('Gadeel GD04-044: Attack gains Breach 3 if attacking a damaged enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-044'));
  const freshEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  const damagedEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3 });
  damagedEnemy.damage = 1;

  registry.gadeelAttack(state, player, instance, { target: { type: 'unit', instance: freshEnemy } });
  assert.equal(getKeywords(instance).breach, undefined, 'undamaged target -- no Breach granted');

  registry.gadeelAttack(state, player, instance, { target: { type: 'unit', instance: damagedEnemy } });
  assert.equal(getKeywords(instance).breach, 3, 'damaged target -- gains Breach 3');
});

test('Gundam Throne Zwei GD04-045: When Linked grants a (CB) ally the ability to target a damaged active enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-045'));
  const cbAlly = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 5, traits: ['CB'] });
  const nonCbAlly = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 5, hp: 5 });

  registry.gundamThroneZweiWhenLinked(state, player, instance, {});
  assert.ok(cbAlly.buffs.some((b) => b.activeTargetIfDamaged && b.scope === 'turn'), '(CB) ally gets the grant');
  assert.equal(nonCbAlly.buffs.length, 0, 'non-(CB) ally unaffected');

  const damagedEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 3 });
  damagedEnemy.damage = 1;
  const result = chooseAttackTarget(opponent, cbAlly, false, player);
  assert.equal(result.type, 'unit');
  assert.equal(result.instance, damagedEnemy, 'active but damaged enemy becomes a legal, chosen target');
});

test('Gundam Dynames GD04-046: Deploy may rest itself to deal 2 damage to a Lv<=3 enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowLevel = deployUnit(state, opponent, { number: 'E1', type: 'unit', level: 3, ap: 1, hp: 5 });
  const highLevel = deployUnit(state, opponent, { number: 'E2', type: 'unit', level: 4, ap: 1, hp: 5 });

  const instance = deployUnit(state, player, lookupCard('GD04-046'));
  assert.equal(instance.rested, true, 'paid the optional rest cost since a legal target existed');
  assert.equal(getRemainingHP(lowLevel), 3, 'Lv.3 enemy takes 2 damage');
  assert.equal(getRemainingHP(highLevel), 5, 'Lv.4 enemy untouched (above the level cap)');
});

test('Gundam DX (LR+) GD04-049: During Pair, Attack on the player may exile 7 (Vulture) trash cards to destroy an enemy Unit/Base Lv<=8', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-049'));
  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, instance, pilot);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', level: 8, ap: 1, hp: 5 });

  registry.gundamDXLRPlusAttack(state, player, instance, { target: { type: 'player' } });
  assert.ok(opponent.battleArea.includes(target), 'fewer than 7 (Vulture) cards in trash -- no destroy yet');

  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: `T${i}`, type: 'unit', traits: ['Vulture'] }, 0));
  registry.gundamDXLRPlusAttack(state, player, instance, { target: { type: 'player' } });
  assert.equal(player.trash.length, 0, '7 (Vulture) cards exiled from trash');
  assert.equal(player.removal.length, 7);
  assert.ok(!opponent.battleArea.includes(target), 'enemy Unit destroyed');
});

test('Gundam Airmaster Burst GD04-051: During Pair, once 7+ trash, may target an active enemy Unit with a keyword', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, lookupCard('GD04-051'));
  const pilot = createInstance({ number: 'P', type: 'pilot', traits: ['Vulture'] }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, attacker, pilot);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 3, keywords: { blocker: true } });

  let result = chooseAttackTarget(opponent, attacker, false, player);
  assert.equal(result.type, 'player', 'fewer than 7 trash cards -- active keyword enemy not yet a legal target');

  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: `T${i}`, type: 'unit', traits: ['Vulture'] }, 0));
  result = chooseAttackTarget(opponent, attacker, false, player);
  assert.equal(result.type, 'unit', '7+ trash -- active enemy Unit with a keyword becomes a legal target');
  assert.equal(result.instance, target);
});

test('Gundam Leopard Destroy GD04-052: During Pair, Attack deals 2 damage to a chosen enemy Unit and itself', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-052'));
  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, instance, pilot);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });

  registry.gundamLeopardDestroyAttack(state, player, instance, {});
  assert.equal(getRemainingHP(target), 3, 'enemy Unit takes 2 damage');
  assert.equal(getRemainingHP(instance), 3, 'this Unit also takes 2 damage (5 HP - 2)');
});

test("Rey's Blaze Zaku Phantom GD04-053: During Link, Once per Turn reduces enemy damage by 1", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-053'));

  dealEffectDamage(state, opponent, player, instance, 2);
  assert.equal(getRemainingHP(instance), 1, 'not Linked -- full 2 damage taken');

  instance.damage = 0;
  instance.isLinkUnit = true;
  dealEffectDamage(state, opponent, player, instance, 2);
  assert.equal(getRemainingHP(instance), 2, 'Linked -- reduced by 1 (2 -> 1 taken)');

  dealEffectDamage(state, opponent, player, instance, 1);
  assert.equal(getRemainingHP(instance), 1, 'Once per Turn already used -- no second reduction');
});

test('Gundam Virtue (Trans-Am) GD04-054: instantly destroys any enemy Unit it deals battle damage to', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('GD04-054'));
  const defender = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 20 });

  registry.gundamVirtueTransAmDealsBattleDamage(state, player, unit, { defender });
  assert.equal(getRemainingHP(defender), 0, "damage topped up to lethal regardless of the enemy Unit's real HP");
});

test('chooseAttackTarget sends Gundam Virtue (Trans-Am) after any rested enemy, even a much bigger one, since it force-destroys unconditionally', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('GD04-054'));
  const bigUnit = createInstance({ number: 'BIG', type: 'unit', level: 7, ap: 20, hp: 20 }, 1);
  bigUnit.rested = true;
  opponent.battleArea.push(bigUnit);

  const target = chooseAttackTarget(opponent, unit, false, player);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, bigUnit, 'no level cap or pilot condition on this card -- always an execution target');
});
