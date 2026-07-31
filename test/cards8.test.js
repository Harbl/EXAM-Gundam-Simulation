const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getHP, getKeywords } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { chooseAttackTarget } = require('../src/ai/heuristic');

test("Wing Gundam's activeTargetLevelCap lets the AI target an active low-level enemy, not just rested ones", () => {
  const opponent = createPlayer(1);
  const wingGundam = createInstance(lookupCard('ST02-001'), 0);
  const lowLevelActive = createInstance({ number: 'E', type: 'unit', level: 3, ap: 1, hp: 2 }, 1);
  opponent.battleArea.push(lowLevelActive);

  const target = chooseAttackTarget(opponent, wingGundam);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, lowLevelActive, 'an active Lv.3 enemy is a legal target thanks to the level cap');
});

test('Wing Gundam Zero (EW) gains Suppression only while a rested enemy Unit is in play, and its Attack rests a chosen enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  const zeroEW = deployUnit(state, player, lookupCard('GD05-067'));
  lookupCard('GD05-067').effects.startOfTurn(state, player, zeroEW);
  assert.equal(getKeywords(zeroEW).suppression, false, 'no rested enemy yet, so no Suppression');

  const restedEnemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 1 }, 1);
  restedEnemy.rested = true;
  const activeEnemy = createInstance({ number: 'E2', type: 'unit', ap: 3, hp: 1 }, 1);
  opponent.battleArea.push(restedEnemy, activeEnemy);
  lookupCard('GD05-067').effects.startOfTurn(state, player, zeroEW);
  assert.equal(getKeywords(zeroEW).suppression, true, 'a rested enemy is in play, so Suppression is granted');

  lookupCard('GD05-067').effects.attack(state, player, zeroEW, {});
  assert.equal(activeEnemy.rested, true, 'Attack rested the chosen (highest-AP) enemy');
});

test('Heero Yuy GD05-098 debuffs an enemy AP-3... AP-2 when its paired Unit destroys a shield with damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const wingZero = deployUnit(state, player, { number: 'W', type: 'unit', level: 6, ap: 5, hp: 7 });
  pairPilot(state, player, wingZero, createInstance(lookupCard('GD05-098'), 0));
  const enemyUnit = createInstance({ number: 'E', type: 'unit', ap: 3, hp: 3 }, 1);
  opponent.battleArea.push(enemyUnit);
  opponent.shields.push(createInstance({ number: 'S', type: 'unit', ap: 0, hp: 1 }, 1));

  resolveAttack(state, 0, wingZero, { type: 'player' }, {});

  assert.equal(opponent.shields.length, 0, 'the shield was destroyed by battle damage');
  assert.equal(getAP(enemyUnit), 1, 'Heero Yuy debuffed the enemy Unit AP-2 for the turn');
});

test('Heero Yuy ST02-010 grants its paired Unit AP+1/HP+1 only while that Unit is a Link Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const wingGundam = deployUnit(state, player, lookupCard('ST02-001'));
  wingGundam.pilot = createInstance(lookupCard('ST02-010'), 0);
  assert.equal(getAP(wingGundam), 6, 'apBonus applies immediately, but no During Link bonus yet');

  wingGundam.isLinkUnit = true;
  assert.equal(getAP(wingGundam), 7, 'AP+1 from During Link on top of apBonus');
  assert.equal(getHP(wingGundam), 7, 'HP+1 from During Link on top of hpBonus');
});

test('Naval Bombardment: Burst debuffs the strongest enemy AP-3, Command buffs a friendly Blocker AP+3', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const enemyUnit = createInstance({ number: 'E', type: 'unit', ap: 4, hp: 4 }, 1);
  opponent.battleArea.push(enemyUnit);
  lookupCard('GD01-120').effects.burst(state, player);
  assert.equal(getAP(enemyUnit), 1);

  const blocker = deployUnit(state, player, { number: 'B', type: 'unit', ap: 2, hp: 5, keywords: { blocker: true } });
  lookupCard('GD01-120').effects.command(state, player, createInstance(lookupCard('GD01-120'), 0), {});
  assert.equal(getAP(blocker), 5);
});

