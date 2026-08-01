const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, becomeBase, pairPilot } = require('../src/rules/actions');
const { runActivations, runCommands, runDeploys, chooseBlocker } = require('../src/ai/heuristic');

test('runActivations uses Jaburo to rest a scarier enemy Unit, spending its weakest Federation Unit as cost', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  becomeBase(state, player, createInstance(lookupCard('GD04-122'), 0));
  const weakFed = createInstance({ number: 'W', type: 'unit', ap: 1, traits: ['Earth Federation'] }, 0);
  const strongFed = createInstance({ number: 'S', type: 'unit', ap: 5, traits: ['Earth Federation'] }, 0);
  player.battleArea.push(weakFed, strongFed);
  const scaryEnemy = createInstance({ number: 'E', type: 'unit', ap: 4, level: 2 }, 1);
  const weakEnemy = createInstance({ number: 'E2', type: 'unit', ap: 0, level: 2 }, 1);
  opponent.battleArea.push(scaryEnemy, weakEnemy);

  runActivations(state, 0);

  assert.equal(weakFed.rested, true, 'sacrificed the weakest Federation Unit as the cost, not the strong one');
  assert.equal(strongFed.rested, false, 'kept the strong attacker free rather than spending it as the cost');
  assert.equal(scaryEnemy.rested, true, 'rested the higher-AP enemy, not the harmless one');
  assert.equal(weakEnemy.rested, false);
});

test("runActivations uses Ra Cailum's Reduce 1 on its biggest friendly (Londo Bell) threat", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.activePlayerIdx = 0;

  becomeBase(state, player, createInstance(lookupCard('GD05-125'), 0));
  const smallLondoBell = createInstance({ number: 'A', type: 'unit', ap: 1, traits: ['Londo Bell'] }, 0);
  const bigLondoBell = createInstance({ number: 'B', type: 'unit', ap: 5, traits: ['Londo Bell'] }, 0);
  player.battleArea.push(smallLondoBell, bigLondoBell);

  runActivations(state, 0);

  assert.equal(player.base.rested, true);
  assert.ok(bigLondoBell.buffs.some((b) => b.damageReduction === 1), 'protects the highest-AP Londo Bell Unit');
  assert.equal(smallLondoBell.buffs.length, 0);
});

test('runCommands plays an affordable Command from hand (e.g. A Show of Resolve draws 2), not just Units/Bases', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  for (let i = 0; i < 4; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'blue' }, 0));
  for (let i = 0; i < 2; i++) player.deck.push(createInstance({ number: `D${i}`, type: 'unit' }, 0));
  player.hand.push(createInstance(lookupCard('GD01-100'), 0));

  runCommands(state, player);

  assert.equal(player.hand.length, 2, 'the Command got played (trashed) and its 2 draws are now in hand');
  assert.equal(player.trash.some((c) => c.def.number === 'GD01-100'), true);
});

test('Nu Gundam GD05-017 (When Paired) only burns its 3 trashed Londo Bell cards for a favorable/safe kill', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 3; i++) {
    player.trash.push(createInstance({ number: `LB${i}`, type: 'unit', traits: ['Londo Bell'] }, 0));
  }
  const toughEnemy = createInstance({ number: 'E', type: 'unit', ap: 10, hp: 10 }, 1); // would trade badly
  opponent.battleArea.push(toughEnemy);

  const nuGundam = deployUnit(state, player, lookupCard('GD05-017'));
  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  pairPilot(state, player, nuGundam, pilot);

  assert.equal(player.trash.length, 3, 'declines the trade -- nothing gets exiled without a favorable kill');
  assert.equal(player.removal.length, 0);
  assert.equal(toughEnemy.damage, 0);
});

test("runDeploys won't redeploy a second Base while one is already in play (11-5 would just trash the first for nothing)", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.hand.push(
    createInstance({ number: 'B1', type: 'base', hp: 5 }, 0),
    createInstance({ number: 'B2', type: 'base', hp: 5 }, 0)
  );

  runDeploys(state, player);

  assert.equal(player.base.def.number, 'B1');
  assert.equal(player.hand.length, 1, 'B2 stays in hand instead of being wasted replacing B1');
  assert.equal(player.trash.length, 0);
});

test('chooseBlocker prefers a Unit that survives and kills the attacker over a cheaper chump', () => {
  const defendingPlayer = createPlayer(0);
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 4, hp: 4 }, 1);
  const chump = createInstance({ number: 'C', type: 'unit', ap: 1, hp: 1, keywords: { blocker: true } }, 0);
  const strongBlocker = createInstance({ number: 'S', type: 'unit', ap: 5, hp: 5, keywords: { blocker: true } }, 0);
  defendingPlayer.battleArea.push(chump, strongBlocker);
  // No Base/Shields left -- facing lethal, so a block is warranted at all.

  const chosen = chooseBlocker(defendingPlayer, attacker, { type: 'player' });

  assert.equal(chosen, strongBlocker, 'kills the attacker and survives, instead of just chumping with the weakest body');
});

test("chooseBlocker doesn't block at all outside facing-lethal/bad-trade, even with a Unit that would win the fight", () => {
  const defendingPlayer = createPlayer(0);
  defendingPlayer.shields.push(createInstance({ number: 'SH', type: 'unit' }, 0)); // not yet literally lethal
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 1, hp: 1 }, 1);
  const strongBlocker = createInstance({ number: 'S', type: 'unit', ap: 5, hp: 5, keywords: { blocker: true } }, 0);
  defendingPlayer.battleArea.push(strongBlocker);

  const chosen = chooseBlocker(defendingPlayer, attacker, { type: 'player' });

  assert.equal(chosen, null, 'proactive blocking tested worse in practice for a racing deck -- only blocks at literal lethal/bad-trade');
});
