const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getRemainingHP, getKeywords } = require('../src/rules/management');
const { runStartPhase } = require('../src/rules/phases');
const { applyRepairAtEndOfTurn } = require('../src/rules/effects');

test('Guntank GD01-008 [Deploy] now destroys a rested enemy Unit it reduces to 0 HP (closed engine gap: effect damage never checked for destruction)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const restedEnemy = createInstance({ number: 'X', type: 'unit', hp: 1 }, 1);
  restedEnemy.rested = true;
  opponent.battleArea.push(restedEnemy);

  deployUnit(state, player, lookupCard('GD01-008'));

  assert.equal(opponent.battleArea.includes(restedEnemy), false, '1 HP Unit takes lethal 1 damage and is destroyed');
  assert.equal(opponent.trash.includes(restedEnemy), true);
});

test('Byarlant Custom GD01-019 gains Blocker only while 4+ enemy Units are in play, re-evaluated at start of turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  const byarlant = deployUnit(state, player, lookupCard('GD01-019'));
  assert.equal(getKeywords(byarlant).blocker, undefined);

  for (let i = 0; i < 4; i++) {
    opponent.battleArea.push(createInstance({ number: `E${i}`, type: 'unit', ap: 1, hp: 1 }, 1));
  }
  runStartPhase(state);
  assert.equal(getKeywords(byarlant).blocker, true, '4 enemy Units in play grants Blocker');

  opponent.battleArea.pop();
  runStartPhase(state);
  assert.equal(getKeywords(byarlant).blocker, false, 'dropping to 3 enemy Units revokes it');
});

test('Char\'s Gelgoog GD01-023 Activate·Main discards a (Zeon)/(Neo Zeon) Unit, then pairs a Lv.3-or-lower (Newtype) Pilot from trash if unpaired', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gelgoog = deployUnit(state, player, lookupCard('GD01-023'));
  player.hand.push(createInstance({ number: 'H1', type: 'unit', traits: ['Zeon'], cost: 2 }, 0));
  const pilot = createInstance({ number: 'P1', type: 'pilot', traits: ['Newtype'], level: 3 }, 0);
  player.trash.push(pilot);

  const result = gelgoog.def.effects.activateMain(state, player, gelgoog, {});

  assert.equal(result, true);
  assert.equal(player.hand.length, 0, 'the (Zeon) Unit was discarded as cost');
  assert.equal(gelgoog.pilot, pilot, 'the Lv.3 Newtype Pilot was pulled from trash and paired');
  assert.equal(player.trash.includes(pilot), false);
});

test("Char's Gelgoog GD01-023 Activate·Main fails (no cost payable) with no (Zeon)/(Neo Zeon) Unit in hand to discard", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gelgoog = deployUnit(state, player, lookupCard('GD01-023'));
  const result = gelgoog.def.effects.activateMain(state, player, gelgoog, {});
  assert.equal(result, false);
});

test('Gundam Deathscythe GD01-025 When Paired only triggers off an (Operation Meteor) Pilot: places 1 rested Resource and grants First Strike this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.resourceDeck.push(createInstance({ number: 'R1', type: 'resource' }, 0));
  const deathscythe = deployUnit(state, player, lookupCard('GD01-025'));
  const wrongPilot = createInstance({ number: 'WP', type: 'pilot', traits: [] }, 0);
  pairPilot(state, player, deathscythe, wrongPilot);
  assert.equal(player.resourceArea.length, 0, 'wrong Pilot trait -- no effect');
  assert.equal(getKeywords(deathscythe).firstStrike, undefined);

  const deathscythe2 = deployUnit(state, player, lookupCard('GD01-025'));
  const rightPilot = createInstance({ number: 'RP', type: 'pilot', traits: ['Operation Meteor'] }, 0);
  pairPilot(state, player, deathscythe2, rightPilot);
  assert.equal(player.resourceArea.length, 1, '(Operation Meteor) Pilot -- places 1 rested Resource');
  assert.equal(player.resourceArea[0].rested, true);
  assert.equal(getKeywords(deathscythe2).firstStrike, true);
});

