const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { applyRepairAtEndOfTurn, triggerEvent } = require('../src/rules/effects');
const { resolveAttack } = require('../src/rules/combat');

function noBlockHooks() {
  return { chooseBlocker: () => null, chooseBurst: () => false };
}

test('Methuss GD02-081 Deploy debuffs an enemy Unit AP-2, but only with a friendly white Base in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 5 });
  deployUnit(state, player, lookupCard('GD02-081'));
  assert.equal(getAP(enemy), 3, 'no white Base yet -- no debuff');

  player.base = createInstance({ number: 'B', type: 'base', color: 'white', ap: 0, hp: 6 }, 0);
  deployUnit(state, player, lookupCard('GD02-081'));
  assert.equal(getAP(enemy), 1, 'white Base in play -- AP-2 applied');
});

test("Gaelio's Schwalbe Graze GD02-082 gains Blocker only while another (Gjallarhorn) Unit is in play", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const schwalbe = deployUnit(state, player, lookupCard('GD02-082'));
  triggerEvent(state, 'startOfTurn', {});
  assert.ok(!getKeywords(schwalbe).blocker, 'alone -- no Blocker');

  deployUnit(state, player, { number: 'G', type: 'unit', ap: 1, hp: 1, traits: ['Gjallarhorn'] });
  triggerEvent(state, 'startOfTurn', {});
  assert.ok(getKeywords(schwalbe).blocker, 'another (Gjallarhorn) Unit in play -- gains Blocker');
});

test('Graze Ritter (Ground Type) GD02-083 Destroyed sets a friendly (Gjallarhorn) Unit active, but only on the opponent\'s turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const grazeRitter = deployUnit(state, player, lookupCard('GD02-083'));
  const ally = deployUnit(state, player, { number: 'G', type: 'unit', ap: 1, hp: 1, traits: ['Gjallarhorn'] });
  ally.rested = true;

  state.activePlayerIdx = 0;
  grazeRitter.damage = 100;
  const { destroyAndFireEffect } = require('../src/rules/combat');
  destroyAndFireEffect(state, player, grazeRitter);
  assert.equal(ally.rested, true, "own turn -- Destroyed's active-setting effect did not fire");

  const grazeRitter2 = deployUnit(state, player, lookupCard('GD02-083'));
  state.activePlayerIdx = 1;
  grazeRitter2.damage = 100;
  destroyAndFireEffect(state, player, grazeRitter2);
  assert.equal(ally.rested, false, "opponent's turn -- set the rested (Gjallarhorn) Unit active");
});

test('Four Murasame (R+) GD02-085 draws a card off its own Repair recovery, During Link, Once per Turn, only with 4 or fewer cards in hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 5, keywords: { repair: 1 } });
  pairPilot(state, player, unit, createInstance(lookupCard('GD02-085'), 0));
  unit.damage = 3;
  for (let i = 0; i < 5; i++) player.hand.push(createInstance({ number: 'H', type: 'unit' }, 0));

  applyRepairAtEndOfTurn(state, player);
  assert.equal(player.hand.length, 5, 'not a Link Unit yet -- no draw');

  unit.isLinkUnit = true;
  for (let i = 0; i < 5; i++) player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));
  applyRepairAtEndOfTurn(state, player);
  assert.equal(player.hand.length, 5, 'still 5+ cards in hand -- no draw');

  player.hand.pop();
  applyRepairAtEndOfTurn(state, player);
  assert.equal(player.hand.length, 5, '4 or fewer in hand and Repair recovered HP -- drew 1');
});

test('Jerid Messa GD02-086 grants his paired Unit AP+1 only while another (Titans) Unit is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 3 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD02-086'), 0));
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(unit), 2 + 1, 'Jerid\'s own printed apBonus only -- no (Titans) ally yet');

  deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 1, traits: ['Titans'] });
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(unit), 2 + 1 + 1, 'another (Titans) Unit in play -- extra AP+1');
});

test('Orga, Crot, and Shani GD02-087 When Linked rests an enemy Blocker, but only if paired with a blue Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const blocker = deployUnit(state, opponent, { number: 'B', type: 'unit', ap: 1, hp: 5, keywords: { blocker: true } });
  const greenUnit = deployUnit(state, player, { number: 'G', type: 'unit', color: 'green', ap: 1, hp: 1, level: 5, linkCondition: 'Biological CPU' });
  pairPilot(state, player, greenUnit, createInstance(lookupCard('GD02-087'), 0));
  assert.equal(blocker.rested, false, 'green Unit -- When Linked did not rest the Blocker');

  const blueUnit = deployUnit(state, player, { number: 'U', type: 'unit', color: 'blue', ap: 1, hp: 1, level: 5, linkCondition: 'Biological CPU' });
  pairPilot(state, player, blueUnit, createInstance(lookupCard('GD02-087'), 0));
  assert.equal(blocker.rested, true, 'blue Unit -- When Linked rested the enemy Blocker');
});

test('Flit Asuno (R+) GD02-088 When Linked digs 3 for a green (Earth Federation) Unit or an "AGE Device" card', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const match = createInstance({ number: 'M', name: 'AGE Device Total Eclipse', type: 'command', color: 'green' }, 0);
  const filler1 = createInstance({ number: 'F1', type: 'unit', color: 'red' }, 0);
  const filler2 = createInstance({ number: 'F2', type: 'unit', color: 'red' }, 0);
  player.deck.push(filler1, match, filler2);

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 5, level: 5, linkCondition: 'X-Rounder' });
  pairPilot(state, player, unit, createInstance(lookupCard('GD02-088'), 0));
  assert.ok(player.hand.includes(match), 'found the "AGE Device" card among the top 3');
  assert.equal(player.deck.length, 2, 'the other 2 were shuffled back');
});

