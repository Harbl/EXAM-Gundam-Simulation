const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, playCommand } = require('../src/rules/actions');
const { getRemainingHP, getAP, dealDamage } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { dealEffectDamage, placeExResource, payAbilityCost } = require('../src/rules/effects');
const registry = require('../src/effects/registry');

test('Trinity GD04-111: [Main] buffs 1 to 3 friendly (CB) Units AP+2, ignores non-CB Units', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const a = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, traits: ['CB'] });
  const b = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 1, traits: ['CB'] });
  const c = deployUnit(state, player, { number: 'U3', type: 'unit', ap: 3, hp: 1, traits: ['CB'] });
  const notCB = deployUnit(state, player, { number: 'U4', type: 'unit', ap: 1, hp: 1 });

  registry.trinityCommand(state, player, {}, {});
  assert.equal(getAP(a), 3);
  assert.equal(getAP(b), 4);
  assert.equal(getAP(c), 5, 'default slice caps at 3, so the 3 highest-AP CB Units are chosen');
  assert.equal(getAP(notCB), 1, 'non-CB Unit untouched');
});

test('Inspector GD04-112: [Main] deals 1 damage to all Lv.2-or-lower Units on BOTH sides', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const friendlyLow = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 2, level: 1 });
  const friendlyHigh = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 2, level: 5 });
  const enemyLow = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 2, level: 2 });

  registry.inspectorCommand(state, player);
  assert.equal(getRemainingHP(friendlyLow), 1, 'own low-level Unit is hit too');
  assert.equal(getRemainingHP(friendlyHigh), 2, 'high-level Unit unaffected');
  assert.equal(getRemainingHP(enemyLow), 1, 'enemy low-level Unit hit');
});

test('Damage Control GD04-113: Burst debuffs the strongest enemy AP-2; Action grants a battle-scoped damageReduction 3', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weakEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 5 });
  const strongEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 4, hp: 5 });
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 5 });

  registry.damageControlBurst(state, player);
  assert.equal(getAP(strongEnemy), 2, 'highest-AP enemy debuffed by 2');
  assert.equal(getAP(weakEnemy), 2, 'untouched');

  registry.damageControlCommand(state, player);
  assert.ok(unit.buffs.some((b) => b.damageReduction === 3 && b.scope === 'battle'));
});

test('Reformationist (U+) GD04-114: Burst returns a "Trans-Am"-named Unit card from trash to hand, ignoring non-matching cards', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const transAmUnit = createInstance({ number: 'T1', type: 'unit', name: 'GN Armor Type-D (Trans-Am)', cost: 2 }, 0);
  const plainUnit = createInstance({ number: 'T2', type: 'unit', name: 'Plain Unit', cost: 5 }, 0);
  player.trash.push(plainUnit, transAmUnit);

  registry.reformationistUPlusBurst(state, player);
  assert.ok(player.hand.includes(transAmUnit));
  assert.equal(player.trash.includes(transAmUnit), false);
  assert.equal(player.trash.includes(plainUnit), true, 'non-matching card left in trash');
});

test('Reformationist (U+) GD04-114: command deals 1 damage to 1 of your Units and 1 enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const friendly = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 3 });
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });

  registry.reformationistUPlusCommand(state, player, {}, {});
  assert.equal(getRemainingHP(friendly), 2);
  assert.equal(getRemainingHP(enemy), 2);
});

test('Backup GD04-115: Burst pings the weakest enemy for 1; command grants an execute-on-battle-damage buff that fires through real combat', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weakEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });
  const toughEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 10, hp: 10 });

  registry.backupBurst(state, player);
  assert.equal(getRemainingHP(weakEnemy), 0);
  assert.equal(player.trash.length, 0, "destroyAndFireEffect hasn't run yet in this isolated call");

  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 10, level: 3 });
  registry.backupCommand(state, player);
  assert.ok(attacker.buffs.some((b) => b.executeEnemyLevelCap === 5));

  resolveAttack(state, 0, attacker, { type: 'unit', instance: toughEnemy });
  assert.equal(opponent.battleArea.includes(toughEnemy), false, 'Lv.3-or-lower enemy destroyed outright despite only 1 AP of real damage dealt');
});

