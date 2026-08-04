const { initializeGame } = require('../rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../rules/phases');
const { checkDefeat } = require('../rules/management');
const { decideMulligan, lookaheadHooks, runMainPhase } = require('../ai/heuristic');
const { runMainPhaseMCTS } = require('../ai/mcts');
const { mulberry32 } = require('../rules/rng');

const MAX_TURNS = 60; // safety cap against a stalemate/decking-out loop that never naturally ends

/**
 * Plays one full game between two {main, resource} CardDef decks using the MCTS bot on both sides
 * (7-1-1: start/draw/resource/main/end phases, repeated until someone wins or MAX_TURNS). MCTS beat
 * the previous default (the fixed-pipeline lookahead, still available as runMainPhase in ai/heuristic.js)
 * 68.9%/31.1% in self-play (z=7.17, see project memory) before being adopted as the default here.
 */
function playGame(deckA, deckB, options = {}) {
  const mulliganLog = [];
  const trackedDecideMulligan = (hand) => {
    const shouldMulligan = decideMulligan(hand);
    mulliganLog.push(shouldMulligan);
    return shouldMulligan;
  };

  // Seeded replay support: if options.seed is given, the whole game (shuffles + coin flip) becomes
  // deterministic, so the replay viewer can re-run this exact game later from the seed alone.
  const rng = options.seed !== undefined ? mulberry32(options.seed) : undefined;
  const state = initializeGame(deckA, deckB, { decideMulligan: trackedDecideMulligan, rng });
  // Optional per-side scoreState weight override (deck A/B's identity, not turn-order first/second),
  // for A/B-testing alternative weight configs in self-play without threading a weights param through
  // every lookahead function -- see src/ai/score.js.
  if (options.weightsA) state.players[0].aiWeights = options.weightsA;
  if (options.weightsB) state.players[1].aiWeights = options.weightsB;
  // Same pattern, for a trained valueNet.js model (Phase 7) -- see scoreState's valueModel dispatch
  // in src/ai/score.js. Mutually exclusive with weightsA/weightsB in practice (a valueModel bypasses
  // aiWeights entirely once set), but nothing stops both being passed; scoreState's own check just
  // means valueModel silently wins for that side, same as it would for any other override shape here.
  if (options.valueModelA) state.players[0].valueModel = options.valueModelA;
  if (options.valueModelB) state.players[1].valueModel = options.valueModelB;
  // Same pattern, for MCTS's own tunable knob (playoutBudget/rolloutTurns/rolloutPolicy) -- see
  // DEFAULT_MCTS_CONFIG/STRONG_MCTS_CONFIG in ai/mcts.js. Falls back to DEFAULT_MCTS_CONFIG per side
  // when not set, same as aiWeights falls back to score.js's DEFAULT_WEIGHTS.
  if (options.mctsConfigA) state.players[0].mctsConfig = options.mctsConfigA;
  if (options.mctsConfigB) state.players[1].mctsConfig = options.mctsConfigB;
  // Per-side AI engine override -- 'mcts' (default) or 'lookahead' (the older, simpler fixed-pipeline
  // AI, ai/heuristic.js's runMainPhase). Powers the skill-slider feature (src/ai/skillPresets.js):
  // its 'beginner' tier swaps a side to 'lookahead' entirely rather than just a smaller MCTS budget,
  // since that's a much bigger, more human-shaped gap (see project memory's AI-asymmetry findings).
  const engines = [options.engineA || 'mcts', options.engineB || 'mcts'];
  // 6-2-1-6/7: mulligan() runs for the first player, then the second, in that order.
  const firstIdx = state.activePlayerIdx;
  const mulliganed = [null, null];
  mulliganed[firstIdx] = mulliganLog[0];
  mulliganed[1 - firstIdx] = mulliganLog[1];
  const openingCurve = state.players.map(handCurve);

  const hooks = lookaheadHooks(state);
  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;

    runResourcePhase(state);
    if (engines[state.activePlayerIdx] === 'lookahead') runMainPhase(state, state.activePlayerIdx, hooks);
    else runMainPhaseMCTS(state, state.activePlayerIdx, hooks);
    if (state.winner !== null || state.draw) break;

    runEndPhase(state);
    passTurn(state);
  }

  return summarize(state, mulliganed, openingCurve, options.seed, firstIdx);
}

/** Whether the (post-mulligan) opening hand had a playable card by turn 1/2/3, for curve-quality stats. */
function handCurve(player) {
  const cheapestCost = Math.min(
    ...player.hand.filter((c) => c.def.type !== 'resource').map((c) => c.def.cost || 0)
  );
  return { turn1: cheapestCost <= 1, turn2: cheapestCost <= 2, turn3: cheapestCost <= 3 };
}

function summarize(state, mulliganed, openingCurve, seed, firstPlayer) {
  return {
    winner: state.winner,
    turns: state.turnNumber,
    draw: state.draw,
    timedOut: state.winner === null && !state.draw,
    mulliganed,
    openingCurve,
    seed,
    firstPlayer,
    shields: state.players.map((p) => p.shields.length)
  };
}

module.exports = { playGame };
