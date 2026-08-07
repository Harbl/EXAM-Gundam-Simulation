const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { resolveAttack } = require('../src/rules/combat');
const { lookupCard } = require('../src/cards/index');
const registry = require('../src/effects/registry');

test('Build Strike Gundam (Full Package) (EX) EB01-021: When Paired places a rested Resource, gated on a (G Generation) Pilot and 2+ (G Generation) trash cards', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 4 });
  const nonGGenPilot = createInstance({ number: 'P1', type: 'pilot', name: 'X', apBonus: 1, hpBonus: 1 }, 0);
  registry.buildStrikeGundamFullPackageEXWhenPaired(state, player, unit, { pilot: nonGGenPilot });
  assert.equal(player.resourceArea.length, 0, 'non-(G Generation) pilot: no effect');

  player.resourceDeck.push(createInstance({ number: 'R1', type: 'resource' }, 0));
  const ggenPilot = createInstance({ number: 'P2', type: 'pilot', name: 'Y', traits: ['G Generation'] }, 0);
  registry.buildStrikeGundamFullPackageEXWhenPaired(state, player, unit, { pilot: ggenPilot });
  assert.equal(player.resourceArea.length, 0, 'fewer than 2 (G Generation) trash cards: no effect');

  player.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['G Generation'] }, 0));
  player.trash.push(createInstance({ number: 'T2', type: 'unit', traits: ['G Generation'] }, 0));
  registry.buildStrikeGundamFullPackageEXWhenPaired(state, player, unit, { pilot: ggenPilot });
  assert.equal(player.resourceArea.length, 1);
  assert.equal(player.resourceArea[0].rested, true);
});

test('Gundam Exia (EX) EB01-022: endOfTurn may destroy itself (During Pair (G Generation) Pilot) to deploy 3 tokens', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 6, hp: 5 });
  registry.gundamExiaEXEndOfTurn(state, player, instance);
  assert.equal(player.battleArea.includes(instance), true, 'no pilot: no effect');

  const pilot = createInstance({ number: 'P1', type: 'pilot', name: 'X', traits: ['G Generation'] }, 0);
  pairPilot(state, player, instance, pilot);
  registry.gundamExiaEXEndOfTurn(state, player, instance);
  assert.equal(player.battleArea.includes(instance), false);
  assert.equal(player.battleArea.filter((u) => u.def.number === 'TOKEN-GUNDAM-EXIA').length, 3);
});

test("Le Cygne (EX) EB01-023: Attack lets both players hit Lv.5+ off the top of their deck", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit', level: 5 }, 0));
  opponent.deck.push(createInstance({ number: 'D2', type: 'unit', level: 2 }, 1));

  registry.leCygneEXAttack(state, player);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true);
  assert.equal(opponent.hand.length, 0, 'Lv.2 top card stays on the deck');
  assert.equal(opponent.deck.length, 1);
});

test('GQuuuuuuX (Omega Psycommu) EB01-024: Attack deals 2 to a Blocker enemy that is Lv.5 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooHigh = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 5, level: 6, keywords: { blocker: true } });
  const eligible = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3, level: 5, keywords: { blocker: true } });
  registry.gQuuuuuuXOmegaPsycommuAttack(state, player);
  assert.equal(tooHigh.damage, 0);
  assert.equal(eligible.damage, 2);
});

test('Tallgeese II EB01-025: Deploy exiles 2 (G Generation) trash cards so both players place an EX Resource', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  registry.tallgeeseIIDeploy(state, player);
  assert.equal(player.resourceArea.length, 0);

  player.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['G Generation'] }, 0));
  player.trash.push(createInstance({ number: 'T2', type: 'unit', traits: ['G Generation'] }, 0));
  registry.tallgeeseIIDeploy(state, player);
  assert.equal(player.resourceArea.length, 1);
  assert.equal(opponent.resourceArea.length, 1);
  assert.equal(player.trash.length, 0);
});

test('Tallgeese II EB01-025: During Pair immunity blocks Lv.5- battle damage only while the opponent has an EX Resource', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tallgeeseII = deployUnit(state, player, lookupCard('EB01-025'));
  pairPilot(state, player, tallgeeseII, createInstance({ number: 'P1', type: 'pilot', name: 'X', apBonus: 0, hpBonus: 0 }, 0));
  const attacker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 4 });

  resolveAttack(state, 1, attacker, { type: 'unit', instance: tallgeeseII }, {});
  assert.equal(tallgeeseII.damage, 3, 'no EX Resource: normal damage');

  tallgeeseII.damage = 0;
  attacker.rested = false;
  opponent.resourceArea.push(createInstance({ number: 'EX-RESOURCE', type: 'resource', isToken: true }, 1));
  resolveAttack(state, 1, attacker, { type: 'unit', instance: tallgeeseII }, {});
  assert.equal(tallgeeseII.damage, 0, 'opponent has EX Resource: immune to this Lv.4 attacker');
});

