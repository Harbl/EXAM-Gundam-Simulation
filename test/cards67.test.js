const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP } = require('../src/rules/management');
const { getEligibleAttackTargets, collectBlockCandidates } = require('../src/ai/heuristic');
const { dealEffectDamage } = require('../src/rules/effects');
const { applyBreach } = require('../src/rules/combat');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// ST11 "Aquatic Assault" -- covers the new engine mechanics this starter needed (target exclusion,
// count-conditional Blocker, conditional effect-damage immunity, shield-damage reduction) plus a
// spot-check of the more ordinary card effects.

function marineUnit(owner, overrides = {}) {
  return createInstance({ number: 'M', type: 'unit', level: 3, ap: 2, hp: 2, traits: ['Marine'], ...overrides }, owner);
}

test("Char's Z'Gok ST11-001 Deploy: only bounces a low-level enemy Unit when another friendly Marine is in play", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zgok = deployUnit(state, player, lookupCard('ST11-001'));
  const lowLevelEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', level: 2, ap: 2, hp: 2 });

  registry.charsZGokST11001Deploy(state, player, zgok);
  assert.equal(opponent.battleArea.includes(lowLevelEnemy), true, 'no other friendly Marine yet -- no-op');

  player.battleArea.push(marineUnit(0));
  registry.charsZGokST11001Deploy(state, player, zgok);
  assert.equal(opponent.battleArea.includes(lowLevelEnemy), false, 'bounced once another friendly Marine is in play');
  assert.equal(opponent.deck[opponent.deck.length - 1], lowLevelEnemy, 'goes to the bottom of the deck, not top');
});

test("Char's Z'Gok ST11-001: enemy Units can't choose it as their attack target while 2+ other friendly Marines are in play", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zgok = deployUnit(state, player, lookupCard('ST11-001'));
  zgok.rested = true; // rested Units are normally always a legal target
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', level: 3, ap: 2, hp: 2 });

  let targets = getEligibleAttackTargets(player, attacker, false, opponent);
  assert.equal(targets.some((t) => t.type === 'unit' && t.instance === zgok), true, 'eligible with fewer than 2 other Marines');

  player.battleArea.push(marineUnit(0), marineUnit(0));
  targets = getEligibleAttackTargets(player, attacker, false, opponent);
  assert.equal(targets.some((t) => t.type === 'unit' && t.instance === zgok), false, 'excluded once 2+ other Marines are in play');
});

test('The Orca of Red Sea ST11-014: grants the same attack-target exclusion as a this-turn buff', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const marine = deployUnit(state, player, marineUnit(0).def);
  marine.rested = true;
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', level: 3, ap: 2, hp: 2 });

  let targets = getEligibleAttackTargets(player, attacker, false, opponent);
  assert.equal(targets.some((t) => t.instance === marine), true);

  registry.theOrcaOfRedSeaST11014Command(state, player);
  targets = getEligibleAttackTargets(player, attacker, false, opponent);
  assert.equal(targets.some((t) => t.instance === marine), false);
});

test('Zock ST11-003: gains [Blocker] only while another friendly Marine Unit is in play', () => {
  const defender = createPlayer(0);
  const attacker = createPlayer(1);
  const zock = deployUnit({ turnNumber: 1 }, defender, lookupCard('ST11-003'));
  const attackerUnit = deployUnit({ turnNumber: 1 }, attacker, { number: 'A', type: 'unit', level: 3, ap: 3, hp: 3 });

  let candidates = collectBlockCandidates(defender, attackerUnit, { type: 'player' }, attacker);
  assert.equal(candidates.includes(zock), false, 'no other Marine yet -- not a legal Blocker');

  defender.battleArea.push(marineUnit(0));
  candidates = collectBlockCandidates(defender, attackerUnit, { type: 'player' }, attacker);
  assert.equal(candidates.includes(zock), true, 'gains Blocker once another friendly Marine is in play');
});

test('Acguy ST11-002: friendly Marine Units with 2 or less HP are immune to enemy effect damage during the opponent\'s turn, only while Acguy is rested', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1; // opponent's turn
  const acguy = deployUnit(state, player, lookupCard('ST11-002'));
  const lowHpMarine = deployUnit(state, player, marineUnit(0, { hp: 2 }).def);

  dealEffectDamage(state, opponent, player, lowHpMarine, 2);
  assert.equal(lowHpMarine.damage, 2, 'Acguy is active -- no immunity yet');

  lowHpMarine.damage = 0;
  acguy.rested = true;
  dealEffectDamage(state, opponent, player, lowHpMarine, 2);
  assert.equal(lowHpMarine.damage, 0, 'immune while Acguy is rested during the opponent\'s turn');
});

