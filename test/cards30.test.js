const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, playCommand } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');

test('Decisive Last Resort GD02-111 Burst deals 2 to a Lv.3-or-lower enemy, Main exiles 6 purple Units to destroy an enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const lowLv = deployUnit(state, opponent, { number: 'L', type: 'unit', ap: 1, hp: 5, level: 3 });
  const highLv = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 1, hp: 5, level: 4 });
  const { decisiveLastResortBurst } = require('../src/effects/registry');
  decisiveLastResortBurst(state, player);
  assert.equal(lowLv.damage, 2, 'Lv.3 enemy hit for 2');
  assert.equal(highLv.damage, 0, 'Lv.4 enemy is too high a Lv. to be a legal target');

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 5, hp: 5, level: 5 });
  for (let i = 0; i < 5; i++) player.trash.push(createInstance({ number: 'P', type: 'unit', color: 'purple' }, 0));
  playCommand(state, player, lookupCard('GD02-111'));
  assert.equal(player.removal.length, 0, 'fewer than 6 purple Units in trash -- no effect');
  assert.equal(enemy.damage, 0);

  player.trash.push(createInstance({ number: 'P6', type: 'unit', color: 'purple' }, 0));
  playCommand(state, player, lookupCard('GD02-111'));
  assert.equal(player.removal.length, 6, 'exiled the 6 purple Units');
  assert.equal(opponent.battleArea.includes(enemy), false, 'destroyed the chosen enemy Unit');
});

test('Momentary Respite (R+) GD02-112 Burst draws 1, Main retrieves a purple Pilot from trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));

  const { momentaryRespiteBurst } = require('../src/effects/registry');
  momentaryRespiteBurst(state, player);
  assert.equal(player.hand.length, 1, 'Burst drew 1');

  playCommand(state, player, lookupCard('GD02-112'));
  assert.equal(player.hand.length, 1, 'no purple Pilot in trash -- no retrieval');

  const purplePilot = createInstance({ number: 'PP', type: 'pilot', color: 'purple' }, 0);
  player.trash.push(purplePilot);
  playCommand(state, player, lookupCard('GD02-112'));
  assert.ok(player.hand.includes(purplePilot), 'retrieved the purple Pilot from trash');
});

test('Sisterly Care GD02-113 destroys a 2-AP-or-lower enemy Unit only with a friendly (Teiwaz) Link Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const weakEnemy = deployUnit(state, opponent, { number: 'W', type: 'unit', ap: 2, hp: 3 });
  playCommand(state, player, lookupCard('GD02-113'));
  assert.ok(opponent.battleArea.includes(weakEnemy), 'no (Teiwaz) Link Unit in play -- no effect');

  const teiwazUnit = deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 1, traits: ['Teiwaz'] });
  teiwazUnit.isLinkUnit = true;
  playCommand(state, player, lookupCard('GD02-113'));
  assert.equal(opponent.battleArea.includes(weakEnemy), false, 'destroyed the 2-AP enemy Unit');
});

test("It's Name is Ryusei-Go GD02-114 buffs a damaged friendly Unit AP+2 for the turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const undamaged = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 3 });
  playCommand(state, player, lookupCard('GD02-114'));
  assert.equal(getAP(undamaged), 2, 'not damaged -- no legal target, no buff');

  undamaged.damage = 1;
  playCommand(state, player, lookupCard('GD02-114'));
  assert.equal(getAP(undamaged), 4, 'damaged -- AP+2 for the turn');
});

test('Familial Devotion GD02-115 buffs a friendly (Vulture) Unit AP+2 for the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const vultureUnit = deployUnit(state, player, { number: 'V', type: 'unit', ap: 1, hp: 1, traits: ['Vulture'] });
  playCommand(state, player, lookupCard('GD02-115'));
  assert.equal(getAP(vultureUnit), 3);
});

test('Comrades Come First GD02-116 lets a friendly (Vulture) Unit target an active Lv.4-or-lower enemy, only with 7+ cards in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const vultureUnit = deployUnit(state, player, { number: 'V', type: 'unit', ap: 1, hp: 1, traits: ['Vulture'] });
  playCommand(state, player, lookupCard('GD02-116'));
  assert.equal(vultureUnit.buffs.some((b) => b.activeTargetLevelCap === 4), false, 'fewer than 7 cards in trash -- no effect');

  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: 'T', type: 'unit' }, 0));
  playCommand(state, player, lookupCard('GD02-116'));
  assert.ok(vultureUnit.buffs.some((b) => b.activeTargetLevelCap === 4), '7+ cards in trash -- granted the active-target buff');
});

