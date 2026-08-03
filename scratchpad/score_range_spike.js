// One-off measurement: real scoreState magnitude range across representative in-game states, to pick
// a REWARD_SCALE constant for mcts.js's UCT reward normalization (see Phase 5 plan, step 1) instead of
// guessing one. Samples scoreState(state, playerIdx) for both players after every main phase across a
// sample of real games (current default MCTS both sides).
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan } = require('../src/ai/heuristic');
const { runMainPhaseMCTS, DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');
const { scoreState } = require('../src/ai/score');
const banlist = require('../data/banlist.json');

const MAX_TURNS = 60;
const samples = [];

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

function playAndSample(deckA, deckB) {
  const state = initializeGame(deckA, deckB, { decideMulligan });
  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;
    runResourcePhase(state);
    runMainPhaseMCTS(state, state.activePlayerIdx, undefined, DEFAULT_MCTS_CONFIG);
    // Sample from the non-terminal perspective only -- terminal scores are +/-Infinity by design and
    // already handled separately by clampedScore's existing +/-1e6 clamp.
    if (state.winner === null && !state.draw) {
      samples.push(scoreState(state, 0));
      samples.push(scoreState(state, 1));
    }
    if (state.winner !== null || state.draw) break;
    runEndPhase(state);
    passTurn(state);
  }
}

const NAMES = fs.readdirSync(path.join(__dirname, 'decklists'));
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const PAIRS = Number(process.argv[2] || 20);
const shuffled = shuffle(NAMES);

for (let i = 0; i < PAIRS; i++) {
  const a = shuffled[i % shuffled.length];
  const b = shuffled[(i + 7) % shuffled.length];
  if (a === b) continue;
  playAndSample(loadDeck(a), loadDeck(b));
}

samples.sort((x, y) => x - y);
const abs = samples.map(Math.abs).sort((x, y) => x - y);
const pct = (arr, p) => arr[Math.floor(arr.length * p)];

console.log(`${samples.length} samples from ${PAIRS} game pairings`);
console.log(`min=${samples[0].toFixed(1)} max=${samples[samples.length - 1].toFixed(1)}`);
console.log(`abs: p50=${pct(abs, 0.5).toFixed(1)} p75=${pct(abs, 0.75).toFixed(1)} p90=${pct(abs, 0.9).toFixed(1)} p95=${pct(abs, 0.95).toFixed(1)} p99=${pct(abs, 0.99).toFixed(1)} max=${abs[abs.length - 1].toFixed(1)}`);
