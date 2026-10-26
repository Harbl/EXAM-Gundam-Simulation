const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, pairPilot, becomeBase } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { fireCardEffect } = require('../src/rules/effects');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// GD06 "Stardust Trails" -- Bases (GD06-122 through GD06-130), the final batch of the set. Covers
// Aspite/Gwaden's Activate*Main Base abilities (resting the Base itself as the cost) and Argama's
// reuse of the existing receivesBattleDamageFromEnemy event, plus a spot-check of the rest.

test('Albion GD06-122 Deploy: adds a Shield to hand, then bounces a Lv.2-or-lower enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'shield' }, 0));
  const target = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 2, ap: 1, hp: 1 });

  registry.albionGD06122Deploy(state, player);
  assert.equal(player.hand.length, 1);
  assert.equal(opponent.battleArea.includes(target), false);
});

test('Aspite GD06-124: Activate*Main rests itself (the cost) regardless, but only buffs with 3+ qualifying Units', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const aspite = deployBase(state, player, lookupCard('GD06-124'));
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1, traits: ['Ghingnham Fleet'] });

  registry.aspiteGD06124ActivateMain(state, player, aspite);
  assert.equal(aspite.rested, true, 'rested as the cost even though the count condition failed');
  assert.equal(getAP(ally), 1, 'fewer than 3 qualifying Units -- no buff');

  aspite.rested = false;
  deployUnit(state, player, { number: 'B', type: 'unit', ap: 1, hp: 1, traits: ['Long-Range Weapon'] });
  deployUnit(state, player, { number: 'C', type: 'unit', ap: 1, hp: 1, traits: ['Ghingnham Fleet'] });
  registry.aspiteGD06124ActivateMain(state, player, aspite);
  assert.equal(getAP(ally), 2, '3+ qualifying Units -- buffed');
});

test('Argama GD06-125: once per turn, pings the lowest-HP enemy when it receives battle damage while a rested (AEUG) ally is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const argama = becomeBase(state, player, createInstance(lookupCard('GD06-125'), 0));
  const target = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5 });

  fireCardEffect(state, player, argama, 'receivesBattleDamageFromEnemy', {});
  assert.equal(target.damage, 0, 'no rested (AEUG) ally yet');

  const aeugAlly = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1, traits: ['AEUG'] });
  aeugAlly.rested = true;
  fireCardEffect(state, player, argama, 'receivesBattleDamageFromEnemy', {});
  assert.equal(target.damage, 1);

  fireCardEffect(state, player, argama, 'receivesBattleDamageFromEnemy', {});
  assert.equal(target.damage, 1, 'once per turn');
});

test('Gwaden GD06-128: Activate*Main rests itself to grant a friendly (Zeon) Unit battle-damage reduction this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const gwaden = deployBase(state, player, lookupCard('GD06-128'));
  const zeonAlly = deployUnit(state, player, { number: 'Z', type: 'unit', ap: 1, hp: 5, traits: ['Zeon'] });

  const result = registry.gwadenGD06128ActivateMain(state, player, gwaden);
  assert.equal(result, true);
  assert.equal(gwaden.rested, true);
  assert.ok(zeonAlly.buffs.some((b) => b.battleDamageReduction === 1));
});

test('5th Luna GD06-129 Destroyed: deploys an Axis Base token only while the controller still has Shields', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));

  registry.fifthLunaGD06129Destroyed(state, player);
  assert.equal(player.base, null, 'no Shields -- no token');

  player.shields.push(createInstance({ number: 'S', type: 'shield' }, 0));
  registry.fifthLunaGD06129Destroyed(state, player);
  assert.equal(player.base && player.base.def.name, 'Axis');
});

test("Soleil GD06-130: debuffs an unpaired enemy Unit's AP by the number of friendly (Dianna Counter)/(Militia) Units", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, { number: 'D1', type: 'unit', ap: 1, hp: 1, traits: ['Dianna Counter'] });
  deployUnit(state, player, { number: 'D2', type: 'unit', ap: 1, hp: 1, traits: ['Militia'] });
  const unpairedEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 5, hp: 5 });
  const pairedEnemy = deployUnit(state, opponent, { number: 'P', type: 'unit', ap: 9, hp: 5 });
  pairPilot(state, opponent, pairedEnemy, createInstance({ number: 'PI', type: 'pilot' }, 1));

  registry.soleilGD06130Deploy(state, player);
  assert.equal(getAP(unpairedEnemy), 3, 'debuffed by 2 (one Dianna Counter + one Militia ally)');
  assert.equal(getAP(pairedEnemy), 9, 'paired enemy ineligible, left untouched');
});
