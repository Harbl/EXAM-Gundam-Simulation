// Rigorous before/after self-play comparison for the new MCTS AI, same methodology as
// scratchpad/old_vs_new.js used for the opponent-modeling round: same deck both sides, one side runs
// today's proven lookahead (runMainPhase+lookaheadHooks), the other runs the new MCTS
// (runMainPhaseMCTS, DEFAULT_MCTS_CONFIG), alternating which side is old/new to cancel first-player
// advantage. Cross-validated across multiple decks. z-score flags a result as real signal at |z| >= 2.5.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan, runMainPhase, lookaheadHooks } = require('../src/ai/heuristic');
const { runMainPhaseMCTS, DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');
const banlist = require('../data/banlist.json');

const MAX_TURNS = 60;

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

/** oldIsA: true if player index 0 (deck A) runs the current lookahead, false if player 1 does. */
function playOldVsMCTS(deck, oldIsA) {
  const state = initializeGame(deck, deck, { decideMulligan });

  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;

    runResourcePhase(state);
    const activeIsOld = (state.activePlayerIdx === 0) === oldIsA;
    if (activeIsOld) runMainPhase(state, state.activePlayerIdx, lookaheadHooks(state));
    else runMainPhaseMCTS(state, state.activePlayerIdx, undefined, DEFAULT_MCTS_CONFIG);
    if (state.winner !== null || state.draw) break;

    runEndPhase(state);
    passTurn(state);
  }

  return { winner: state.winner, draw: state.draw, timedOut: state.winner === null && !state.draw, turns: state.turnNumber };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const allDeckNames = fs.readdirSync(path.join(__dirname, 'decklists')).filter((f) => f.endsWith('.txt'));
const NUM_DECKS = Number(process.argv[2] || 6);
const DECK_NAMES = shuffle(allDeckNames).slice(0, NUM_DECKS);
const GAMES_PER_DECK = Number(process.argv[3] || 60);

let winsMCTS = 0,
  winsOld = 0,
  draws = 0,
  timeouts = 0,
  turnsTotal = 0;

const t0 = Date.now();
for (const name of DECK_NAMES) {
  const deck = loadDeck(name);
  let dMCTS = 0,
    dOld = 0;
  for (let i = 0; i < GAMES_PER_DECK; i++) {
    const oldIsA = i % 2 === 0;
    const r = playOldVsMCTS(deck, oldIsA);
    turnsTotal += Math.ceil(r.turns / 2);
    if (r.draw) {
      draws++;
      continue;
    }
    if (r.timedOut) {
      timeouts++;
      continue;
    }
    const oldWon = (r.winner === 0) === oldIsA;
    if (oldWon) {
      winsOld++;
      dOld++;
    } else {
      winsMCTS++;
      dMCTS++;
    }
  }
  console.log(`${name}: MCTS ${dMCTS} - ${dOld} old`);
}

const total = winsMCTS + winsOld + draws + timeouts;
const p = winsMCTS / total;
const se = Math.sqrt(0.5 * 0.5 / total); // null hypothesis: 50/50
const z = (p - 0.5) / se;

console.log(`\nTOTAL: ${total} games in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`MCTS wins: ${winsMCTS} (${(p * 100).toFixed(1)}%)`);
console.log(`Old (lookahead) wins: ${winsOld} (${((winsOld / total) * 100).toFixed(1)}%)`);
console.log(`Draws: ${draws}, Timeouts: ${timeouts}, Avg turns: ${(turnsTotal / total).toFixed(1)}`);
console.log(`z-score vs 50/50: ${z.toFixed(2)} (|z| >= 2.5 is a real signal)`);
