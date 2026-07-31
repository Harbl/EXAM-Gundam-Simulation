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
  const state = initializeGame(deckA, deckB, { decideMulligan });
  const hooks = defaultHooks();

  while (state.winner === null && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null) break;

    runResourcePhase(state);
    runMainPhase(state, state.activePlayerIdx, hooks);
    if (state.winner !== null) break;

    runEndPhase(state);
    passTurn(state);
  }

  return summarize(state);
}

function summarize(state) {
  return {
    winner: state.winner,
    turns: state.turnNumber,
    timedOut: state.winner === null
  };
}

module.exports = { playGame };
