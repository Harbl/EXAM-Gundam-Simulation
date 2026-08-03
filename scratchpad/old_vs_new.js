// One-off scratch tool: measures how much the lookahead AI stack (attack/deploy/pairing/command/
// blocker search, all shipped this session) actually improved play, by running it head-to-head
// against the exact pre-lookahead heuristic -- which still exists in the code as runMainPhaseSimple
// (the recursion-guard fallback used inside every simulated trial). Same deck both sides so only the
// AI differs; alternates which side is "old" to cancel out first-player advantage.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan, runMainPhase, runMainPhaseSimple, defaultHooks, lookaheadHooks } = require('../src/ai/heuristic');
const banlist = require('../data/banlist.json');

const MAX_TURNS = 60;

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

/** oldIsA: true if player index 0 (deck A) runs the pre-lookahead heuristic, false if player 1 does. */
function playOldVsNew(deck, oldIsA) {
  const state = initializeGame(deck, deck, { decideMulligan });
  const oldHooks = defaultHooks();

  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;

    runResourcePhase(state);
    const activeIsOld = (state.activePlayerIdx === 0) === oldIsA;
    if (activeIsOld) runMainPhaseSimple(state, state.activePlayerIdx, oldHooks);
    else runMainPhase(state, state.activePlayerIdx, lookaheadHooks(state));
    if (state.winner !== null || state.draw) break;

    runEndPhase(state);
    passTurn(state);
  }

  return { winner: state.winner, draw: state.draw, timedOut: state.winner === null && !state.draw, turns: state.turnNumber };
}

const DECK_NAMES = ['deck3.txt', 'deck9.txt', 'deck24.txt', 'deck31.txt', 'deck34.txt', 'deck5.txt'];
const GAMES_PER_DECK = Number(process.argv[2] || 100);

let winsNew = 0, winsOld = 0, draws = 0, timeouts = 0, turnsTotal = 0;
const perDeck = {};

for (const name of DECK_NAMES) {
  const deck = loadDeck(name);
  let dNew = 0, dOld = 0;
  for (let i = 0; i < GAMES_PER_DECK; i++) {
    const oldIsA = i % 2 === 0;
    const r = playOldVsNew(deck, oldIsA);
    turnsTotal += Math.ceil(r.turns / 2); // turnNumber counts per-player turns, not rounds
    if (r.draw) { draws++; continue; }
    if (r.timedOut) { timeouts++; continue; }
    const oldWon = (r.winner === 0) === oldIsA;
    if (oldWon) { winsOld++; dOld++; } else { winsNew++; dNew++; }
  }
  perDeck[name] = `${dNew}-${dOld}`;
  console.log(`${name}: new ${dNew} - ${dOld} old`);
}

const total = winsNew + winsOld + draws + timeouts;
console.log(`\nTOTAL: ${total} games`);
console.log(`New (lookahead) wins: ${winsNew} (${((winsNew / total) * 100).toFixed(1)}%)`);
console.log(`Old (pre-lookahead) wins: ${winsOld} (${((winsOld / total) * 100).toFixed(1)}%)`);
console.log(`Draws: ${draws}, Timeouts: ${timeouts}, Avg turns: ${(turnsTotal / total).toFixed(1)}`);
