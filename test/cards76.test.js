const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, playCommand } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { fireAttackTriggers, predictShieldHits } = require('../src/rules/combat');
const { runStartPhase } = require('../src/rules/phases');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// GD06 "Stardust Trails" -- Commands (GD06-101 through GD06-121). Covers two new engine hooks:
// a persistent "an enemy Unit attacked this turn" flag (A Miracle) and a new player-level AP-based
// shield damage immunity (Presence Detected, the AP-keyed sibling of shieldDamageImmuneLevelCap),
// plus a spot-check of the rest of this slice (token deploys, trash recursion, battle-context
// reactive targeting).

test("A Miracle GD06-102: draws 2 only on the opponent's turn, and only before any enemy Unit has attacked", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));

  registry.aMiracleGD06102Command(state, player);
  assert.equal(player.hand.length, 0, "it's my own turn -- no draw");

  state.activePlayerIdx = 1;
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 1, hp: 1 });
  registry.aMiracleGD06102Command(state, player);
  assert.equal(player.hand.length, 2, "opponent's turn, nothing has attacked yet -- drew 2");

  player.hand.length = 0;
  player.deck.push(createInstance({ number: 'D3', type: 'unit' }, 0), createInstance({ number: 'D4', type: 'unit' }, 0));
  fireAttackTriggers(state, opponent, attacker, { type: 'player' });
  registry.aMiracleGD06102Command(state, player);
  assert.equal(player.hand.length, 0, 'opponent already attacked this turn -- no draw');

  runStartPhase(state);
  assert.equal(opponent.attackedThisTurn, false, 'cleared each start phase');
});

test("Presence Detected GD06-106: shields immune to battle damage from 6-or-less-AP enemies for the rest of this battle", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'shield' }, 0));
  const weakAttacker = deployUnit(state, opponent, { number: 'W', type: 'unit', ap: 0, hp: 1 });

  assert.equal(predictShieldHits(player, weakAttacker).length, 1, 'no immunity yet');

  registry.presenceDetectedGD06106Command(state, player);
  assert.equal(predictShieldHits(player, weakAttacker).length, 0, 'immune to a 0-AP attacker');

  const strongAttacker = deployUnit(state, opponent, { number: 'S2', type: 'unit', ap: 7, hp: 1 });
  assert.equal(predictShieldHits(player, strongAttacker).length, 1, 'a 7-AP attacker beats the cap of 6');
});

test('Grace Under Pressure GD06-105 deploys Gundam Calibarn by default', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  registry.graceUnderPressureGD06105Command(state, player);
  assert.ok(player.battleArea.some((u) => u.def.name === 'Gundam Calibarn'));
});

test('Teaching New Techniques GD06-115: destroys a Lv.4-or-lower enemy, then both sides get a token', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 4, ap: 1, hp: 1 });

  registry.teachingNewTechniquesGD06115Command(state, player);
  assert.equal(opponent.battleArea.includes(target), false);
  assert.ok(player.battleArea.some((u) => u.def.name === 'Sazabi'));
  assert.ok(opponent.battleArea.some((u) => u.def.name === 'Nu Gundam'));
});

test('Afterglow of Zeon GD06-116: redeploys the pricier matching (Zeon) Unit from trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.trash.push(
    createInstance({ number: 'Z1', type: 'unit', color: 'purple', cost: 2, level: 3, traits: ['Zeon'] }, 0),
    createInstance({ number: 'Z2', type: 'unit', color: 'purple', cost: 4, level: 5, traits: ['Zeon'] }, 0),
    createInstance({ number: 'TOOHIGH', type: 'unit', color: 'purple', cost: 1, level: 6, traits: ['Zeon'] }, 0)
  );
  registry.afterglowOfZeonGD06116Command(state, player);
  assert.equal(player.battleArea.some((u) => u.def.number === 'Z2'), true);
  assert.equal(player.trash.some((c) => c.def.number === 'Z2'), false);
});

test('Rivalry with Roux GD06-112: deals 2 to the enemy Unit battling a friendly (AEUG) Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const aeugUnit = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 5, traits: ['AEUG'] });
  const nonAeugUnit = deployUnit(state, player, { number: 'N', type: 'unit', ap: 1, hp: 5 });
  const attacker = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5 });

  registry.rivalryWithRouxGD06112Command(state, player, null, { underAttack: nonAeugUnit, attackingUnit: attacker });
  assert.equal(attacker.damage, 0, 'not battling an (AEUG) Unit -- no effect');

  registry.rivalryWithRouxGD06112Command(state, player, null, { underAttack: aeugUnit, attackingUnit: attacker });
  assert.equal(attacker.damage, 2);
});

test('Infinite Variations GD06-118: debuffs up to N enemies, N = friendly white Blocker Unit count', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, { number: 'B', type: 'unit', color: 'white', ap: 1, hp: 1, keywords: { blocker: true } });
  const e1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 5, hp: 5 });
  const e2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 3, hp: 5 });

  registry.infiniteVariationsGD06118Command(state, player);
  assert.equal(getAP(e1), 3, 'only 1 qualifying Blocker -- only the highest-AP enemy debuffed');
  assert.equal(getAP(e2), 3, 'untouched');
});

test('Crybaby Poe GD06-121: AP-2 normally, AP-6 against a High-Maneuver target', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const normal = deployUnit(state, opponent, { number: 'N', type: 'unit', ap: 5, hp: 5 });
  const highManeuver = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 9, hp: 5, keywords: { highManeuver: true } });

  registry.crybabyPoeGD06121Command(state, player, null, { attackingUnit: normal });
  assert.equal(getAP(normal), 3);

  registry.crybabyPoeGD06121Command(state, player, null, { attackingUnit: highManeuver });
  assert.equal(getAP(highManeuver), 3);
});
