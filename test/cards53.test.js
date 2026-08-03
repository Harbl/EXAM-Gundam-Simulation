const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { chooseBlocker } = require('../src/ai/heuristic');
const { lookupCard } = require('../src/cards/index');
const registry = require('../src/effects/registry');

test('Strike Freedom Gundam (EX) EB01-041: Deploy bounces an enemy Unit with 4 or less HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooTanky = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 5 });
  const eligible = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 4 });
  registry.strikeFreedomGundamEXDeploy(state, player);
  assert.equal(opponent.battleArea.includes(eligible), false);
  assert.equal(opponent.hand.includes(eligible), true);
  assert.equal(opponent.battleArea.includes(tooTanky), true);
});

test('Psycho Haro (EX) EB01-042: grants Blocker to every friendly Unit while rested, and disables Blocker on Lv.7- enemies on Attack', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const haro = deployUnit(state, player, lookupCard('EB01-042'));
  const nonBlocker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const attacker = deployUnit(state, opponent, { number: 'A1', type: 'unit', ap: 5, hp: 5 });

  assert.equal(chooseBlocker(player, attacker, { type: 'player' }), null, 'Haro active: no universal grant yet');
  haro.rested = true;
  const blocked = chooseBlocker(player, attacker, { type: 'player' });
  assert.equal(blocked, nonBlocker, 'Haro rested: non-Blocker Unit becomes eligible');

  const lowLevelEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 2, level: 5, keywords: { blocker: true } });
  registry.psychoHaroEXAttack(state, player, haro);
  assert.equal(lowLevelEnemy.buffs.some((b) => b.cannotBlock), true);
});

test('Blue Destiny Unit-1 (EX) EB01-043: Attack reduces a Lv.5- enemy AP-2, gated on a friendly Blocker in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 5 });
  registry.blueDestinyUnit1EXAttack(state, player);
  assert.equal(target.buffs.length, 0, 'no friendly Blocker: no effect');

  deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3, keywords: { blocker: true } });
  registry.blueDestinyUnit1EXAttack(state, player);
  assert.equal(target.buffs.some((b) => b.ap === -2), true);
});

test('Psycho Zaku (EX) EB01-045: When Paired bounces an enemy Unit with Repair', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const noRepair = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });
  const withRepair = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 3, keywords: { repair: 1 } });
  registry.psychoZakuEXWhenPaired(state, player);
  assert.equal(opponent.battleArea.includes(withRepair), false);
  assert.equal(opponent.battleArea.includes(noRepair), true);
});

test('Striker Custom (EX) EB01-046: During Pair Attack reduces a Lv.4+ enemy AP-2', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 4 });
  registry.strikerCustomEXAttack(state, player, unit);
  assert.equal(target.buffs.length, 0, 'no paired pilot: no effect');

  pairPilot(state, player, unit, createInstance({ number: 'P1', type: 'pilot', name: 'X', apBonus: 0, hpBonus: 0 }, 0));
  registry.strikerCustomEXAttack(state, player, unit);
  assert.equal(target.buffs.some((b) => b.ap === -2), true);
});

test("Casval's Gundam EB01-047: When Paired exiles 1 (G Generation) trash card for High-Maneuver this turn", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 4 });
  registry.casvalsGundamWhenPaired(state, player, unit);
  assert.equal(unit.buffs.length, 0, 'nothing to exile: no effect');

  player.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['G Generation'] }, 0));
  registry.casvalsGundamWhenPaired(state, player, unit);
  assert.equal(unit.buffs.some((b) => b.keyword === 'highManeuver'), true);
  assert.equal(player.trash.length, 0);
});

