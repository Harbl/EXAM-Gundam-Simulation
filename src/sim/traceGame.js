// Re-simulates one seeded game (see src/rules/rng.js) and returns a structured turn-by-turn event
// log, for the replay viewer feature. Adapts the exact instrumentation scratchpad/trace_game_mcts.js
// used for manual debugging -- patches rules/actions.js + rules/combat.js's exported functions to
// push an event whenever they run against the *real* game state, so the AI's own internal
// lookahead/MCTS search (which calls these same functions against cloned scratch states while
// evaluating candidate moves) doesn't pollute the trace -- only the decisions that actually happened
// show up.
//
// IMPORTANT: this file must be the first thing required in its process/worker, before anything else
// (heuristic.js, mcts.js, phases.js, ...) touches rules/actions.js or rules/combat.js. Those modules
// destructure their functions off actions/combat at their own top level the first time they're
// required, which caches the *unpatched* function references in a local const -- patching afterward
// wouldn't reach them (Node's module cache means the actions/combat exports objects are shared, but
// reassigning a property on that object doesn't rewrite an already-captured destructured binding
// elsewhere). electron/worker/replayWorker.js is the real entry point that guarantees this by being a
// fresh worker_thread (its own isolated module registry) spun up fresh per replay request.
// phases.js must be required (and its drawCard patched) BEFORE combat.js -- combat.js destructures
// `const { drawCard } = require('./phases')` at its own top-level require time, which captures
// whatever phases.exports.drawCard currently points to. If combat.js were required first (like every
// other patched module here), its already-bound `drawCard` reference would be the original,
// unpatched function forever, and reassigning phases.exports.drawCard afterward would never reach it
// (same hazard this file's header comment already describes for actions.js/combat.js's own
// consumers). registry.js does the exact same destructuring, but it's only ever reached transitively,
// well after this ordering is already locked in, so it automatically picks up the patched version.
//
// This patch only ever catches *effect*-triggered draws reached via registry.js's destructured
// reference (e.g. a Command's "draw 1, discard 1") -- it can NEVER catch the once-per-turn phase
// draw, because runDrawPhase (defined in this same phases.js file) calls `drawCard(...)` as a bare
// same-module reference, not through module.exports, so reassigning the exported property never
// reaches it (same "bare intra-module call" hazard as mulligan()/resolveBurst() elsewhere in this
// codebase). The phase draw is instead captured directly in traceGame()'s own loop below, via a
// before/after hand-size diff around its own `runDrawPhase(state)` call -- the same trick already
// used there for resource placement. Because these two mechanisms observe genuinely disjoint call
// sites, there's no risk of the same draw ever being logged twice.
const phases = require('../rules/phases');

let realState = null;
let events = null;

function cardRef(def) {
  return def ? { name: def.name, number: def.number } : null;
}
function instanceRef(instance) {
  return instance ? { name: instance.def.name, number: instance.def.number, id: instance.id } : null;
}

const origDrawCard = phases.drawCard;
phases.drawCard = function (state, player, opts = {}) {
  const before = player.deck.length;
  const result = origDrawCard.call(this, state, player, opts);
  if (state === realState && player.deck.length < before) {
    events.push({ type: 'draw', turn: state.turnNumber, player: state.players.indexOf(player), isPhaseDraw: false });
  }
  return result;
};

const actions = require('../rules/actions');
const combat = require('../rules/combat');

const origDeployUnit = actions.deployUnit;
actions.deployUnit = function (state, player, def, chooseToTrash, context) {
  const result = origDeployUnit.call(this, state, player, def, chooseToTrash, context);
  if (state === realState) {
    events.push({ type: 'deploy', turn: state.turnNumber, player: state.players.indexOf(player), card: cardRef(def) });
  }
  return result;
};

const origDeployBase = actions.deployBase;
actions.deployBase = function (state, player, def) {
  const result = origDeployBase.call(this, state, player, def);
  if (state === realState) {
    events.push({ type: 'deployBase', turn: state.turnNumber, player: state.players.indexOf(player), card: cardRef(def) });
  }
  return result;
};

const origPlayCommand = actions.playCommand;
actions.playCommand = function (state, player, def, opts) {
  const result = origPlayCommand.call(this, state, player, def, opts);
  if (state === realState) {
    events.push({ type: 'command', turn: state.turnNumber, player: state.players.indexOf(player), card: cardRef(def) });
  }
  return result;
};

const origPairPilot = actions.pairPilot;
actions.pairPilot = function (state, player, unit, pilotInstance) {
  const result = origPairPilot.call(this, state, player, unit, pilotInstance);
  if (state === realState) {
    events.push({
      type: 'pair',
      turn: state.turnNumber,
      player: state.players.indexOf(player),
      pilot: instanceRef(pilotInstance),
      unit: instanceRef(unit)
    });
  }
  return result;
};

const origPairPilotFromTrash = actions.pairPilotFromTrash;
actions.pairPilotFromTrash = function (state, player, unit, trashInstance) {
  const result = origPairPilotFromTrash.call(this, state, player, unit, trashInstance);
  if (state === realState) {
    events.push({
      type: 'pairFromTrash',
      turn: state.turnNumber,
      player: state.players.indexOf(player),
      pilot: instanceRef(trashInstance),
      unit: instanceRef(unit)
    });
  }
  return result;
};

