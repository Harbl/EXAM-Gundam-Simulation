const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { runStartPhase } = require('../src/rules/phases');
const { canAfford } = require('../src/rules/cost');

function resource() {
  return createInstance({ number: 'RESOURCE', name: 'Resource', type: 'resource' }, 0);
}

test('Gundam Aerial Rebuild GD01-067 When Paired pulls a Lv.5-or-lower Command card from trash to hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const cmd = createInstance({ number: 'C1', type: 'command', level: 5, cost: 3 }, 0);
  const tooHigh = createInstance({ number: 'C2', type: 'command', level: 6, cost: 9 }, 0);
  player.trash.push(cmd, tooHigh);
  const aerial = deployUnit(state, player, lookupCard('GD01-067'));
  aerial.def.effects.whenPaired(state, player, aerial, {});
  assert.equal(player.hand.includes(cmd), true, 'Lv.5 Command is a legal target');
  assert.equal(player.hand.includes(tooHigh), false, 'Lv.6 is too high');
});

test('Perfect Strike Gundam GD01-068 / Darilbalde GD01-075 Deploy bounces an enemy Unit with exactly 1 remaining HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const oneHp = createInstance({ number: 'ONE', type: 'unit', hp: 3 }, 1);
  oneHp.damage = 2; // 1 remaining
  const twoHp = createInstance({ number: 'TWO', type: 'unit', hp: 3 }, 1);
  twoHp.damage = 1; // 2 remaining -- not a legal target
  opponent.battleArea.push(oneHp, twoHp);

  deployUnit(state, player, lookupCard('GD01-068'));
  assert.equal(opponent.battleArea.includes(oneHp), false, 'bounced to hand');
  assert.equal(opponent.hand.includes(oneHp), true);
  assert.equal(opponent.battleArea.includes(twoHp), true, '2 remaining HP is not a legal target');
});

test('Strike Rouge GD01-069 Activate·Main costs 1 Resource, Once per Turn, unrests a rested white Blocker and stops it attacking this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const rouge = deployUnit(state, player, lookupCard('GD01-069'));
  player.resourceArea.push(resource());
  const blocker = deployUnit(state, player, { number: 'B', type: 'unit', color: 'white', ap: 1, hp: 3, keywords: { blocker: true } });
  blocker.rested = true;
  const nonBlocker = deployUnit(state, player, { number: 'NB', type: 'unit', color: 'white', ap: 1, hp: 3 });
  nonBlocker.rested = true;

  const result = rouge.def.effects.activateMain(state, player, rouge, {});
  assert.equal(result, true);
  assert.equal(blocker.rested, false, 'set active');
  assert.equal(nonBlocker.rested, true, 'not a Blocker -- ineligible');
  assert.equal(player.resourceArea[0].rested, true);

  const secondTry = rouge.def.effects.activateMain(state, player, rouge, {});
  assert.equal(secondTry, false, 'Once per Turn');
});

test('Gundam Aerial GD01-070 costs 2 less in hand only once 4+ Command cards are in trash', () => {
  const player = createPlayer(0);
  const def = lookupCard('GD01-070');
  // Lv.5 -- needs 5 Resources in play (active or rested) just to satisfy the Level requirement.
  player.resourceArea.push(resource(), resource(), resource(), resource(), resource());
  assert.equal(canAfford(player, def), true, 'full cost of 3 is payable with 5 active Resources');

  for (const r of player.resourceArea.slice(0, 4)) r.rested = true; // only 1 left active
  assert.equal(canAfford(player, def), false, 'only 1 active Resource -- not enough for cost 3 yet');

  for (let i = 0; i < 4; i++) player.trash.push(createInstance({ number: `CMD${i}`, type: 'command' }, 0));
  assert.equal(canAfford(player, def), true, '4+ Command cards in trash drops the cost to 1, payable with 1 active Resource');
});

test('Gundam Pharact GD01-071 Attack debuffs a chosen enemy Unit AP-2 for the battle, but only While Linked', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 3, hp: 5 }, 1);
  opponent.battleArea.push(enemy);
  const pharact = deployUnit(state, player, lookupCard('GD01-071'));

  pharact.def.effects.attack(state, player, pharact, { target: { type: 'player' } });
  assert.equal(getAP(enemy), 3, 'not a Link Unit yet -- no debuff');

  pharact.isLinkUnit = true;
  pharact.def.effects.attack(state, player, pharact, { target: { type: 'player' } });
  assert.equal(getAP(enemy), 1, 'now Linked -- the strongest enemy Unit gets AP-2 for the battle');
});

test("Chuchu's Demi Trainer GD01-074 Attack draws 1 then discards the highest-cost hand card", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  const cheap = createInstance({ number: 'CHEAP', type: 'unit', cost: 1 }, 0);
  player.hand.push(cheap);

  deployUnit(state, player, lookupCard('GD01-074')).def.effects.attack(state, player);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true, 'drew 1');
  assert.equal(player.hand.includes(cheap), false, 'the higher-cost pre-existing card was discarded, not the newly drawn 0-cost one');
});

test('Michaelis GD01-076 gets AP+1/HP+1 only while 4+ Command cards are in trash, re-evaluated at start of turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const michaelis = deployUnit(state, player, lookupCard('GD01-076'));
  runStartPhase(state);
  assert.equal(getAP(michaelis), 3);
  assert.equal(getRemainingHP(michaelis), 3);

  for (let i = 0; i < 4; i++) player.trash.push(createInstance({ number: `CMD${i}`, type: 'command' }, 0));
  runStartPhase(state);
  assert.equal(getAP(michaelis), 4);
  assert.equal(getRemainingHP(michaelis), 4);
});

test('Mistral GD01-078 Deploy gives a chosen enemy Unit AP-1 for the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 3, hp: 3 }, 1);
  opponent.battleArea.push(enemy);
  deployUnit(state, player, lookupCard('GD01-078'));
  assert.equal(getAP(enemy), 2);
});

test("Cagalli's Skygrasper GD01-080 Destroyed bounces an enemy Unit at Lv.2 or lower", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowLevel = createInstance({ number: 'LO', type: 'unit', level: 2 }, 1);
  const highLevel = createInstance({ number: 'HI', type: 'unit', level: 3 }, 1);
  opponent.battleArea.push(lowLevel, highLevel);
  const skygrasper = deployUnit(state, player, lookupCard('GD01-080'));

  skygrasper.def.effects.destroyed(state, player, skygrasper, {});
  assert.equal(opponent.battleArea.includes(lowLevel), false, 'Lv.2 bounced to hand');
  assert.equal(opponent.hand.includes(lowLevel), true);
  assert.equal(opponent.battleArea.includes(highLevel), true, 'Lv.3 is too high a level');
});

test('M1 Astray GD01-081 gets AP+1 and Blocker only while another (Triple Ship Alliance) Unit is in play, re-evaluated at start of turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const m1 = deployUnit(state, player, lookupCard('GD01-081'));
  runStartPhase(state);
  assert.equal(getAP(m1), 2);
  assert.equal(getKeywords(m1).blocker, false);

  deployUnit(state, player, { number: 'ALLY', type: 'unit', traits: ['Triple Ship Alliance'], ap: 1, hp: 1 });
  runStartPhase(state);
  assert.equal(getAP(m1), 3);
  assert.equal(getKeywords(m1).blocker, true);
});
