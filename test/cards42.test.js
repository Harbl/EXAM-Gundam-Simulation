const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getRemainingHP, getKeywords, getAP } = require('../src/rules/management');
const { runAttacks } = require('../src/ai/heuristic');
const registry = require('../src/effects/registry');

test('Sword Impulse Gundam GD04-056: Deploy deals 1 damage to itself, then rests a low-AP enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowAP = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 3 });
  const highAP = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 4, hp: 3 });

  const instance = deployUnit(state, player, lookupCard('GD04-056'));
  assert.equal(getRemainingHP(instance), 2, 'self-damages for 1');
  assert.equal(lowAP.rested, true, 'AP<=3 enemy gets rested');
  assert.equal(highAP.rested, false, 'AP>3 enemy untouched');
});

test('Gundam Nadleeh GD04-057: Deploy reduces a Lv<=6 enemy Unit\'s AP by the number of "Gundam Virtue" cards in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', level: 6, ap: 5, hp: 5 });

  deployUnit(state, player, lookupCard('GD04-057'));
  assert.equal(getAP(target), 5, 'no Gundam Virtue cards in trash yet -- no reduction');

  player.trash.push(createInstance({ number: 'GV1', name: 'Gundam Virtue (R+)', type: 'unit' }, 0));
  player.trash.push(createInstance({ number: 'GV2', name: 'Gundam Virtue (Trans-Am)', type: 'unit' }, 0));
  target.buffs = [];
  registry.gundamNadleehDeploy(state, player, { def: lookupCard('GD04-057') }, {});
  assert.equal(getAP(target), 3, '2 Gundam Virtue cards in trash -- AP-2');
});

test("Jamil's Gundam X GD04-058: During Pair(Vulture), Destroyed on your turn returns the paired Pilot to hand", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-058'));
  const pilot = createInstance({ number: 'P', type: 'pilot', traits: ['Vulture'] }, 0);
  player.hand.push(pilot);
  pairPilot(state, player, instance, pilot);
  player.trash.push(pilot);

  registry.jamilsGundamXDestroyed(state, player, instance, { pilot });
  assert.ok(player.hand.includes(pilot), "Vulture-paired pilot returns to hand on the controller's turn");
});

test("Jamil's Gundam X GD04-058: no return without a (Vulture) paired Pilot", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-058'));
  const pilot = createInstance({ number: 'P2', type: 'pilot', traits: ['Old UNE'] }, 0);
  player.trash.push(pilot);

  registry.jamilsGundamXDestroyed(state, player, instance, { pilot });
  assert.ok(!player.hand.includes(pilot), 'non-(Vulture) pilot stays in trash');
});

test('Esperansa GD04-060: Deploy draws 1 only when deployed from trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit', ap: 1, hp: 1 }, 0));

  deployUnit(state, player, lookupCard('GD04-060'));
  assert.equal(player.hand.length, 0, 'deployed from hand -- no draw');

  deployUnit(state, player, lookupCard('GD04-060'), undefined, { fromTrash: true });
  assert.equal(player.hand.length, 1, 'deployed from trash -- draws 1');
});

test("G-Falcon GD04-061: can't attack while 6 or fewer cards are in the controller's trash", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-061'));
  instance.isLinkUnit = true;
  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });

  runAttacks(state, 0, {});
  assert.equal(instance.rested, false, '6 or fewer trash cards -- can\'t attack, stays active');

  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: `T${i}`, type: 'unit' }, 0));
  runAttacks(state, 0, {});
  assert.equal(instance.rested, true, '7+ trash cards -- attacks normally');
});

test('GN Armor Type-E GD04-063: Deploy destroys a Lv<=1 or AP<=1 enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weak = deployUnit(state, opponent, { number: 'E1', type: 'unit', level: 1, ap: 3, hp: 5 });
  const strong = deployUnit(state, opponent, { number: 'E2', type: 'unit', level: 3, ap: 3, hp: 5 });

  deployUnit(state, player, lookupCard('GD04-063'));
  assert.ok(!opponent.battleArea.includes(weak), 'Lv<=1 enemy destroyed regardless of remaining HP');
  assert.ok(opponent.battleArea.includes(strong), 'Lv>1 AP>1 enemy untouched');
});

test("Unicorn Gundam (Awakened) (LR+) GD04-066: reacts to activating a Command's effect with an enemy AP-2", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-066'));
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 5 });

  registry.unicornGundamAwakenedLRPlusFriendlyPlaysCommand(state, player, instance, {});
  assert.equal(getAP(target), 3, 'enemy Unit gets AP-2 during this turn');
});

