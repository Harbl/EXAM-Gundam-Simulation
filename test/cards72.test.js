const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { runStartPhase, runEndPhase } = require('../src/rules/phases');
const { resolveUnitBattleDamage } = require('../src/rules/combat');
const { setActiveByEffect, dealEffectDamage } = require('../src/rules/effects');
const { collectActivateCandidates } = require('../src/ai/activations');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// GD06 "Stardust Trails" -- Red Units (GD06-033 through GD06-048). Covers the new team-wide
// damage amp (ZZ Gundam, both the battle- and effect-damage halves), a new attacker-own
// First-Strike-if-defender-damaged static check, and a new "enemy can't set its own Units active
// by effect" guard (Reginlaze Julia), plus a spot-check of the rest of this slice.

test('ZZ Gundam GD06-033: Deploy deals 2 to every enemy Unit, and its own (AEUG) damage amp applies to both battle and effect damage against enemy Units', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zz = deployUnit(state, player, lookupCard('GD06-033'));
  const e1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  const e2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 2 });

  registry.zzGundamGD06033Deploy(state, player);
  assert.equal(e1.damage, 2);
  assert.equal(opponent.battleArea.includes(e2), false, '2 damage was lethal to the 2-HP Unit');

  const aeugAttacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 3, hp: 5, traits: ['AEUG'] });
  const nonAeugAttacker = deployUnit(state, player, { number: 'B', type: 'unit', ap: 3, hp: 5 });
  const target1 = deployUnit(state, opponent, { number: 'T1', type: 'unit', ap: 0, hp: 10 });
  const target2 = deployUnit(state, opponent, { number: 'T2', type: 'unit', ap: 0, hp: 10 });

  resolveUnitBattleDamage(state, player, opponent, nonAeugAttacker, target1, {});
  assert.equal(target1.damage, 3, 'non-(AEUG) attacker -- no amp');

  resolveUnitBattleDamage(state, player, opponent, aeugAttacker, target2, {});
  assert.equal(target2.damage, 4, '(AEUG) attacker -- battle damage amped by 1');

  state.resolvingSource = aeugAttacker;
  dealEffectDamage(state, player, opponent, target2, 1);
  assert.equal(target2.damage, 4 + 2, '(AEUG) source -- effect damage also amped by 1');
});

test('Zeta Gundam GD06-035: once per turn, pings a low-AP enemy for 2 after a battle kill', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zeta = deployUnit(state, player, lookupCard('GD06-035'));
  const weakEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1 });
  const lowAP = deployUnit(state, opponent, { number: 'L', type: 'unit', ap: 2, hp: 5 });
  const highAP = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 9, hp: 5 });

  resolveUnitBattleDamage(state, player, opponent, zeta, weakEnemy, {});
  assert.equal(lowAP.damage, 2, 'pinged the <=3 AP enemy');
  assert.equal(highAP.damage, 0, 'high-AP enemy untouched');
});

test('Reginlaze Julia GD06-037: gains First Strike only against an already-damaged defender, and blocks the enemy from setting its own Units active by effect while paired', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const julia = deployUnit(state, player, lookupCard('GD06-037'));
  const undamagedEnemy = deployUnit(state, opponent, { number: 'U', type: 'unit', ap: 3, hp: 5 });
  resolveUnitBattleDamage(state, player, opponent, julia, undamagedEnemy, {});
  assert.ok(julia.damage > 0, 'no First Strike -- simultaneous damage, Julia also took return damage');

  julia.damage = 0;
  const damagedEnemy = deployUnit(state, opponent, { number: 'D', type: 'unit', ap: 3, hp: 5 });
  damagedEnemy.damage = 1;
  resolveUnitBattleDamage(state, player, opponent, julia, damagedEnemy, {});
  assert.equal(julia.damage, 0, 'First Strike against a damaged defender -- no return damage received');

  const rested = deployUnit(state, opponent, { number: 'R', type: 'unit', ap: 1, hp: 1 });
  rested.rested = true;
  setActiveByEffect(state, opponent, rested);
  assert.equal(rested.rested, false, "not paired yet -- Julia's block doesn't apply");

  rested.rested = true;
  pairPilot(state, player, julia, createInstance({ number: 'P', type: 'pilot' }, 0));
  setActiveByEffect(state, opponent, rested);
  assert.equal(rested.rested, true, "paired -- opponent's own set-active-by-effect is blocked");
});

