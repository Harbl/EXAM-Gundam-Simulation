const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const registry = require('../src/effects/registry');

test('Gundam Barbatos 4th Form ST05-001: keywordWhileDamaged grants Suppression only once damaged; Deploy damages+buffs another Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 5, keywordWhileDamaged: 'suppression' });
  assert.equal(getKeywords(instance).suppression, undefined);
  instance.damage = 1;
  assert.equal(getKeywords(instance).suppression, true);

  const other = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 3 });
  registry.gundamBarbatos4thFormDeploy(state, player, instance, {});
  assert.equal(other.damage, 1);
  assert.equal(getAP(other), 3);
});

test('Gundam Barbatos 2nd Form ST05-002: apBonusWhileDamaged only applies once damaged', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 4, apBonusWhileDamaged: 2 });
  assert.equal(getAP(instance), 2);
  instance.damage = 1;
  assert.equal(getAP(instance), 4);
});

test('CGS Mobile Worker ST05-003: Activate Main rests itself, damages + buffs a chosen friendly Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 0, hp: 2 });
  const result = registry.cgsMobileWorkerActivateMain(state, player, instance, {});
  assert.equal(result, true);
  assert.equal(instance.rested, true);
  assert.equal(instance.damage, 1, 'chose itself as the only candidate');
  assert.equal(getAP(instance), 1);
});

test('Gundam Gusion Rebake ST05-005: Destroyed rests a 4-or-less-AP enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 4, hp: 3 });
  const outOfRange = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 5, hp: 3 });
  registry.gundamGusionRebakeST05005Destroyed(state, player);
  assert.equal(target.rested, true);
  assert.equal(outOfRange.rested, false);
});

test("McGillis' Schwalbe Graze ST05-007: whenPaired gives a Lv.3-or-lower enemy AP-2", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 3 });
  registry.mcgillisSchwalbeGrazeWhenPaired(state, player, null, {});
  assert.equal(target.buffs.some((b) => b.ap === -2), true);
});

test('McGillis Fareed ST05-012: whenPaired rests a 3-or-less-HP enemy only with 2+ other (Gjallarhorn)/(Tekkadan) Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3 });
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });

  registry.mcgillisFareedWhenPaired(state, player, unit, {});
  assert.equal(target.rested, false, 'no other qualifying Units yet');

  deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['Gjallarhorn'] });
  deployUnit(state, player, { number: 'U3', type: 'unit', ap: 1, hp: 1, traits: ['Tekkadan'] });
  registry.mcgillisFareedWhenPaired(state, player, unit, {});
  assert.equal(target.rested, true);
});

test('With Iron and Blood ST05-013: Command damages + buffs a friendly Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3 });
  registry.withIronAndBloodCommand(state, player, null, {});
  assert.equal(target.damage, 1);
  assert.equal(getAP(target), 5);
});

test('Fatal Strike ST05-014: Burst deals 1 damage; Main destroys a Lv.3-or-lower enemy outright', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const burstTarget = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  registry.fatalStrikeBurst(state, player, null, {});
  assert.equal(burstTarget.damage, 1);

  const lowLevel = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 5, hp: 5, level: 3 });
  const highLevel = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 1, level: 4 });
  registry.fatalStrikeCommand(state, player, null, {});
  assert.equal(opponent.battleArea.includes(lowLevel), false);
  assert.equal(opponent.battleArea.includes(highLevel), true, 'Lv.4 is out of range');
});