test('Turn A Gundam (LR+) GD04-067: Activate Main, Once per Turn, (1) copies keywords + AP+1 from a trash Unit card', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-067'));
  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource' }, 0));
  const trashUnit = createInstance({ number: 'TU1', type: 'unit', keywords: { blocker: true, repair: 2 } }, 0);
  player.trash.push(trashUnit);

  const result = registry.turnAGundamLRPlusActivateMain(state, player, instance, { target: trashUnit });
  assert.equal(result, true);
  assert.equal(getAP(instance), 5, 'AP+1 applied (base 4 -> 5)');
  assert.equal(getKeywords(instance).blocker, true, 'Blocker copied');
  assert.equal(instance.buffs.some((b) => b.repair === 2), true, 'Repair 2 copied');
  assert.equal(player.abilityCostsPaidThisTurn.length, 1, 'records the (1) resource payment for GD04-069 to observe');

  const second = registry.turnAGundamLRPlusActivateMain(state, player, instance, { target: trashUnit });
  assert.equal(second, false, 'Once per Turn already used');
});

test("Turn A Gundam GD04-069: During Link, at end of turn sets a (Militia) Unit active if (1)+ was paid for another Militia/Dianna Counter Unit's effect", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-069'));
  instance.isLinkUnit = true;
  const militiaAlly = deployUnit(state, player, { number: 'M1', type: 'unit', ap: 2, hp: 2, traits: ['Militia'] });
  militiaAlly.rested = true;
  const otherMilitiaUnit = deployUnit(state, player, { number: 'M2', type: 'unit', ap: 3, hp: 3, traits: ['Militia'] });

  registry.turnAGundamGD04069EndOfTurn(state, player, instance, {});
  assert.equal(militiaAlly.rested, true, 'nothing paid this turn -- no effect');

  player.abilityCostsPaidThisTurn = [{ source: otherMilitiaUnit, amount: 1 }];
  registry.turnAGundamGD04069EndOfTurn(state, player, instance, {});
  assert.equal(militiaAlly.rested, false, '(1)+ paid for another Militia Unit\'s effect -- sets a Militia Unit active');
});

test("Al-Saachez's AEU Enact Custom Moralia GD04-070: Deploy may pair an \"Ali al-Saachez\" Pilot from hand", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const pilot = createInstance({ number: 'P', type: 'pilot', name: 'Ali alSaachez' }, 0);
  player.hand.push(pilot);

  const instance = deployUnit(state, player, lookupCard('GD04-070'));
  assert.equal(instance.pilot, pilot, 'named Pilot auto-pairs from hand on Deploy');
});

test("Graham's Union Flag Custom II (GN Flag) (R+) GD04-071: Burst adds itself to hand only if an enemy (CB) Unit is in play", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const shield = createInstance(lookupCard('GD04-071'), 0);

  registry.grahamsUnionFlagGNFlagRPlusBurst(state, player, shield);
  assert.ok(!player.hand.includes(shield), 'no enemy (CB) Unit in play -- stays put');

  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, traits: ['CB'] });
  registry.grahamsUnionFlagGNFlagRPlusBurst(state, player, shield);
  assert.ok(player.hand.includes(shield), 'enemy (CB) Unit in play -- added to hand');
});

test("Graham's Union Flag Custom II (GN Flag) (R+) GD04-071: Activate Main exiles a (Superpower Bloc) + a (UN) trash card to set active", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-071'));
  instance.rested = true;

  const result1 = registry.grahamsUnionFlagGNFlagRPlusActivateMain(state, player, instance);
  assert.equal(result1, false, 'missing either trait in trash -- no effect');

  player.trash.push(createInstance({ number: 'SB1', type: 'unit', traits: ['Superpower Bloc'] }, 0));
  player.trash.push(createInstance({ number: 'UN1', type: 'unit', traits: ['UN'] }, 0));
  const result2 = registry.grahamsUnionFlagGNFlagRPlusActivateMain(state, player, instance);
  assert.equal(result2, true);
  assert.equal(player.trash.length, 0, 'both cards exiled out of trash');
  assert.equal(player.removal.length, 2);
  assert.equal(instance.rested, false, 'set active');
  assert.ok(instance.buffs.some((b) => b.cannotAttack), "can't attack during this turn");
});

test('Unicorn Gundam 02 Banshee Norn (Unicorn Mode) GD04-072: When Linked bounces a 3-or-less-HP enemy Unit to hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, lookupCard('GD04-072'));
  const lowHP = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  const highHP = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5 });

  registry.unicornGundam02BansheeNornWhenLinked(state, player, instance, {});
  assert.ok(opponent.hand.includes(lowHP), 'HP<=3 enemy Unit returned to hand');
  assert.ok(opponent.battleArea.includes(highHP), 'HP>3 enemy Unit untouched');
});