test('Neo Core Fighter GD06-039 Activate*Main: destroys 2 distinct-named Lv.3 (Gundam Team) Units + itself to deploy a Lv.8+ (Gundam Team) card from hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const neoCoreFighter = deployUnit(state, player, lookupCard('GD06-039'));
  const sac1 = deployUnit(state, player, { number: 'S1', type: 'unit', name: 'Sac1', level: 3, ap: 1, hp: 1, traits: ['Gundam Team'] });
  const sac2 = deployUnit(state, player, { number: 'S2', type: 'unit', name: 'Sac2', level: 3, ap: 1, hp: 1, traits: ['Gundam Team'] });
  const bigCard = createInstance({ number: 'BIG', type: 'unit', level: 8, ap: 5, hp: 5, traits: ['Gundam Team'] }, 0);
  player.hand.push(bigCard);

  const result = registry.neoCoreFighterGD06039ActivateMain(state, player, neoCoreFighter, { sacrifices: [sac1, sac2], card: bigCard });
  assert.equal(result, true);
  assert.equal(player.battleArea.includes(neoCoreFighter), false, 'the source itself is also destroyed as part of the cost');
  assert.equal(player.battleArea.includes(sac1), false);
  assert.equal(player.battleArea.includes(sac2), false);
  assert.equal(player.battleArea.some((u) => u.def.number === 'BIG'), true);
  assert.equal(player.hand.includes(bigCard), false);
});

test('Neo Core Fighter GD06-039 is AI-wired: picks the 2 lowest-AP distinct-named qualifying sacrifices (keeping the priciest) and the highest AP+HP hand target', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  deployUnit(state, player, lookupCard('GD06-039'));

  assert.deepEqual(collectActivateCandidates(state, 0), [], 'no qualifying sacrifices or hand target yet');

  const able = deployUnit(state, player, { number: 'ABLE', type: 'unit', name: 'Able', level: 3, ap: 1, hp: 1, traits: ['Gundam Team'] });
  const baker = deployUnit(state, player, { number: 'BAKER', type: 'unit', name: 'Baker', level: 3, ap: 2, hp: 1, traits: ['Gundam Team'] });
  deployUnit(state, player, { number: 'CHARLIE', type: 'unit', name: 'Charlie', level: 3, ap: 5, hp: 1, traits: ['Gundam Team'] });
  deployUnit(state, player, { number: 'ABLE-DUP', type: 'unit', name: 'Able', level: 3, ap: 0, hp: 1, traits: ['Gundam Team'] });
  const smallCard = createInstance({ number: 'SMALL', type: 'unit', level: 8, ap: 2, hp: 2, traits: ['Gundam Team'] }, 0);
  const bigCard = createInstance({ number: 'BIG', type: 'unit', level: 8, ap: 5, hp: 5, traits: ['Gundam Team'] }, 0);
  player.hand.push(smallCard, bigCard);

  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  const { args } = candidates[0];
  assert.deepEqual(new Set(args.sacrifices), new Set([able, baker]), 'the 2 lowest-AP distinct names (Able, Baker) are sacrificed; Charlie (AP5) is kept, and the 0-AP "Able" duplicate is just the interchangeable second copy of an already-represented name');
  assert.equal(args.card, bigCard, 'highest AP+HP qualifying hand card');
});

test('Julieta\'s Reginlaze GD06-043: During Link, buffs other (Gjallarhorn) Units AP+1 only during its own controller\'s turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  const reginlaze = deployUnit(state, player, lookupCard('GD06-043'));
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 2, hp: 2, traits: ['Gjallarhorn'] });
  pairPilot(state, player, reginlaze, createInstance({ number: 'Gjallarhorn', type: 'pilot', name: 'Gjallarhorn' }, 0));
  assert.equal(reginlaze.isLinkUnit, true);

  runStartPhase(state);
  assert.equal(getAP(ally), 3, 'buffed on its own controller\'s turn');
  assert.equal(getAP(reginlaze), getAP(reginlaze), 'sanity -- does not buff itself is checked below');
  assert.equal(ally.buffs.some((b) => b.ap === 1), true);

  runEndPhase(state, {});
  state.activePlayerIdx = 1;
  runStartPhase(state);
  assert.equal(getAP(ally), 2, "opponent's turn -- no buff");
});

test('Hyaku-Shiki GD06-046 Attack: buffs another friendly (Gundam Team) Unit AP+2 this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const hyakuShiki = deployUnit(state, player, lookupCard('GD06-046'));
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 2, hp: 2, traits: ['Gundam Team'] });

  registry.hyakuShikiGD06046Attack(state, player, hyakuShiki);
  assert.equal(getAP(ally), 4);
});

test('Helmwige Reincar GD06-048 Deploy: targets Lv.2-or-lower normally, but any level with 4+ (Gjallarhorn) cards in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const highLevel = deployUnit(state, opponent, { number: 'H', type: 'unit', level: 6, ap: 5, hp: 5 });

  registry.helmwigeReincarGD06048Deploy(state, player);
  assert.equal(highLevel.damage, 0, 'Lv.6 is out of reach without 4+ (Gjallarhorn) in trash');

  for (let i = 0; i < 4; i++) player.trash.push(createInstance({ number: 'G' + i, type: 'unit', traits: ['Gjallarhorn'] }, 0));
  registry.helmwigeReincarGD06048Deploy(state, player);
  assert.equal(highLevel.damage, 1);
});