test('A New Sign GD02-117 Burst retrieves an (AEUG) Base from trash, Main draws 3 then discards 2', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const { aNewSignBurst } = require('../src/effects/registry');
  aNewSignBurst(state, player);
  assert.equal(player.hand.length, 0, 'no (AEUG) Base in trash -- no retrieval');

  const aeugBase = createInstance({ number: 'B', type: 'base', traits: ['AEUG'] }, 0);
  player.trash.push(aeugBase);
  aNewSignBurst(state, player);
  assert.ok(player.hand.includes(aeugBase), 'retrieved the (AEUG) Base from trash');

  player.hand.length = 0;
  for (let i = 0; i < 3; i++) player.deck.push(createInstance({ number: 'D', type: 'unit', cost: i }, 0));
  playCommand(state, player, lookupCard('GD02-117'));
  assert.equal(player.hand.length, 1, 'drew 3, discarded 2 -- net 1 remaining');
});

test('Heart Set on Revenge GD02-118 Action bounces a 4-HP-or-lower enemy attacker battling a friendly Blocker', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 3, hp: 4 });
  const blocker = deployUnit(state, player, { number: 'B', type: 'unit', ap: 1, hp: 3, keywords: { blocker: true } });
  const nonBlocker = deployUnit(state, player, { number: 'N', type: 'unit', ap: 1, hp: 3 });
  const { heartSetOnRevengeCommand } = require('../src/effects/registry');

  heartSetOnRevengeCommand(state, player, null, { attacker, defender: nonBlocker });
  assert.ok(opponent.battleArea.includes(attacker), 'defender has no Blocker -- no effect');

  heartSetOnRevengeCommand(state, player, null, { attacker, defender: blocker });
  assert.equal(opponent.battleArea.includes(attacker), false, 'attacker removed from field');
  assert.ok(opponent.hand.includes(attacker), 'returned to owner hand');
});

test('Persistent and Fortitudinous GD02-119 debuffs an enemy AP-3 for the battle, only with a (Gjallarhorn) Link Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 5 });
  playCommand(state, player, lookupCard('GD02-119'));
  assert.equal(getAP(enemy), 4, 'no (Gjallarhorn) Link Unit -- no debuff');

  const gjallarhornUnit = deployUnit(state, player, { number: 'G', type: 'unit', ap: 1, hp: 1, traits: ['Gjallarhorn'] });
  gjallarhornUnit.isLinkUnit = true;
  playCommand(state, player, lookupCard('GD02-119'));
  assert.equal(getAP(enemy), 1, '(Gjallarhorn) Link Unit in play -- AP-3 applied');
});

test('Aspiring Pilot GD02-120 recovers 2 HP on one of your (AEUG) Units/Bases', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const aeugUnit = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 5, traits: ['AEUG'] });
  aeugUnit.damage = 3;
  playCommand(state, player, lookupCard('GD02-120'));
  assert.equal(aeugUnit.damage, 1);
});

test('Dominion GD02-121 Deploy adds a Shield to hand and recovers 2 HP on a friendly blue Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'shield' }, 0));

  const blueUnit = deployUnit(state, player, { number: 'B', type: 'unit', ap: 1, hp: 5, color: 'blue' });
  blueUnit.damage = 3;
  deployBase(state, player, lookupCard('GD02-121'));
  assert.equal(player.shields.length, 0, 'added a Shield to hand');
  assert.equal(player.hand.length, 1);
  assert.equal(blueUnit.damage, 1, 'friendly blue Unit recovered 2 HP');
});