const origResolveAttack = combat.resolveAttack;
combat.resolveAttack = function (state, attackerPlayerIdx, attacker, declaredTarget, hooks) {
  const isReal = state === realState;
  const shieldsBefore = isReal && state.players.map((p) => p.shields.length);
  const result = origResolveAttack.call(this, state, attackerPlayerIdx, attacker, declaredTarget, hooks);
  if (isReal) {
    const shieldsAfter = state.players.map((p) => p.shields.length);
    events.push({
      type: 'attack',
      turn: state.turnNumber,
      player: attackerPlayerIdx,
      attacker: instanceRef(attacker),
      target:
        declaredTarget.type === 'player'
          ? { type: 'player', player: 1 - attackerPlayerIdx }
          : { type: 'unit', unit: instanceRef(declaredTarget.instance) },
      shieldsBefore,
      shieldsAfter
    });
  }
  return result;
};

// require AFTER patching, per the module-level comment above.
const { initializeGame } = require('../rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../rules/phases');
const { checkDefeat } = require('../rules/management');
const { decideMulligan, lookaheadHooks, runMainPhase } = require('../ai/heuristic');
const { runMainPhaseMCTS } = require('../ai/mcts');
const { mulberry32 } = require('../rules/rng');

const MAX_TURNS = 60;

/**
 * `deckA`/`deckB` are {main, resource} CardDef arrays (same shape src/sim/singleGame.js takes).
 * `options` mirrors playGame's: engineA/engineB, mctsConfigA/mctsConfigB.
 */
function traceGame(deckA, deckB, seed, options = {}) {
  events = [];
  const rng = mulberry32(seed);
  // mulligan() (src/rules/setup.js) is only ever called from initializeGame's own local scope, as a
  // bare same-module function call, not through module.exports -- so it can't be monkeypatched the
  // way every other event here is. Wrapping the decideMulligan hook itself, which initializeGame
  // does invoke through the options object we control, gets the same information for free: the hand
  // it's asked to judge always belongs to the player currently on the setup path, identifiable via
  // any card instance's own .owner field (src/rules/state.js's createInstance).
  const tracedDecideMulligan = (hand) => {
    const shouldMulligan = decideMulligan(hand);
    events.push({ type: 'mulligan', player: hand[0] ? hand[0].owner : null, mulliganed: shouldMulligan });
    return shouldMulligan;
  };
  const state = initializeGame(deckA, deckB, { decideMulligan: tracedDecideMulligan, rng });
  realState = state;

  if (options.mctsConfigA) state.players[0].mctsConfig = options.mctsConfigA;
  if (options.mctsConfigB) state.players[1].mctsConfig = options.mctsConfigB;
  const engines = [options.engineA || 'mcts', options.engineB || 'mcts'];

  events.push({ type: 'gameStart', firstPlayer: state.activePlayerIdx });

  // Wrapping chooseBurst on this one hooks object (rather than patching combat.js's resolveBurst,
  // which -- like mulligan() above -- is only ever called as a bare same-module reference and can't
  // be monkeypatched) works cleanly for a structural reason, not just a state === realState check:
  // every simulated AI trial (heuristic.js's cloned-state attack subsets, mcts.js's rollouts) always
  // builds its OWN fresh defaultHooks()/lookaheadHooks() internally rather than reusing whatever
  // hooks object was passed in from outside -- only the real, finally-applied attack ever threads
  // *this* object through (see runAttacksLookahead's last line and runMainPhaseMCTS's applyAction
  // call). The state-identity check is still here as cheap, explicit insurance matching this file's
  // existing style everywhere else, not because it's structurally required.
  const baseHooks = lookaheadHooks(state);
  const hooks = {
    ...baseHooks,
    chooseBurst(shieldInstance, hookState) {
      const activate = baseHooks.chooseBurst(shieldInstance, hookState);
      if (hookState === realState) {
        events.push({
          type: 'burst',
          turn: state.turnNumber,
          player: shieldInstance.owner,
          card: cardRef(shieldInstance.def),
          activated: activate
        });
      }
      return activate;
    }
  };
  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    events.push({ type: 'turnStart', turn: state.turnNumber, player: state.activePlayerIdx });
    runStartPhase(state);
    const handBeforeDraw = state.players[state.activePlayerIdx].hand.length;
    runDrawPhase(state);
    if (state.players[state.activePlayerIdx].hand.length > handBeforeDraw) {
      events.push({ type: 'draw', turn: state.turnNumber, player: state.activePlayerIdx, isPhaseDraw: true });
    }
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;

    const resourcesBefore = state.players.map((p) => p.resourceArea.length);
    runResourcePhase(state);
    if (state.players[state.activePlayerIdx].resourceArea.length > resourcesBefore[state.activePlayerIdx]) {
      events.push({ type: 'resource', turn: state.turnNumber, player: state.activePlayerIdx });
    }
    if (engines[state.activePlayerIdx] === 'lookahead') runMainPhase(state, state.activePlayerIdx, hooks);
    else runMainPhaseMCTS(state, state.activePlayerIdx, hooks);
    if (state.winner !== null || state.draw) break;

    runEndPhase(state);
    passTurn(state);
  }

  events.push({
    type: 'gameEnd',
    winner: state.winner,
    draw: state.draw,
    timedOut: state.winner === null && !state.draw,
    turns: state.turnNumber,
    shields: state.players.map((p) => p.shields.length)
  });

  return events;
}

module.exports = { traceGame };
