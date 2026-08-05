const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { dealDamage } = require('../src/rules/management');
const registry = require('../src/effects/registry');

test('Gundam (MA Form) ST01-002: whenPaired draws 1, but only for a (White Base Team) Pilot', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const nonWhiteBasePilot = createInstance({ number: 'P1', type: 'pilot', traits: ['Zeon'] }, 0);
  registry.gundamMAFormWhenPaired(state, player, null, { pilot: nonWhiteBasePilot });
  assert.equal(player.hand.length, 0, 'no draw for a non-(White Base Team) Pilot');

  const whiteBasePilot = createInstance({ number: 'P2', type: 'pilot', traits: ['White Base Team'] }, 0);
  registry.gundamMAFormWhenPaired(state, player, null, { pilot: whiteBasePilot });
  assert.equal(player.hand.length, 1, 'draws 1 for a (White Base Team) Pilot');
});

test('Guntank ST01-004: Deploy rests an enemy Unit with 2 or less HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const low = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 2 });
  const high = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5 });
  registry.guntankST01004Deploy(state, player, null, {});
  assert.equal(low.rested, true);
  assert.equal(high.rested, false);
});

test('Gundam Aerial (Permet Score Six) ST01-006: whenPaired gives a Lv.5-or-lower enemy AP-3', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const eligible = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 4, hp: 4, level: 5 });
  const tooHigh = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 4, hp: 4, level: 6 });
  registry.gundamAerialPermetScoreSixWhenPaired(state, player, null, {});
  assert.equal(eligible.buffs.some((b) => b.ap === -3), true);
  assert.equal(tooHigh.buffs.some((b) => b.ap === -3), false);
});

test('Suletta Mercury ST01-011: Attack, Once per Turn sets a rested Resource active', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = { activationsUsed: {} };
  const resource = createInstance({ number: 'R1', type: 'resource' }, 0);
  resource.rested = true;
  player.resourceArea.push(resource);
  registry.sulettaMercuryAttack(state, player, instance);
  assert.equal(resource.rested, false);

  const second = createInstance({ number: 'R2', type: 'resource' }, 0);
  second.rested = true;
  player.resourceArea.push(second);
  registry.sulettaMercuryAttack(state, player, instance);
  assert.equal(second.rested, true, 'Once per Turn: no second activation');
});

test("Thoroughly Damaged ST01-012: Command deals 1 damage to a rested enemy Unit", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  target.rested = true;
  registry.thoroughlyDamagedCommand(state, player, null, {});
  assert.equal(target.damage, 1);
});

test("Kai's Resolve ST01-013: Command heals a friendly Unit 3", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 5 });
  dealDamage(target, 4);
  registry.kaisResolveCommand(state, player, null, {});
  assert.equal(target.damage, 1);
});

test('Asticassia School of Technology, Earth House ST01-016: Activate Main rests itself and buffs Link Units AP+1, Once per Turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = { rested: false };
  const linked = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });
  linked.isLinkUnit = true;

  const result = registry.asticassiaEarthHouseActivateMain(state, player, instance);
  assert.equal(result, true);
  assert.equal(instance.rested, true);
  assert.equal(linked.buffs.some((b) => b.ap === 1), true);

  const again = registry.asticassiaEarthHouseActivateMain(state, player, instance);
  assert.equal(again, false, 'already rested: no second activation');
});