test('Alexandria GD02-122 Deploy deals 1 damage to a rested Lv.4-or-lower enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const activeEnemy = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 1, hp: 3, level: 3 });
  const restedHighLv = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 1, hp: 3, level: 5 });
  restedHighLv.rested = true;
  const restedLowLv = deployUnit(state, opponent, { number: 'L', type: 'unit', ap: 1, hp: 3, level: 4 });
  restedLowLv.rested = true;

  deployBase(state, player, lookupCard('GD02-122'));
  assert.equal(activeEnemy.damage, 0, 'not rested -- not a legal target');
  assert.equal(restedHighLv.damage, 0, 'too high a Lv. -- not a legal target');
  assert.equal(restedLowLv.damage, 1, 'rested and Lv.4 -- took 1 damage');
});

test('Sodon GD02-123 Deploy lets a friendly Unit token target an active enemy with 5 or less AP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const token = deployUnit(state, player, { number: 'TK', type: 'unit', ap: 1, hp: 1, isToken: true });
  deployBase(state, player, lookupCard('GD02-123'));
  assert.ok(token.buffs.some((b) => b.activeTargetAPThreshold === 5));
});

test('Diva GD02-124 grants all friendly green (Earth Federation) Units AP+1 during your turn while Lv.7+', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { divaStartOfTurn } = require('../src/effects/registry');

  const efUnit = deployUnit(state, player, { number: 'E', type: 'unit', ap: 2, hp: 2, color: 'green', traits: ['Earth Federation'] });
  const diva = { id: 'diva-test' };
  divaStartOfTurn(state, player, diva);
  assert.equal(getAP(efUnit), 2, 'below Lv.7 -- no buff');

  for (let i = 0; i < 7; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 0));
  divaStartOfTurn(state, player, diva);
  assert.equal(getAP(efUnit), 3, 'Lv.7+ -- AP+1 applied');
});

test('Gwadan GD02-125 Deploy may discard a red card to draw 1, only on your own turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const redCard = createInstance({ number: 'R', type: 'unit', color: 'red', cost: 2 }, 0);
  player.hand.push(redCard);
  player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));

  const { gwadanDeploy } = require('../src/effects/registry');
  state.activePlayerIdx = 1;
  gwadanDeploy(state, player);
  assert.ok(player.hand.includes(redCard), "not your turn -- can't discard/draw");

  state.activePlayerIdx = 0;
  gwadanDeploy(state, player);
  assert.equal(player.hand.includes(redCard), false, 'discarded the red card');
  assert.ok(player.trash.includes(redCard));
});

test('Freeden GD02-127 Destroyed mills the top 2 cards of the deck into trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const top1 = createInstance({ number: 'D1', type: 'unit' }, 0);
  const top2 = createInstance({ number: 'D2', type: 'unit' }, 0);
  player.deck.push(top1, top2);

  const { freedenDestroyed } = require('../src/effects/registry');
  freedenDestroyed(state, player);
  assert.equal(player.deck.length, 0);
  assert.deepEqual(player.trash, [top1, top2]);
});

test('Hammerhead GD02-128 Deploy destroys a 2-AP-or-lower enemy only on your turn with a friendly (Teiwaz) Link Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const weakEnemy = deployUnit(state, opponent, { number: 'W', type: 'unit', ap: 2, hp: 3 });
  const teiwazUnit = deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 1, traits: ['Teiwaz'] });
  teiwazUnit.isLinkUnit = true;

  state.activePlayerIdx = 1;
  deployBase(state, player, lookupCard('GD02-128'));
  assert.ok(opponent.battleArea.includes(weakEnemy), "not your turn -- no effect");

  state.activePlayerIdx = 0;
  const { hammerheadDeploy } = require('../src/effects/registry');
  hammerheadDeploy(state, player);
  assert.equal(opponent.battleArea.includes(weakEnemy), false, 'destroyed the 2-AP enemy Unit');
});

test('Sleipnir GD02-130 Deploy debuffs an enemy AP-2 for the turn, only with a friendly (Gjallarhorn) Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 5 });
  deployBase(state, player, lookupCard('GD02-130'));
  assert.equal(getAP(enemy), 4, 'no friendly (Gjallarhorn) Unit -- no debuff');

  deployUnit(state, player, { number: 'G', type: 'unit', ap: 1, hp: 1, traits: ['Gjallarhorn'] });
  const { sleipnirDeploy } = require('../src/effects/registry');
  sleipnirDeploy(state, player);
  assert.equal(getAP(enemy), 2, 'friendly (Gjallarhorn) Unit in play -- AP-2 applied');
});
