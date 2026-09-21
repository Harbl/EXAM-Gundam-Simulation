const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, becomeBase } = require('../src/rules/actions');
const { drawCard } = require('../src/rules/phases');
const { runActionStepPriority } = require('../src/ai/actionStepPriority');

// Covers the real Action Step rule (RULES_NOTES.md section 9): standby player chooses first each
// round, then active player, alternating until both consecutively pass. This is the one genuinely new
// rules primitive behind the playtest app's interactive combat/end-phase reaction windows -- see
// moonlit-hugging-shannon.md's Phase 0. Pure/headless: no UI, just fake respond() callbacks plus a few
// real cards to prove real application, same style as the rest of this suite.

test('asks the standby player first, then the active player, and stops once both pass consecutively', async () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  const calls = [];
  const respond = async (s, playerIdx) => {
    calls.push(playerIdx);
    return { type: 'pass' };
  };

  await runActionStepPriority(state, 0, 1, {}, respond);

  assert.deepEqual(calls, [0, 1], 'exactly one pass each, standby (0) asked before active (1), no reopening');
});

test('null is treated the same as an explicit pass', async () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  const calls = [];
  const respond = async (s, playerIdx) => {
    calls.push(playerIdx);
    return null;
  };

  await runActionStepPriority(state, 0, 1, {}, respond);

  assert.deepEqual(calls, [0, 1]);
});

test('a real Action-timed Command played by the standby player actually resolves on the real state, and reopens the window for one more round each side', async () => {
  const player = createPlayer(0); // standby
  const opponent = createPlayer(1); // active
  const state = createGame(player, opponent);
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 0));
  const drawCommand = createInstance(
    { number: 'DC', type: 'command', level: 1, cost: 1, actionTiming: 'action', effects: { command: (s, p) => drawCard(s, p) } },
    0
  );
  player.hand.push(drawCommand);
  for (let i = 0; i < 3; i++) player.deck.push(createInstance({ number: 'F' + i, type: 'unit' }, 0));

  const calls = [];
  let step = 0;
  const respond = async (s, playerIdx) => {
    calls.push(playerIdx);
    step += 1;
    if (step === 1) return { type: 'command', cardId: drawCommand.id };
    return { type: 'pass' };
  };

  await runActionStepPriority(state, 0, 1, {}, respond);

  // standby's real action (call 1) resets the pass streak to 0 -- it then takes exactly one pass from
  // each side in a row (active, then standby again) to reach "both consecutively pass" and stop.
  assert.deepEqual(calls, [0, 1, 0], "standby's real action reopened the window for one more round each side");
  assert.equal(player.trash.some((c) => c.def.number === 'DC'), true, 'the Command actually resolved against the real state, not a clone');
  assert.equal(player.hand.length, 1, "its draw effect actually fired (drew a real card off the real deck)");
});

test('a Command response referencing a card no longer in hand is a harmless no-op, not a crash', async () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  let step = 0;
  const respond = async () => {
    step += 1;
    if (step === 1) return { type: 'command', cardId: -1 };
    return { type: 'pass' };
  };

  await assert.doesNotReject(runActionStepPriority(state, 0, 1, {}, respond));
});

test('an [Activate·Action] response actually resolves via the real handler, keyed by sourceId', async () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'green' }, 0));

  const taurus = createInstance(lookupCard('EB01-033'), 0);
  const defender = createInstance({ number: 'D', type: 'unit', level: 1, ap: 4, hp: 5 }, 0);
  player.battleArea.push(taurus, defender);
  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(attacker);

  const battleTarget = { type: 'unit', instance: defender };
  const battleCtx = { attacker, target: battleTarget, battleTarget };

  let step = 0;
  const respond = async (s, playerIdx) => {
    step += 1;
    if (step === 1 && playerIdx === 0) return { type: 'activate', sourceId: taurus.id };
    return { type: 'pass' };
  };

  await runActionStepPriority(state, 0, 1, battleCtx, respond);

  assert.equal(defender.buffs.some((b) => b.ap === 1), true, "Taurus's real handler actually ran and buffed the real target");
  assert.equal(player.resourceArea[0].rested, true, "Taurus's (1) cost was actually paid");
});

test('resolverTableFor dispatches by relationship to battleCtx.attacker, not a fixed defender-only role: the defending side gets defender-shaped abilities (Taurus/ACTION_RESOLVERS), the attacking side gets attacker-shaped ones (Gamow/ATTACKER_ACTION_RESOLVERS)', async () => {
  const player = createPlayer(0); // defender in this battleCtx
  const opponent = createPlayer(1); // attacker in this battleCtx
  const state = createGame(player, opponent);
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'green' }, 0));

  const taurus = createInstance(lookupCard('EB01-033'), 0);
  const defender = createInstance({ number: 'D', type: 'unit', level: 1, ap: 4, hp: 5 }, 0);
  player.battleArea.push(taurus, defender);

  becomeBase(state, opponent, createInstance(lookupCard('GD01-127'), 1)); // Gamow
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', traits: ['ZAFT'], level: 1, ap: 5, hp: 5 });

  const battleTarget = { type: 'unit', instance: defender };
  const battleCtx = { attacker, target: battleTarget, battleTarget };

  let step = 0;
  const respond = async (s, playerIdx) => {
    step += 1;
    if (step === 1) return { type: 'activate', sourceId: taurus.id }; // standby (defender, playerIdx 0)
    if (step === 2) return { type: 'activate', sourceId: opponent.base.id }; // active (attacker, playerIdx 1)
    return { type: 'pass' };
  };

  await runActionStepPriority(state, 0, 1, battleCtx, respond);

  assert.equal(defender.buffs.some((b) => b.ap === 1), true, "the defender's own reactive ability (Taurus, ACTION_RESOLVERS) resolved for the defending side");
  assert.equal(attacker.buffs.some((b) => b.breach === 3), true, "the attacker's own ability (Gamow, ATTACKER_ACTION_RESOLVERS) resolved for the attacking side -- proves the table choice follows who's acting, not a hardcoded 'defender only' assumption");
});

test('the end-phase window (battleCtx has no attacker) still resolves ACTION_RESOLVERS activations without crashing', async () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const battleCtx = { step: 'end-phase-action' };

  await assert.doesNotReject(runActionStepPriority(state, 0, 1, battleCtx, async () => ({ type: 'pass' })));
});
