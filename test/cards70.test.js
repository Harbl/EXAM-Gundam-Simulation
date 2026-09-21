const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP } = require('../src/rules/management');
const { runStartPhase } = require('../src/rules/phases');
const { resolveUnitBattleDamage } = require('../src/rules/combat');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// ST14 "Heavy Dominion" -- covers The-O's opponent-untap lock (a new runStartPhase hook) and Full
// Armor Unicorn (Destroy Mode)'s once-per-turn low-AP damage immunity (a new resolveUnitBattleDamage
// hook), plus a spot-check of the rest of the set's more ordinary effects.

test("The-O ST14-001: the opponent's rested Units at the lowest Lv. stay rested through their own start phase", () => {
  const owner = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(owner, opponent);
  state.activePlayerIdx = 1; // it's about to be the opponent's start phase
  deployUnit(state, owner, lookupCard('ST14-001'));
  const low = deployUnit(state, opponent, { number: 'L', type: 'unit', level: 2, ap: 2, hp: 2 });
  const alsoLow = deployUnit(state, opponent, { number: 'L2', type: 'unit', level: 2, ap: 2, hp: 2 });
  const high = deployUnit(state, opponent, { number: 'H', type: 'unit', level: 5, ap: 2, hp: 2 });
  low.rested = true;
  alsoLow.rested = true;
  high.rested = true;

  runStartPhase(state);
  assert.equal(low.rested, true, 'lowest-Lv. rested Unit stays rested');
  assert.equal(alsoLow.rested, true, 'a second Unit tied for lowest Lv. also stays rested');
  assert.equal(high.rested, false, 'a higher-Lv. rested Unit untaps normally');
});

test("The-O ST14-001: doesn't affect its own controller's start phase", () => {
  const owner = createPlayer(0);
  const state = createGame(owner, createPlayer(1));
  state.activePlayerIdx = 0;
  deployUnit(state, owner, lookupCard('ST14-001'));
  const unit = deployUnit(state, owner, { number: 'U', type: 'unit', level: 2, ap: 2, hp: 2 });
  unit.rested = true;

  runStartPhase(state);
  assert.equal(unit.rested, false, "The-O's own side untaps normally");
});

test('Full Armor Unicorn Gundam (Destroy Mode) ST14-006: immune to battle damage from an enemy Unit with AP <= its own, once per turn, only while paired', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const fauc = deployUnit(state, player, lookupCard('ST14-006'));
  const weakEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 2, hp: 5 });

  resolveUnitBattleDamage(state, opponent, player, weakEnemy, fauc, {});
  assert.equal(fauc.damage, 2, 'not paired yet -- no immunity');

  fauc.damage = 0;
  pairPilot(state, player, fauc, createInstance({ number: 'P', type: 'pilot' }, 0));
  const secondWeakEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 3, hp: 5 });
  resolveUnitBattleDamage(state, opponent, player, weakEnemy, fauc, {});
  assert.equal(fauc.damage, 0, "immune -- attacker's AP (2) <= its own AP (3)");

  resolveUnitBattleDamage(state, opponent, player, secondWeakEnemy, fauc, {});
  assert.equal(fauc.damage, 3, 'once per turn -- the second qualifying hit gets through');
});

test('Full Armor Unicorn Gundam (Destroy Mode) ST14-006: does not prevent damage from a higher-AP attacker', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const fauc = deployUnit(state, player, lookupCard('ST14-006'));
  pairPilot(state, player, fauc, createInstance({ number: 'P', type: 'pilot' }, 0));
  const strongEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 5, hp: 5 });

  resolveUnitBattleDamage(state, opponent, player, strongEnemy, fauc, {});
  assert.equal(fauc.damage, 5);
});

test('Palace Athene ST14-003 Deploy: reuses Gundam Pharact\'s "opponent exiles 2 trashed Units" effect', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  opponent.trash.push(
    createInstance({ number: 'C1', type: 'unit', cost: 1 }, 1),
    createInstance({ number: 'C2', type: 'unit', cost: 2 }, 1),
    createInstance({ number: 'C3', type: 'unit', cost: 5 }, 1)
  );

  registry.gundamPharactST13009Attack(state, player);
  assert.equal(opponent.trash.length, 1);
  assert.equal(opponent.trash[0].def.number, 'C3', 'the priciest card survives');
});

test('G-Falcon DX ST14-005 Deploy: rests a Lv.6-or-lower enemy Unit, debuffing it too with 7+ trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 6, ap: 4, hp: 4 });

  registry.gFalconDXST14005Deploy(state, player);
  assert.equal(target.rested, true);
  assert.equal(getAP(target), 4, 'under 7 trash cards -- no AP debuff yet');

  target.rested = false;
  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: 'T' + i, type: 'unit' }, 0));
  registry.gFalconDXST14005Deploy(state, player);
  assert.equal(getAP(target), 2, '7+ trash cards -- AP-2 this turn');
});

test('Natural Talent ST14-013 Command: rests up to 2 low-HP active enemies when available, else debuffs AP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowHp1 = deployUnit(state, opponent, { number: 'L1', type: 'unit', ap: 2, hp: 3 });
  const lowHp2 = deployUnit(state, opponent, { number: 'L2', type: 'unit', ap: 2, hp: 3 });
  const highHp = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 2, hp: 8 });

  registry.naturalTalentST14013Command(state, player);
  assert.equal(lowHp1.rested, true);
  assert.equal(lowHp2.rested, true);
  assert.equal(highHp.rested, false, 'not a valid Rest target, and not the fallback debuff either since the Rest branch was taken');
});

test('Blazing Mobile Suit Rider ST14-014: only reaches Lv.6+ enemies once 4+ Commands are in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const highLevel = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 6, ap: 5, hp: 5 });

  registry.blazingMobileSuitRiderST14014Command(state, player);
  assert.equal(getAP(highLevel), 5, 'Lv.6 is out of reach without 4+ trashed Commands');

  for (let i = 0; i < 4; i++) player.trash.push(createInstance({ number: 'C' + i, type: 'command' }, 0));
  registry.blazingMobileSuitRiderST14014Command(state, player);
  assert.equal(getAP(highLevel), 2);
});

test('Battlefield Emotions ST14-015: places a rested Resource, then activates one Resource only once per turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.resourceDeck.push(createInstance({ number: 'R1', type: 'resource' }, 0), createInstance({ number: 'R2', type: 'resource' }, 0));

  registry.battlefieldEmotionsST14015Command(state, player);
  assert.equal(player.resourceArea.length, 1, 'placed a rested Resource');
  assert.equal(player.resourceArea[0].rested, false, 'immediately activated since nothing was set active by an effect yet this turn');

  registry.battlefieldEmotionsST14015Command(state, player);
  assert.equal(player.resourceArea.length, 2);
  assert.equal(player.resourceArea[1].rested, true, "second Resource stays rested -- already used this turn's activation");
});

test('Gryphios 2 ST14-016: debuffs a Lv.5-or-lower enemy once per turn, only when a friendly Unit actually links', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('ST14-016'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 3, ap: 4, hp: 4 });
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 3, hp: 3, linkCondition: 'X' });
  const linkingPilot = createInstance({ number: 'X', type: 'pilot', name: 'X' }, 0);

  pairPilot(state, player, unit, linkingPilot);
  assert.equal(getAP(enemy), 3, "linked (pilot's name 'X' matches the Unit's link condition)");
});