test('Shamblo ST11-006: reduces enemy effect damage to the shield area by 5 for the rest of the turn it starts, once another friendly Marine is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.turnNumber = 5;
  state.activePlayerIdx = 1; // start of the opponent's turn
  const shamblo = deployUnit(state, player, lookupCard('ST11-006'));
  player.battleArea.push(marineUnit(0));
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0), createInstance({ number: 'S2', type: 'unit' }, 0));

  registry.shambloST11006StartOfTurn(state, player, shamblo);
  applyBreach(state, player, 3, {});
  assert.equal(player.shields.length, 2, 'a 3-damage hit is fully absorbed by the 5-point reduction');

  applyBreach(state, player, 6, {});
  assert.equal(player.shields.length, 1, 'a 6-damage hit still gets through (reduced to 1)');
});

test('Shamblo ST11-006 Deploy: recurs the highest-cost friendly Marine Unit card from trash to hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const cheap = createInstance({ number: 'C1', type: 'unit', cost: 1, traits: ['Marine'] }, 0);
  const expensive = createInstance({ number: 'C2', type: 'unit', cost: 3, traits: ['Marine'] }, 0);
  player.trash.push(cheap, expensive);

  registry.shambloST11006Deploy(state, player);
  assert.equal(player.hand.includes(expensive), true);
  assert.equal(player.trash.includes(expensive), false);
});

test("Kapool ST11-009 Destroyed: draws only on the opponent's turn while a friendly Marine Unit is in play", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));

  state.activePlayerIdx = 0; // own turn -- no draw
  registry.kapoolST11009Destroyed(state, player);
  assert.equal(player.hand.length, 0);

  state.activePlayerIdx = 1;
  registry.kapoolST11009Destroyed(state, player); // still no friendly Marine in play
  assert.equal(player.hand.length, 0);

  player.battleArea.push(marineUnit(0));
  registry.kapoolST11009Destroyed(state, player);
  assert.equal(player.hand.length, 1);
});

test('Char Aznable ST11-011 When Paired: all friendly Marine Units get AP+1 during this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const marine = deployUnit(state, player, marineUnit(0).def);
  const nonMarine = deployUnit(state, player, { number: 'X', type: 'unit', ap: 2, hp: 2 });

  registry.charAznableST11011WhenPaired(state, player);
  assert.equal(getAP(marine), 3);
  assert.equal(getAP(nonMarine), 2);
});

test('Poorly Planned Offensive ST11-013: Burst and Command both return a rested, 3-or-less-HP enemy Unit to hand; Command also draws', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 3 });
  target.rested = true;
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));

  registry.poorlyPlannedOffensiveST11013Burst(state, player);
  assert.equal(opponent.hand.includes(target), true);

  const target2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 3, hp: 2 });
  target2.rested = true;
  registry.poorlyPlannedOffensiveST11013Command(state, player);
  assert.equal(opponent.hand.includes(target2), true, 'the bounced Unit goes to its owner\'s hand, not the caster\'s');
  assert.equal(player.hand.length, 1, 'just the drawn card, on the caster\'s side');
});

test('A Twinkle from the Abyss ST11-015: deploys the highest-cost Lv.4-or-lower Marine Unit from trash, rested', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const tooHighLevel = createInstance({ number: 'H', type: 'unit', level: 5, cost: 4, traits: ['Marine'] }, 0);
  const eligible = createInstance({ number: 'E', type: 'unit', level: 4, cost: 3, ap: 3, hp: 3, traits: ['Marine'] }, 0);
  player.trash.push(tooHighLevel, eligible);

  registry.aTwinkleFromTheAbyssST11015Command(state, player);
  // deployUnit always creates a fresh instance from the def (4-1-5: moving zones = a brand new card),
  // so the deployed card is identified by its def, not by reference to the original trashed instance.
  const deployed = player.battleArea.find((u) => u.def === eligible.def);
  assert.ok(deployed, 'the eligible card was deployed');
  assert.equal(deployed.rested, true);
  assert.equal(player.trash.includes(tooHighLevel), true, 'the too-high-level card is left alone');
});

test('Mad Angler ST11-016 Deploy: adds a Shield to hand, then deals 2 damage to a rested enemy Unit only with 4+ enemy Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));
  for (let i = 0; i < 3; i++) deployUnit(state, opponent, { number: 'E' + i, type: 'unit', ap: 2, hp: 3 }).rested = true;

  registry.madAnglerST11016Deploy(state, player);
  assert.equal(player.hand.length, 1, 'the Shield always comes to hand');
  assert.equal(opponent.battleArea.every((u) => u.damage === 0), true, 'fewer than 4 enemy Units -- no damage yet');

  deployUnit(state, opponent, { number: 'E4', type: 'unit', ap: 2, hp: 3 }).rested = true;
  registry.madAnglerST11016Deploy(state, player);
  assert.equal(opponent.battleArea.some((u) => u.damage === 2), true, '4+ enemy Units -- a rested one takes 2 damage');
});