test('Reliable Big Brother GD04-116: mills 2, counts (Minerva Squad) cards among them, damages the weakest AP<=4 enemy by that count', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck = [
    createInstance({ number: 'D1', type: 'unit', traits: ['Minerva Squad'] }, 0),
    createInstance({ number: 'D2', type: 'unit', traits: ['Minerva Squad'] }, 0),
    createInstance({ number: 'D3', type: 'unit' }, 0)
  ];
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 4, hp: 5 });
  const tooStrong = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 5, hp: 5 });

  registry.reliableBigBrotherCommand(state, player);
  assert.equal(player.trash.length, 2, 'both milled cards land in trash');
  assert.equal(player.deck.length, 1);
  assert.equal(getRemainingHP(target), 3, 'took 2 damage, 1 per milled (Minerva Squad) card');
  assert.equal(getRemainingHP(tooStrong), 5, 'AP 5 enemy is not a legal target');
});

test('World Distortion GD04-118: only fires with 2+ friendly (UN) Units in play, bounces a low-HP enemy to hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 5 });

  deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, traits: ['UN'] });
  registry.worldDistortionCommand(state, player);
  assert.equal(opponent.battleArea.includes(target), true, 'only 1 (UN) Unit in play -- condition not met');

  deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['UN'] });
  registry.worldDistortionCommand(state, player);
  assert.equal(opponent.battleArea.includes(target), false);
  assert.equal(opponent.hand.includes(target), true);
});

test('Fighting Alone GD04-119: grants a Newtype-paired ally immunity to non-Command enemy effect damage for the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const newtypePilot = createInstance({ number: 'P1', type: 'pilot', traits: ['Newtype'] }, 0);
  const protectedUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 5 });
  protectedUnit.pilot = newtypePilot;
  const unprotected = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 5 });

  registry.fightingAloneCommand(state, player);
  assert.ok(protectedUnit.buffs.some((b) => b.immuneToNonCommandEnemyEffectDamage));

  dealEffectDamage(state, opponent, player, protectedUnit, 3);
  assert.equal(protectedUnit.damage, 0, 'blocked -- non-Command enemy effect damage');
  dealEffectDamage(state, opponent, player, unprotected, 3);
  assert.equal(unprotected.damage, 3, 'unprotected ally still takes it');

  state.resolvingCommand = true;
  dealEffectDamage(state, opponent, player, protectedUnit, 2);
  state.resolvingCommand = false;
  assert.equal(protectedUnit.damage, 2, "an enemy Command's damage still gets through -- the immunity is Unit-sourced damage only");
});

test('Machine Doll Squad GD04-120: buffs the strongest (Militia)/(Dianna Counter) friendly Unit AP+2', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const militia = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 1, traits: ['Militia'] });
  const diannaCounter = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 3, hp: 1, traits: ['Dianna Counter'] });
  deployUnit(state, player, { number: 'U3', type: 'unit', ap: 5, hp: 1 });

  registry.machineDollSquadCommand(state, player);
  assert.equal(getAP(diannaCounter), 5, 'higher-AP qualifying Unit chosen over Militia');
  assert.equal(getAP(militia), 2, 'not chosen');
});

test('A Baoa Qu GD04-123: while a rested (Zeon) Unit is in play, the Base is immune to battle damage from Lv.4-or-lower enemies, INCLUDING token attackers', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const base = deployBase(state, player, {
    number: 'B1', type: 'base', ap: 0, hp: 5,
    lowLevelDamageImmuneCap: 4, lowLevelDamageImmuneTrait: 'Zeon', lowLevelDamageImmuneIncludesTokens: true
  });
  const restedZeon = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, traits: ['Zeon'] });
  restedZeon.rested = true;
  const tokenAttacker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 2, isToken: true });

  resolveAttack(state, 1, tokenAttacker, { type: 'player' });
  assert.equal(getRemainingHP(base), 5, 'immune even to a token attacker, unlike Ptolemaios ST07-015\'s default');

  restedZeon.rested = false;
  const strongAttacker = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 3, hp: 3, level: 2 });
  resolveAttack(state, 1, strongAttacker, { type: 'player' });
  assert.equal(getRemainingHP(base), 2, 'no rested (Zeon) Unit -- immunity lapses');
});

test('9th Tactical Testing Sector GD04-124: when you place an EX Resource, buffs your strongest (Academy) Unit AP+2 -- a Base-granted consumer of the placesExResource broadcast', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployBase(state, player, { number: 'B1', type: 'base', ap: 0, hp: 5, effects: { placesExResource: registry.ninthTacticalTestingSectorPlacesExResource } });
  const academyUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, traits: ['Academy'] });

  placeExResource(state, player);
  assert.equal(getAP(academyUnit), 3, 'the broadcast reached the Base-granted handler, not just battleArea Units');
});