test("Lalah Sune GD02-089 When Paired grants Breach 1 to another friendly (Zeon) Link Unit for the turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const zeonLink = deployUnit(state, player, { number: 'Z', type: 'unit', ap: 3, hp: 3, traits: ['Zeon'] });
  zeonLink.isLinkUnit = true;

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, level: 5 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD02-089'), 0));
  assert.equal(getKeywords(zeonLink).breach, 1, 'granted Breach 1 to the other (Zeon) Link Unit');
});

test('Challia Bull (GQ) GD02-090 grants her paired Unit AP+1 only while another High-Maneuver Unit is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 3 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD02-090'), 0));
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(unit), 2 + 1, "Challia's own printed apBonus only -- no High-Maneuver ally yet");

  deployUnit(state, player, { number: 'H', type: 'unit', ap: 1, hp: 1, keywords: { highManeuver: true } });
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(unit), 2 + 1 + 1, 'another High-Maneuver Unit in play -- extra AP+1');
});

test('Haman Karn (R+) GD02-091 When Paired deals 1 damage to a same-or-lower-Lv enemy Unit, but only if paired with a red Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const highLevelEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', level: 6, ap: 1, hp: 5 });
  const lowLevelEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', level: 3, ap: 1, hp: 5 });

  const greenUnit = deployUnit(state, player, { number: 'G', type: 'unit', color: 'green', ap: 1, hp: 1, level: 5 });
  pairPilot(state, player, greenUnit, createInstance(lookupCard('GD02-091'), 0));
  assert.equal(lowLevelEnemy.damage, 0, 'green Unit -- When Paired did not fire');

  const redUnit = deployUnit(state, player, { number: 'R', type: 'unit', color: 'red', ap: 1, hp: 1, level: 5 });
  pairPilot(state, player, redUnit, createInstance(lookupCard('GD02-091'), 0));
  assert.equal(highLevelEnemy.damage, 0, "too high a Lv. to be a legal target");
  assert.equal(lowLevelEnemy.damage, 1, 'red Unit -- dealt 1 damage to the Lv.3 enemy');
});

test('Shagia Frost GD02-092 Attack buffs a friendly (New UNE) Unit AP+2 for the turn, During Link only', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const newUne = deployUnit(state, player, { number: 'N', type: 'unit', ap: 2, hp: 2, traits: ['New UNE'] });
  const attacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 2, hp: 5, level: 5 });
  attacker.turnDeployed = -1;
  pairPilot(state, player, attacker, createInstance(lookupCard('GD02-092'), 0));

  resolveAttack(state, 0, attacker, { type: 'player' }, noBlockHooks());
  assert.equal(getAP(newUne), 2, 'not a Link Unit -- no buff');

  attacker.isLinkUnit = true;
  attacker.rested = false;
  resolveAttack(state, 0, attacker, { type: 'player' }, noBlockHooks());
  assert.equal(getAP(newUne), 2 + 2, 'During Link -- AP+2 granted to the (New UNE) ally');
});

test('Olba Frost GD02-093 draws a card when its Unit destroys an enemy paired with a (Newtype) Pilot', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const nonNewtypeEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1 });
  nonNewtypeEnemy.turnDeployed = -1;

  const attacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 5, hp: 5, level: 5 });
  pairPilot(state, player, attacker, createInstance(lookupCard('GD02-093'), 0));
  player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));

  resolveAttack(state, 0, attacker, { type: 'unit', instance: nonNewtypeEnemy }, noBlockHooks());
  assert.equal(player.hand.length, 0, 'destroyed enemy had no Pilot -- no draw');

  attacker.rested = false;
  const newtypeEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });
  newtypeEnemy.turnDeployed = -1;
  pairPilot(state, opponent, newtypeEnemy, createInstance({ number: 'P', type: 'pilot', traits: ['Newtype'] }, 1));
  resolveAttack(state, 0, attacker, { type: 'unit', instance: newtypeEnemy }, noBlockHooks());
  assert.equal(player.hand.length, 1, 'destroyed enemy paired with a (Newtype) Pilot -- drew 1');
});

test('Garrod Ran & Tiffa Adill (R+) GD02-094 When Paired discards 1 to dig 3 for a (Vulture) Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const vulture = createInstance({ number: 'V', type: 'unit', traits: ['Vulture'] }, 0);
  const filler1 = createInstance({ number: 'F1', type: 'unit' }, 0);
  const filler2 = createInstance({ number: 'F2', type: 'unit' }, 0);
  player.deck.push(filler1, vulture, filler2);
  const discardFodder = createInstance({ number: 'C', type: 'unit', cost: 1 }, 0);
  player.hand.push(discardFodder);

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, level: 5 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD02-094'), 0));

  assert.ok(!player.hand.includes(discardFodder), 'discarded a card as the cost');
  assert.ok(player.hand.includes(vulture), 'found the (Vulture) Unit among the top 3');
  assert.equal(player.deck.length, 2, 'the other 2 were shuffled back');
});