test('Tallgeese EB01-027: Deploy exiles 2 (G Generation) trash cards to grant Breach 1 to a friendly (G Generation) Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 3, traits: ['G Generation'] });
  player.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['G Generation'] }, 0));
  player.trash.push(createInstance({ number: 'T2', type: 'unit', traits: ['G Generation'] }, 0));
  registry.tallgeeseDeploy(state, player);
  assert.equal(target.buffs.some((b) => b.breach === 1), true);
});

test('Gundam Plutone EB01-028: allyAttack grants the attacker Breach 2 only while rested, Once per Turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const plutone = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const attacker = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 2 });
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });

  registry.gundamPlutoneAllyAttack(state, player, plutone, { attacker, target: { type: 'unit', instance: target } });
  assert.equal(attacker.buffs.length, 0, 'Plutone not rested: no effect');

  plutone.rested = true;
  registry.gundamPlutoneAllyAttack(state, player, plutone, { attacker, target: { type: 'unit', instance: target } });
  assert.equal(attacker.buffs.some((b) => b.breach === 2), true);
});

test('Gundam Astaroth Rinascimento (EX) EB01-029: Deploy deals 2 to every Blocker Lv.4- Unit in play at 5+ enemy Units', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const friendlyBlocker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3, level: 3, keywords: { blocker: true } });
  for (let i = 0; i < 5; i++) deployUnit(state, opponent, { number: 'E' + i, type: 'unit', ap: 1, hp: 1 });
  const enemyBlocker = deployUnit(state, opponent, { number: 'EB', type: 'unit', ap: 2, hp: 3, level: 4, keywords: { blocker: true } });

  registry.gundamAstarothRinascimentoEXDeploy(state, player);
  assert.equal(friendlyBlocker.damage, 2, 'unqualified "all Units": hits both sides');
  assert.equal(enemyBlocker.damage, 2);
});

test('Big-Rang EB01-030 / Gundam Lfrith Ur EB01-034: look at top 3, take a (G Generation) Lv.3 Unit, shuffle the rest to the bottom', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const match = createInstance({ number: 'D1', type: 'unit', traits: ['G Generation'], level: 3 }, 0);
  player.deck.push(match, createInstance({ number: 'D2', type: 'unit' }, 0), createInstance({ number: 'D3', type: 'unit' }, 0));

  registry.bigRangDeploy(state, player);
  assert.equal(player.hand.includes(match), true);
  assert.equal(player.deck.length, 2);
});

test("Taurus (Sanc Kingdom) EB01-033: ActivateAction gives a chosen other Unit AP+1 for the battle, gated on (1) cost + Once per Turn", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3 });
  const target = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });

  assert.equal(registry.taurusSancKingdomActivateAction(state, player, instance, { target }), false, 'no active Resource to pay the (1) cost -- fails');

  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource', color: 'blue' }, 0));
  assert.equal(registry.taurusSancKingdomActivateAction(state, player, instance, { target }), true);
  assert.equal(target.buffs.some((b) => b.ap === 1 && b.scope === 'battle'), true);
  assert.equal(player.resourceArea[0].rested, true, 'paid the (1) cost');

  assert.equal(registry.taurusSancKingdomActivateAction(state, player, instance, { target }), false, 'Once per Turn -- already used');
});

test('Gundam Lfrith Thorn EB01-035: friendlyUnitDeployed grants Breach 1 for the turn when another (G Generation) Lv.3 Unit deploys', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const nonMatch = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, level: 4 });
  registry.gundamLfrithThornFriendlyUnitDeployed(state, player, instance, { deployedUnit: nonMatch });
  assert.equal(instance.buffs.length, 0);

  const match = deployUnit(state, player, { number: 'U3', type: 'unit', ap: 1, hp: 1, traits: ['G Generation'], level: 3 });
  registry.gundamLfrithThornFriendlyUnitDeployed(state, player, instance, { deployedUnit: match });
  assert.equal(instance.buffs.some((b) => b.breach === 1), true);
});

test('Darilbalde EB01-036: startOfTurn grants AP+1 to other (G Generation) Lv.3 Units, only on its controller\'s own turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 3 });
  const ally = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 2, traits: ['G Generation'], level: 3 });

  state.activePlayerIdx = 1;
  registry.darilbaldeStartOfTurn(state, player, instance);
  assert.equal(ally.buffs.length, 0, "not this controller's turn: no buff");

  state.activePlayerIdx = 0;
  registry.darilbaldeStartOfTurn(state, player, instance);
  assert.equal(ally.buffs.some((b) => b.ap === 1), true);
});

test('Zudah Unit 1 EB01-037: immune to battle damage while battling a Blocker Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zudah = deployUnit(state, player, lookupCard('EB01-037'));
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });
  const blocker = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 5, keywords: { blocker: true } });

  resolveAttack(state, 0, zudah, { type: 'unit', instance: target }, {
    chooseBlocker: () => blocker
  });
  assert.equal(zudah.damage, 0, 'redirected to a Blocker: return damage is immune');
});

test('G-Self EB01-038: Deploy places 1 EX Resource (reuses Wing Gundam (Bird Mode) ST02-002)', () => {
  const def = lookupCard('EB01-038');
  assert.equal(def.effects.deploy, registry.wingGundamBirdModeDeploy);
});
