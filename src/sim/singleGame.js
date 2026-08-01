const { initializeGame } = require('../rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../rules/phases');
const { checkDefeat } = require('../rules/management');
const { decideMulligan, runMainPhase, defaultHooks } = require('../ai/heuristic');

const MAX_TURNS = 60; // safety cap against a stalemate/decking-out loop that never naturally ends

/**
 * Plays one full game between two {main, resource} CardDef decks using the heuristic bot on both
 * sides (7-1-1: start/draw/resource/main/end phases, repeated until someone wins or MAX_TURNS).
 */
function playGame(deckA, deckB) {
  const mulliganLog = [];
  const trackedDecideMulligan = (hand) => {
    const shouldMulligan = decideMulligan(hand);
    mulliganLog.push(shouldMulligan);
    return shouldMulligan;
  };

  const state = initializeGame(deckA, deckB, { decideMulligan: trackedDecideMulligan });
  // 6-2-1-6/7: mulligan() runs for the first player, then the second, in that order.
  const firstIdx = state.activePlayerIdx;
  const mulliganed = [null, null];
  mulliganed[firstIdx] = mulliganLog[0];
  mulliganed[1 - firstIdx] = mulliganLog[1];
  const openingCurve = state.players.map(handCurve);

  const hooks = defaultHooks();
  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;

    runResourcePhase(state);
    runMainPhase(state, state.activePlayerIdx, hooks);
    if (state.winner !== null || state.draw) break;

    runEndPhase(state);
    passTurn(state);
  }

  return summarize(state, mulliganed, openingCurve);
}

/** Whether the (post-mulligan) opening hand had a playable card by turn 1/2/3, for curve-quality stats. */
function handCurve(player) {
  const cheapestCost = Math.min(
    ...player.hand.filter((c) => c.def.type !== 'resource').map((c) => c.def.cost || 0)
  );
  return { turn1: cheapestCost <= 1, turn2: cheapestCost <= 2, turn3: cheapestCost <= 3 };
}

function summarize(state, mulliganed, openingCurve) {
  return {
    winner: state.winner,
    turns: state.turnNumber,
    draw: state.draw,
    timedOut: state.winner === null && !state.draw,
    mulliganed,
    openingCurve
  };
}

module.exports = { playGame };
