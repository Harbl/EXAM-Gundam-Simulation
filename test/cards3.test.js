const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { resolveAttack } = require('../src/rules/combat');
const { getAP, getRemainingHP } = require('../src/rules/management');
const { runAttacks, runActivations } = require('../src/ai/heuristic');

test('Zoloat (cannotAttackPlayer) never swings at the player, even with no favorable trade available', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  const zoloat = deployUnit(state, player, lookupCard('GD04-016'));
  zoloat.turnDeployed = 0; // pretend it's been out since last turn, so it's not summoning-sick
  const toughEnemy = createInstance({ number: 'E', type: 'unit', ap: 10, hp: 10, rested: true }, 1);
  toughEnemy.rested = true;
  opponent.battleArea.push(toughEnemy);

  runAttacks(state, 0, {});

  assert.equal(zoloat.rested, false, "never attacked -- it can't hit face and the only trade is bad");
  assert.equal(toughEnemy.damage, 0);
});

test('Strike Freedom GD05-002 grants onKillDraw to its top-2-AP Units on Deploy, and its attack can return the lowest-Lv enemy to deck bottom', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  const midAp = createInstance({ number: 'M', type: 'unit', ap: 3, hp: 10 }, 0);
  const weakest = createInstance({ number: 'K', type: 'unit', ap: 1, hp: 10 }, 0);
  player.battleArea.push(midAp, weakest);
  const strikeFreedom = deployUnit(state, player, lookupCard('GD05-002'));

  assert.ok(strikeFreedom.buffs.some((b) => b.onKillDraw === 1), 'Strike Freedom itself (AP5) is a top-2-AP pick');
  assert.ok(midAp.buffs.some((b) => b.onKillDraw === 1), 'the AP3 unit is the other top-2 pick');
  assert.equal(weakest.buffs.length, 0, 'only the top 2 by AP get it -- the AP1 unit misses out');

  player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));
  const victim = createInstance({ number: 'V', type: 'unit', ap: 0, hp: 1, rested: true }, 1);
  victim.rested = true;
  opponent.battleArea.push(victim);
  const deckSizeBefore = player.deck.length;
  resolveAttack(state, 0, midAp, { type: 'unit', instance: victim }, {});
  assert.equal(player.deck.length, deckSizeBefore - 1, 'onKillDraw pulled a card from the deck into hand');
  assert.equal(player.hand.some((c) => c.def.number === 'D'), true);

  // Now test the "During Pair Attack" bounce-to-deck-bottom effect in isolation (clear the
  // earlier onKillDraw grant and drawn card so they don't interfere with this scenario).
  strikeFreedom.buffs = [];
  player.hand = [];
  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  pairPilot(state, player, strikeFreedom, pilot);
  player.hand.push(
    createInstance({ number: 'H1', type: 'unit', cost: 1 }, 0),
    createInstance({ number: 'H2', type: 'unit', cost: 2 }, 0)
  );
  const lowLvEnemy = createInstance({ number: 'LOW', type: 'unit', level: 1, ap: 1, hp: 1 }, 1);
  const highLvEnemy = createInstance({ number: 'HIGH', type: 'unit', level: 5, ap: 1, hp: 1, rested: true }, 1);
  highLvEnemy.rested = true;
  opponent.battleArea.push(lowLvEnemy, highLvEnemy);
  const enemyDeckSizeBefore = opponent.deck.length;

  resolveAttack(state, 0, strikeFreedom, { type: 'unit', instance: highLvEnemy }, {});

  assert.equal(player.hand.length, 0, 'discarded 2 cards to pay for the bounce');
  assert.equal(opponent.battleArea.includes(lowLvEnemy), false, 'the LOWEST-level enemy got returned, not the declared target');
  assert.equal(opponent.deck[opponent.deck.length - 1], lowLvEnemy, 'returned to the bottom of the deck');
  assert.equal(opponent.deck.length, enemyDeckSizeBefore + 1);
});

test('Aile Strike Gundam ST04-001 only bounces on pairing with a Lv.4+ Pilot, targeting the highest-AP eligible enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, lookupCard('ST04-001'));
  const lowLvPilot = createInstance({ number: 'LP', type: 'pilot', level: 2 }, 0);
  const weakEnemy = createInstance({ number: 'W', type: 'unit', ap: 1, hp: 3 }, 1);
  const scaryEnemy = createInstance({ number: 'S', type: 'unit', ap: 5, hp: 3 }, 1);
  opponent.battleArea.push(weakEnemy, scaryEnemy);

  pairPilot(state, player, unit, lowLvPilot);
  assert.equal(opponent.battleArea.length, 2, 'no bounce -- the paired Pilot is below Lv.4');

  unit.pilot = null;
  const highLvPilot = createInstance({ number: 'HP', type: 'pilot', level: 4 }, 0);
  pairPilot(state, player, unit, highLvPilot);

  assert.equal(opponent.battleArea.includes(scaryEnemy), false, 'the higher-AP eligible enemy got bounced');
  assert.equal(opponent.hand.includes(scaryEnemy), true);
  assert.equal(opponent.battleArea.includes(weakEnemy), true);
});

test('runActivations dispatches V-Dash Gundam (a Unit, not a Base) the same way as a Base Activate-Main source', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const vDash = deployUnit(state, player, lookupCard('GD04-006'));
  const spareFed = createInstance({ number: 'F', type: 'unit', ap: 1, traits: ['League Militaire'] }, 0);
  player.battleArea.push(spareFed);
  const lowHpEnemy = createInstance({ number: 'E', type: 'unit', ap: 3, hp: 4 }, 1);
  opponent.battleArea.push(lowHpEnemy);

  runActivations(state, 0);

  assert.equal(spareFed.rested, true, 'spent the spare League Militaire Unit as the cost');
  assert.equal(lowHpEnemy.rested, true, 'rested the low-HP enemy via the Unit-based Activate-Main');
  assert.equal(vDash.activationsUsed.restEnemy, true);
});
