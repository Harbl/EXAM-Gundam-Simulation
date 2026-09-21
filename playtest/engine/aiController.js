const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { canAfford } = require('../../src/rules/cost');
const { decideMulligan, chooseAttackTarget, chooseBlockerLookahead, chooseDiscards, chooseBurst } = require('../../src/ai/heuristic');
const { collectActivateActionCandidates } = require('../../src/ai/activations');
const { resolverTableFor } = require('../../src/ai/actionStepPriority');
const { stripDefs } = require('./stateTransfer');

/**
 * PlayerController backed by the existing, already-tested synchronous AI decision code -- every method
 * just calls into it and wraps the result in a resolved Promise, satisfying the same async interface a
 * real human/UI controller will (see turnDriver.js). Only the MCTS engine is supported for
 * chooseMainAction ('novice' through 'expert' in skillPresets.js); the older fixed-pipeline lookahead
 * engine ('beginner') has no single-atomic-action entry point to drive one decision at a time the way
 * MCTS's runSearch/bestAction does, so it isn't wired up here yet -- a follow-up if a beginner-strength
 * interactive opponent turns out to matter, not a blocker for the core playtest loop.
 *
 * chooseMainAction runs on its own persistent worker thread (searchWorker.js), not the Electron main
 * process -- MCTS search is the one genuinely CPU-heavy decision here, and running it inline would
 * visibly freeze IPC/rendering for the whole window during the AI's turn, worse the stronger the skill
 * tier (same reasoning as electron/worker/batchWorker.js's batch runs, just one atomic decision per
 * round-trip instead of a whole game). One worker per game, reused across every chooseMainAction call
 * for that game rather than spawned fresh each time -- call dispose() when the game ends (see main.js)
 * or the worker thread keeps the process alive.
 */
function makeAIController(mctsConfig) {
  const worker = new Worker(path.join(__dirname, 'searchWorker.js'));
  let pendingResolve = null;
  worker.on('message', (action) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(action);
    }
  });
  worker.on('error', (err) => {
    console.error('[searchWorker]', err);
    // A crashed search shouldn't hang the whole game -- pass and let play continue.
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ type: 'pass' });
    }
  });

  return {
    async chooseMulligan(hand) {
      return decideMulligan(hand);
    },

    async chooseMainAction(state, playerIdx) {
      return new Promise((resolve) => {
        pendingResolve = resolve;
        worker.postMessage({ stateData: stripDefs(state), playerIdx, mctsConfig });
      });
    },

    // turnDriver only asks this when there's a genuine choice among 2+ legal targets; picks exactly
    // what the batch-sim AI would've picked (same heuristic, same args) so AI-vs-AI behavior here is
    // byte-identical to before this method existed.
    async chooseAttackTarget(state, playerIdx, attacker, options) {
      const opponent = state.players[1 - playerIdx];
      const player = state.players[playerIdx];
      // unitOnly only ever gates whether {type:'player'} gets appended to the eligible list (the unit
      // set itself is unaffected) -- inferring it back from `options` keeps this pick guaranteed inside
      // the same legal set turnDriver already computed, instead of re-deriving onDeployTurn here too.
      const unitOnly = !options.some((o) => o.type === 'player');
      return chooseAttackTarget(opponent, attacker, unitOnly, player) || options[0];
    },

    async chooseBlocker(state, defendingPlayer, attacker, target, attackingPlayer) {
      return chooseBlockerLookahead(state, defendingPlayer, attacker, target, attackingPlayer);
    },

    /** Offers the first affordable Action-timed Command, else the first legal Activate-Action ability, else passes -- no lethal/trade gating (that's chooseBlocker's job); this just needs to be a plausible, non-crashing opponent for interactive play and the headless smoke test, not a precision benchmark. */
    async respondToPriority(state, playerIdx, battleCtx) {
      const player = state.players[playerIdx];
      const command = player.hand.find(
        (c) => c.def.type === 'command' && (c.def.actionTiming === 'action' || c.def.actionTiming === 'both') && canAfford(player, c.def, { state })
      );
      if (command) return { type: 'command', cardId: command.id };

      const resolverTable = resolverTableFor(state, playerIdx, battleCtx);
      const activateCandidate = collectActivateActionCandidates(state, playerIdx, battleCtx, resolverTable)[0];
      if (activateCandidate) return { type: 'activate', sourceId: activateCandidate.source.id };

      return { type: 'pass' };
    },

    async chooseDiscards(state, playerIdx, excess) {
      return chooseDiscards(state.players[playerIdx], excess);
    },

    // Same "always activate if available" default the batch-sim AI has always used (heuristic.js's own
    // chooseBurst) -- picks a real strategic answer once someone wants a genuinely tuned AI Burst
    // decision, not a blocker for the interactive loop.
    async chooseBurst(state, playerIdx, shieldInstance) {
      return chooseBurst(shieldInstance);
    },

    // No opinion on resolution order (13-1-7-4's simultaneous double-Burst) -- keeps the natural
    // top-then-next order, same as today's implicit default when no hook is given at all.
    async chooseBurstOrder(state, playerIdx, shields) {
      return shields;
    },

    dispose() {
      worker.terminate();
    }
  };
}

module.exports = { makeAIController };