test('Peacemillion recovers 2 HP once per turn when a qualifying friendly Unit destroys an enemy with battle damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  lookupCard('GD03-125').effects.burst(state, player, createInstance(lookupCard('GD03-125'), 0));
  const bigUnit = deployUnit(state, player, { number: 'B', type: 'unit', level: 6, ap: 5, hp: 5, traits: ['G Team'] });
  bigUnit.damage = 3;
  const weakEnemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(weakEnemy);

  resolveAttack(state, 0, bigUnit, { type: 'unit', instance: weakEnemy }, {});
  assert.equal(bigUnit.damage, 2, 'took 1 return damage (3+1), then recovered 2 HP after the kill');

  const anotherEnemy = createInstance({ number: 'E2', type: 'unit', ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(anotherEnemy);
  bigUnit.rested = false;
  resolveAttack(state, 0, bigUnit, { type: 'unit', instance: anotherEnemy }, {});
  assert.equal(bigUnit.damage, 3, 'Once per Turn already used -- no second recovery this turn');
});

test("Kindhearted's protection blocks Sazabi's sacrifice-trade from destroying the protected enemy Unit", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const sazabi = deployUnit(state, player, lookupCard('GD05-049'));
  const chaff = deployUnit(state, player, { number: 'C', type: 'unit', level: 1, ap: 1, hp: 1 });
  const protectedTarget = createInstance({ number: 'BT', type: 'unit', level: 8, ap: 6, hp: 6 }, 1);
  opponent.battleArea.push(protectedTarget);
  lookupCard('GD04-101').effects.command(state, opponent);

  lookupCard('GD05-049').effects.attack(state, player, sazabi, { target: { type: 'player' } });

  assert.equal(opponent.battleArea.includes(protectedTarget), true, "Kindhearted's immunity stopped the sacrifice trade");
  assert.equal(player.battleArea.includes(chaff), true, 'no valid enemy target, so the friendly sacrifice never happened either');
});

test('Isaribi rests itself to buff one of its controller\'s damaged Units AP+2, only once while active', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  lookupCard('ST05-015').effects.burst(state, player, createInstance(lookupCard('ST05-015'), 0));
  const hurtUnit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 5 });
  hurtUnit.damage = 2;

  const activated = lookupCard('ST05-015').effects.activateMain(state, player, player.base, {});
  assert.equal(activated, true);
  assert.equal(getAP(hurtUnit), 4);
  assert.equal(player.base.rested, true);

  const secondTry = lookupCard('ST05-015').effects.activateMain(state, player, player.base, {});
  assert.equal(secondTry, false, 'already rested -- cannot activate again this turn');
});

test('Haow Gundam, When Paired, rests another active (MF) Unit to deal 2 damage to all enemy Units at or below its Lv.', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const haow = deployUnit(state, player, lookupCard('GD05-036'));
  const mfBuddy = deployUnit(state, player, { number: 'MF', type: 'unit', level: 4, ap: 3, hp: 3, traits: ['MF'] });
  const lowEnemy = createInstance({ number: 'E1', type: 'unit', level: 3, ap: 1, hp: 2 }, 1);
  const highEnemy = createInstance({ number: 'E2', type: 'unit', level: 8, ap: 1, hp: 8 }, 1);
  opponent.battleArea.push(lowEnemy, highEnemy);

  pairPilot(state, player, haow, createInstance({ number: 'P', name: 'Master Asia', type: 'pilot', traits: [] }, 0));

  assert.equal(mfBuddy.rested, true, 'the other active (MF) Unit was rested to fuel the effect');
  assert.equal(lowEnemy.damage, 2, 'Lv.3 enemy is at or below the rested Lv.4 Unit -- hit');
  assert.equal(highEnemy.damage, 0, 'Lv.8 enemy is above it -- not hit');
});