test('Pale Rider (Ground Heavy Equipment Type) EB01-049: startOfTurn grants Suppression while a friendly (G Generation) Blocker is in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, lookupCard('EB01-049'));
  registry.paleRiderGroundHeavyEquipmentTypeStartOfTurn(state, player, instance);
  assert.equal(instance.grantedKeywords.suppression, false);

  deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3, traits: ['G Generation'], keywords: { blocker: true } });
  registry.paleRiderGroundHeavyEquipmentTypeStartOfTurn(state, player, instance);
  assert.equal(instance.grantedKeywords.suppression, true);
});

test('Saikoro Gundam EB01-050: Attack mills 1, reducing a chosen enemy AP-2 only if the milled card is Lv.3+', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3 });

  player.deck.push(createInstance({ number: 'D1', type: 'unit', level: 2 }, 0));
  registry.saikoroGundamAttack(state, player);
  assert.equal(target.buffs.length, 0, 'Lv.2 milled: no effect');
  assert.equal(player.trash.length, 1);

  player.deck.push(createInstance({ number: 'D2', type: 'unit', level: 3 }, 0));
  registry.saikoroGundamAttack(state, player);
  assert.equal(target.buffs.some((b) => b.ap === -2), true);
});

test('Hildolfr EB01-052: Deploy bounces a 2-or-less-HP enemy Unit only with 3+ enemy Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const low = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 2 });
  registry.hildolfrDeploy(state, player);
  assert.equal(opponent.battleArea.includes(low), true, 'only 1 enemy Unit: no effect');

  deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });
  deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 1 });
  registry.hildolfrDeploy(state, player);
  assert.equal(opponent.battleArea.includes(low), false);
  assert.equal(opponent.hand.includes(low), true);
});

test('Gundam Geminass 02 EB01-057: Deploy may rest an active Lv.3 friendly to bounce a Lv.2- enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 2 });
  registry.gundamGeminass02Deploy(state, player);
  assert.equal(opponent.battleArea.includes(enemy), true, 'no Lv.3 friendly to rest: no effect');

  const friendly = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3, level: 3 });
  registry.gundamGeminass02Deploy(state, player);
  assert.equal(friendly.rested, true);
  assert.equal(opponent.battleArea.includes(enemy), false);
});

test('Psycho Zaku EB01-059: During Link Attack sets 1 rested Resource active for each player, Once per Turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 4 });
  const pResource = createInstance({ number: 'R1', type: 'resource' }, 0);
  pResource.rested = true;
  player.resourceArea.push(pResource);
  const oResource = createInstance({ number: 'R2', type: 'resource' }, 1);
  oResource.rested = true;
  opponent.resourceArea.push(oResource);

  registry.psychoZakuAttack(state, player, unit);
  assert.equal(pResource.rested, true, 'not a Link Unit: no effect');

  unit.isLinkUnit = true;
  registry.psychoZakuAttack(state, player, unit);
  assert.equal(pResource.rested, false);
  assert.equal(oResource.rested, false);
});

test('Gundam Aquarius EB01-060: When Paired exiles 3 (G Generation) trash cards to bounce a Lv.4- enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 4, level: 4 });
  for (let i = 0; i < 2; i++) player.trash.push(createInstance({ number: 'T' + i, type: 'unit', traits: ['G Generation'] }, 0));
  registry.gundamAquariusWhenPaired(state, player);
  assert.equal(opponent.battleArea.includes(target), true, 'only 2 exilable: cost not paid');

  player.trash.push(createInstance({ number: 'T2', type: 'unit', traits: ['G Generation'] }, 0));
  registry.gundamAquariusWhenPaired(state, player);
  assert.equal(opponent.battleArea.includes(target), false);
  assert.equal(player.trash.length, 0);
});

test('Justice Gundam EB01-044 / Dom Gross Beil EB01-055 / Extreme Gundam EB01-058 stay vanilla (2-or-more-enemy-players gate is unreachable)', () => {
  assert.equal(lookupCard('EB01-044').effects, undefined);
  assert.equal(lookupCard('EB01-055').effects, undefined);
  assert.equal(lookupCard('EB01-058').effects, undefined);
});