test('Trinity Warship GD04-125: (1) + rest a friendly (CB) Unit deals 1 damage to a Lv.5-or-lower enemy, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const base = deployBase(state, player, { number: 'B1', type: 'base', ap: 0, hp: 5 });
  base.activationsUsed = {};
  placeExResource(state, player);
  const cbUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, traits: ['CB'] });
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3, level: 5 });

  const fired = registry.trinityWarshipActivateMain(state, player, base, { restUnit: cbUnit, target });
  assert.equal(fired, true);
  assert.equal(cbUnit.rested, true);
  assert.equal(player.resourceArea[0].rested, true);
  assert.equal(getRemainingHP(target), 2);

  const again = registry.trinityWarshipActivateMain(state, player, base, { restUnit: cbUnit, target });
  assert.equal(again, false, 'once per turn');
});

test('Izuma Colony GD04-126: retaliates for 1 damage against a Lv.3-or-less-AP enemy that battle-damages this Base, fired through real combat', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployBase(state, player, {
    number: 'B1', type: 'base', ap: 0, hp: 5,
    effects: { receivesBattleDamageFromEnemy: registry.izumaColonyReceivesBattleDamageFromEnemy }
  });
  const weakAttacker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 2 });
  const strongAttacker = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 4, hp: 2 });

  resolveAttack(state, 1, weakAttacker, { type: 'player' });
  assert.equal(getRemainingHP(weakAttacker), 1, 'retaliation hit -- AP 3 qualifies');

  resolveAttack(state, 1, strongAttacker, { type: 'player' });
  assert.equal(getRemainingHP(strongAttacker), 2, 'AP 4 does not qualify for retaliation');
});

test('Freeden II GD04-127: Deploy adds a Shield to hand, then destroys a low-AP enemy only with 7+ (Vulture) cards in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields = [createInstance({ number: 'S1', type: 'unit' }, 0)];
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 5 });

  registry.freedenIIDeploy(state, player);
  assert.equal(player.hand.length, 1, 'shield added regardless');
  assert.equal(opponent.battleArea.includes(target), true, 'not enough (Vulture) cards in trash yet');

  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: `V${i}`, type: 'unit', traits: ['Vulture'] }, 0));
  registry.freedenIIDeploy(state, player);
  assert.equal(opponent.battleArea.includes(target), false, 'destroyed outright once the trash threshold is met');
});

test('Armory One GD04-128: Destroyed makes ALL players draw 1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck = [createInstance({ number: 'D1', type: 'unit' }, 0)];
  opponent.deck = [createInstance({ number: 'D2', type: 'unit' }, 0)];

  registry.armoryOneDestroyed(state);
  assert.equal(player.hand.length, 1);
  assert.equal(opponent.hand.length, 1);
});

test('Willgem GD04-129: Deploy adds a Shield then self-damages 3; recovers 2 HP once per turn when you pay for a friendly Unit\'s effect, via the real broadcast reaching a Base', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields = [createInstance({ number: 'S1', type: 'unit' }, 0)];
  const base = deployBase(state, player, {
    number: 'B1', type: 'base', ap: 0, hp: 7,
    effects: { friendlyPaysAbilityCost: registry.willgemFriendlyPaysAbilityCost }
  });

  registry.willgemDeploy(state, player, base);
  assert.equal(player.hand.length, 1);
  assert.equal(base.damage, 3);

  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  payAbilityCost(state, player, unit, 1);
  assert.equal(base.damage, 1, 'recovered 2 HP through the real payAbilityCost broadcast (3 - 2 = 1)');

  payAbilityCost(state, player, unit, 1);
  assert.equal(base.damage, 1, 'once per turn -- no further recovery this turn');
});

test('Industrial 7 GD04-130: exiles a Command card from trash to debuff an enemy Unit AP-1, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const base = deployBase(state, player, { number: 'B1', type: 'base', ap: 0, hp: 5 });
  base.activationsUsed = {};
  const command = createInstance({ number: 'C1', type: 'command' }, 0);
  player.trash.push(command);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });

  const fired = registry.industrial7ActivateMain(state, player, base, { target });
  assert.equal(fired, true);
  assert.equal(player.trash.includes(command), false);
  assert.ok(player.removal.includes(command));
  assert.equal(getAP(target), 2);

  const again = registry.industrial7ActivateMain(state, player, base, { target });
  assert.equal(again, false, 'once per turn');
});
