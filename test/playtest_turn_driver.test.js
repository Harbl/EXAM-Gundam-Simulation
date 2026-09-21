const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { drawCard } = require('../src/rules/phases');
const { LIMITS } = require('../src/rules/constants');
const { beginSetup, finishSetup, initializeGame } = require('../src/rules/setup');
const banlist = require('../data/banlist.json');

const { playInteractiveGame, resolveAttackInteractive, runEndPhaseInteractive } = require('../playtest/engine/turnDriver');
const { makeAIController } = require('../playtest/engine/aiController');
const { WEAK_MCTS_CONFIG } = require('../src/ai/mcts');

// Covers Phase 1 of moonlit-hugging-shannon.md: the headless async turn driver that lets a real
// human-shaped controller play an interactive game against the existing AI, rather than the batch-sim
// path's single synchronous hook calls. Pure/headless throughout -- no UI, scripted controllers stand
// in for a human the same way action_step_priority.test.js's fake `respond` callbacks do.

const JAKES_DECKLIST = `
4 GM ST01-005
4 Guntank GD01-008
4 Zaku II ST03-008
4 Char's Zaku II GD01-026
4 Char's Zaku II ST03-006
4 Char Aznable ST03-011
4 Rick Dom GD01-030
4 ReZEL GD01-018
4 Amuro Ray ST01-010
4 Gundam ST01-001
4 A Show of Resolve GD01-100
2 Delta Plus GD01-006
2 Jaburo GD04-122
2 Zeong GD04-017
`;

function buildJakesDeck() {
  const parsed = parseDecklistText(JAKES_DECKLIST);
  const validation = validateDeck(parsed, lookupCard, banlist);
  assert.equal(validation.valid, true, validation.errors.join('; '));
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

test('beginSetup + finishSetup produces the same shape of game as the original single-call initializeGame', () => {
  const deck = buildJakesDeck();
  const rng = () => 0.3; // deterministic: fixed shuffle/coin-flip source, same value fed to both paths
  const direct = initializeGame(deck, deck, { rng, decideMulligan: () => false });

  const setup = beginSetup(deck, deck, { rng: () => 0.3 });
  const split = finishSetup(setup, () => false);

  assert.equal(split.activePlayerIdx, direct.activePlayerIdx);
  assert.equal(split.players[0].hand.length, direct.players[0].hand.length);
  assert.equal(split.players[0].shields.length, direct.players[0].shields.length);
  assert.equal(split.players[1].resourceArea.length, direct.players[1].resourceArea.length);
  assert.ok(split.players[0].base && split.players[1].base, 'both sides get their starting base');
});

test('playInteractiveGame awaits chooseMulligan for the first player, then the second, in that order, before finishing setup', async () => {
  const deck = buildJakesDeck();
  const calls = [];
  const controllers = [
    {
      async chooseMulligan(hand) {
        calls.push({ side: 'A', handSize: hand.length });
        return false;
      },
      async chooseMainAction() {
        return { type: 'pass' };
      },
      async respondToPriority() {
        return { type: 'pass' };
      },
      async chooseDiscards(state, playerIdx, excess) {
        return state.players[playerIdx].hand.slice(0, excess);
      }
    },
    {
      async chooseMulligan(hand) {
        calls.push({ side: 'B', handSize: hand.length });
        return false;
      },
      async chooseMainAction() {
        return { type: 'pass' };
      },
      async respondToPriority() {
        return { type: 'pass' };
      },
      async chooseDiscards(state, playerIdx, excess) {
        return state.players[playerIdx].hand.slice(0, excess);
      }
    }
  ];

  const state = await playInteractiveGame(deck, deck, controllers, { rng: () => 0.9 });

  assert.equal(calls.length, 2, 'chooseMulligan is asked exactly once per side');
  assert.equal(calls[0].handSize, LIMITS.STARTING_HAND);
  assert.equal(state.players[0].hand.length > 0, true, 'setup actually completed (both sides drew a hand)');
});

test('resolveAttackInteractive: a real Action-timed Command played by the defender during the action-step window actually resolves before damage', async () => {
  const attackerPlayer = createPlayer(0);
  const defenderPlayer = createPlayer(1);
  const state = createGame(attackerPlayer, defenderPlayer);

  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 3, hp: 3 }, 0);
  attacker.turnDeployed = 0; // not this turn, so it's eligible to attack
  attackerPlayer.battleArea.push(attacker);

  defenderPlayer.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 1));
  const drawCommand = createInstance(
    { number: 'DC', type: 'command', level: 1, cost: 1, actionTiming: 'action', effects: { command: (s, p) => drawCard(s, p) } },
    1
  );
  defenderPlayer.hand.push(drawCommand);
  for (let i = 0; i < 3; i++) defenderPlayer.deck.push(createInstance({ number: 'F' + i, type: 'unit' }, 1));

  let priorityStep = 0;
  const controllers = [
    { async respondToPriority() { return { type: 'pass' }; } },
    {
      async chooseBlocker() {
        return null;
      },
      async respondToPriority() {
        priorityStep += 1;
        if (priorityStep === 1) return { type: 'command', cardId: drawCommand.id };
        return { type: 'pass' };
      }
    }
  ];

  await resolveAttackInteractive(state, 0, { type: 'attack', attackerId: attacker.id }, controllers);

  assert.equal(defenderPlayer.trash.some((c) => c.def.number === 'DC'), true, 'the reactive Command actually resolved against real state');
  assert.equal(defenderPlayer.hand.length, 1, 'its draw effect actually fired');
  assert.equal(state.winner, 0, 'with no Base/Shields left, the attack still went on to defeat the defender after the action step');
});

