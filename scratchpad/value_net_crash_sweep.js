// Crash/timeout sanity sweep for the trained valueNet.js champion (data/valueNet.json), modeled
// directly on mcts_crash_sweep.js -- same "broad sample of the real deck pool, not just the small
// win-rate-comparison sample" precedent, run before ever considering this net for a real default (see
// Phase 7 of the plan's verification section).
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
const { loadNet } = require('../src/ai/valueNet');
const banlist = require('../data/banlist.json');

const MAX_TURNS = 60;
const net = loadNet(path.join(__dirname, '..', 'data', 'valueNet.json'));

function playGameWithNet(deckA, deckB) {
  const state = initializeGame(deckA, deckB, { decideMulligan });
  state.players[0].valueModel = net;
  state.players[1].valueModel = net;
  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;
    runResourcePhase(state);
    runMainPhaseMCTS(state, state.activePlayerIdx, undefined, DEFAULT_MCTS_CONFIG);
    if (state.winner !== null || state.draw) break;
    runEndPhase(state);
    passTurn(state);
  }
  return { winner: state.winner, draw: state.draw, timedOut: state.winner === null && !state.draw, turns: state.turnNumber };
}

const dir = path.join(__dirname, 'decklists');
const names = fs.readdirSync(dir).sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const NUM_PAIRS = Number(process.argv[2] || 100);
const GAMES_PER_PAIR = Number(process.argv[3] || 2);
const shuffled = shuffle(names);
const pairs = [];
for (let i = 0; i < NUM_PAIRS; i++) {
  const a = shuffled[i % shuffled.length];
  const b = shuffled[(i + 7) % shuffled.length];
  if (a !== b) pairs.push([a, b]);
}

function loadDeck(name) {
  const parsed = parseDecklistText(fs.readFileSync(path.join(dir, name), 'utf8'));
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

let totalGames = 0, totalDraws = 0, totalTimeouts = 0, totalCrashes = 0, totalTurns = 0;
const crashes = [];

const t0 = Date.now();
for (const [a, b] of pairs) {
  const deckA = loadDeck(a);
  const deckB = loadDeck(b);
  for (let i = 0; i < GAMES_PER_PAIR; i++) {
    totalGames++;
    try {
      const r = playGameWithNet(deckA, deckB);
      if (r.draw) totalDraws++;
      if (r.timedOut) totalTimeouts++;
      totalTurns += Math.ceil(r.turns / 2);
    } catch (err) {
      totalCrashes++;
      crashes.push({ a, b, message: err.message, stack: err.stack });
      console.error(`CRASH: ${a} vs ${b}: ${err.message}`);
    }
  }
}

console.log(`\nTOTAL: ${totalGames} games across ${pairs.length} pairings in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`Draws: ${totalDraws}, Timeouts: ${totalTimeouts}, Crashes: ${totalCrashes}, Avg turns: ${(totalTurns / totalGames).toFixed(1)}`);
if (crashes.length > 0) {
  console.log('\n--- Crash details (first 5) ---');
  for (const c of crashes.slice(0, 5)) console.log(`${c.a} vs ${c.b}: ${c.message}\n${c.stack}\n`);
}
