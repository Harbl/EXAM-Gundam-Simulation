const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const registry = require('../src/effects/registry');

test('Ruthless Tactics ST06-011: Command gives up to 2 friendly (Clan) Units AP+2 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const clanA = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['Clan'] });
  const clanB = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['Clan'] });
  const nonClan = deployUnit(state, player, { number: 'U3', type: 'unit', ap: 3, hp: 3 });
  registry.ruthlessTacticsCommand(state, player, null, {});
  assert.equal(clanA.buffs.some((b) => b.ap === 2), true);
  assert.equal(clanB.buffs.some((b) => b.ap === 2), true);
  assert.equal(nonClan.buffs.some((b) => b.ap === 2), false);
});

test('Fierce Unity ST06-013: Command grants up to 2 friendly (Clan) Units Lv.2-or-lower battle immunity for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const clan = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['Clan'] });
  registry.fierceUnityCommand(state, player, null, {});
  assert.equal(clan.buffs.some((b) => b.lowLevelEnemyDamageImmuneCap === 2), true);
});

test('Clan Battle ST06-014: Activate Main requires a friendly (Clan) Link Unit, rests itself, gives a friendly Unit AP+2', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = { rested: false };
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });

  assert.equal(registry.clanBattleActivateMain(state, player, instance, {}), false, 'no Clan Link Unit yet');

  const linkUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['Clan'] });
  linkUnit.isLinkUnit = true;
  const result = registry.clanBattleActivateMain(state, player, instance, {});
  assert.equal(result, true);
  assert.equal(instance.rested, true);
  assert.equal(target.buffs.some((b) => b.ap === 2), true);
});

test("Kaneban Co., Ltd. ST06-015: allyPaired grants Breach 3 to a linking friendly (Clan) Unit, Once per Turn", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = { activationsUsed: {} };
  const linked = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['Clan'] });
  linked.isLinkUnit = true;

  registry.kanebanCoLtdAllyPaired(state, player, instance, { pairedUnit: linked });
  assert.equal(linked.buffs.some((b) => b.breach === 3), true);

  const secondLink = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, traits: ['Clan'] });
  secondLink.isLinkUnit = true;
  registry.kanebanCoLtdAllyPaired(state, player, instance, { pairedUnit: secondLink });
  assert.equal(secondLink.buffs.some((b) => b.breach === 3), false, 'Once per Turn: no second grant');
});