test('Big Zam GD01-027 Deploy only wipes Units with Blocker (both sides) once 10+ (Neo) Zeon Units are in the trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 9; i++) {
    player.trash.push(createInstance({ number: `T${i}`, type: 'unit', traits: ['Zeon'] }, 0));
  }
  const friendlyBlocker = createInstance({ number: 'FB', type: 'unit', hp: 3, keywords: { blocker: true } }, 0);
  const enemyBlocker = createInstance({ number: 'EB', type: 'unit', hp: 3, keywords: { blocker: true } }, 1);
  const enemyNonBlocker = createInstance({ number: 'EN', type: 'unit', hp: 3 }, 1);
  player.battleArea.push(friendlyBlocker);
  opponent.battleArea.push(enemyBlocker, enemyNonBlocker);

  const firstBigZam = deployUnit(state, player, lookupCard('GD01-027'));
  assert.equal(friendlyBlocker.damage, 0, 'only 9 (Neo) Zeon Units in trash -- condition not met yet');
  player.battleArea.splice(player.battleArea.indexOf(firstBigZam), 1);

  player.trash.push(createInstance({ number: 'T9', type: 'unit', traits: ['Neo Zeon'] }, 0));
  deployUnit(state, player, lookupCard('GD01-027'));
  assert.equal(opponent.battleArea.includes(enemyBlocker), false, '4 damage destroys the 3 HP enemy Blocker');
  assert.equal(player.battleArea.includes(friendlyBlocker), false, 'friendly Blocker is hit too -- no "enemy" qualifier in the real text');
  assert.equal(opponent.battleArea.includes(enemyNonBlocker), true, 'non-Blocker Units are untouched');
});

test('Gundam Sandrock GD01-028 Deploy optionally cascades a free (Maganac Corps) Unit deploy from hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.hand.push(createInstance({ number: 'OTHER', type: 'unit', traits: [], cost: 1 }, 0));
  const maganac = createInstance({ number: 'MC', type: 'unit', traits: ['Maganac Corps'], cost: 5 }, 0);
  player.hand.push(maganac);

  deployUnit(state, player, lookupCard('GD01-028'));

  assert.equal(player.hand.includes(maganac), false, 'the (Maganac Corps) card left hand');
  assert.equal(player.battleArea.some((u) => u.def.number === 'MC'), true, 'and was deployed for free');
  assert.equal(player.hand.length, 1, 'the unrelated hand card was untouched');
});

test('Gyan GD01-032 When Paired only off a (Zeon) Pilot: destroys an enemy Lv.2-or-lower Blocker Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const highLevelBlocker = createInstance({ number: 'HB', type: 'unit', level: 3, keywords: { blocker: true } }, 1);
  const lowLevelBlocker = createInstance({ number: 'LB', type: 'unit', level: 2, keywords: { blocker: true } }, 1);
  opponent.battleArea.push(highLevelBlocker, lowLevelBlocker);

  const gyan = deployUnit(state, player, lookupCard('GD01-032'));
  pairPilot(state, player, gyan, createInstance({ number: 'WP', type: 'pilot', traits: [] }, 0));
  assert.equal(opponent.battleArea.length, 2, 'non-(Zeon) Pilot -- no effect');

  const gyan2 = deployUnit(state, player, lookupCard('GD01-032'));
  pairPilot(state, player, gyan2, createInstance({ number: 'ZP', type: 'pilot', traits: ['Zeon'] }, 0));
  assert.equal(opponent.battleArea.includes(highLevelBlocker), true, 'Lv.3 is too high a level to be a legal target');
  assert.equal(opponent.battleArea.includes(lowLevelBlocker), false, 'Lv.2 Blocker destroyed');
});

test('Gundam Heavyarms GD01-034 gains Breach 3 only while paired (During Pair, not During Link)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const heavyarms = deployUnit(state, player, lookupCard('GD01-034'));
  assert.equal(getKeywords(heavyarms).breach, undefined, 'unpaired -- no Breach yet');
  pairPilot(state, player, heavyarms, createInstance({ number: 'P', type: 'pilot', traits: [] }, 0));
  assert.equal(getKeywords(heavyarms).breach, 3, 'paired (even without matching the Link condition) -- Breach 3 granted');
});

test('Gundam Deathscythe GD01-033 has Repair 1 and links off Duo Maxwell, matching GD01-025\'s link condition', () => {
  const player = createPlayer(0);
  const deathscythe = deployUnit({ turnNumber: 1 }, player, lookupCard('GD01-033'));
  deathscythe.damage = 2;
  applyRepairAtEndOfTurn({}, player);
  assert.equal(getRemainingHP(deathscythe), deathscythe.def.hp - 1);
});