test('runEndPhaseInteractive: an over-hand-limit player is asked to discard via the controller, and the chosen cards actually move to trash', async () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  const filler = [];
  for (let i = 0; i < LIMITS.MAX_HAND + 2; i++) {
    const c = createInstance({ number: 'F' + i, type: 'unit', cost: 1 }, 0);
    filler.push(c);
    player.hand.push(c);
  }

  const controllers = [
    {
      async respondToPriority() {
        return { type: 'pass' };
      },
      async chooseDiscards(s, playerIdx, excess) {
        assert.equal(excess, 2);
        return filler.slice(0, excess);
      }
    },
    { async respondToPriority() { return { type: 'pass' }; } }
  ];

  await runEndPhaseInteractive(state, controllers);

  assert.equal(player.hand.length, LIMITS.MAX_HAND);
  assert.equal(filler.slice(0, 2).every((c) => player.trash.includes(c)), true);
});

test("Jake's deck mirrored against itself, via the interactive driver + two AI controllers, plays out sane, crash-free games", async () => {
  const deck = buildJakesDeck();
  const games = 8; // WEAK_MCTS_CONFIG keeps this fast enough for a regular test run, same reasoning as sim.test.js's 20-game mirror match
  const controllers = [makeAIController(WEAK_MCTS_CONFIG), makeAIController(WEAK_MCTS_CONFIG)];
  let winsA = 0;
  let winsB = 0;

  try {
    for (let i = 0; i < games; i++) {
      const state = await playInteractiveGame(deck, deck, controllers);
      assert.ok(state.turnNumber > 0 && state.turnNumber <= 61, `implausible game length: ${state.turnNumber}`);
      if (state.winner === 0) winsA++;
      else if (state.winner === 1) winsB++;
    }
  } finally {
    // Each AI controller now owns a persistent search worker thread (see aiController.js) -- undisposed,
    // it keeps node --test from exiting.
    controllers[0].dispose();
    controllers[1].dispose();
  }

  assert.ok(winsA + winsB > 0, 'at least some games should resolve with a winner rather than timing out');
});
