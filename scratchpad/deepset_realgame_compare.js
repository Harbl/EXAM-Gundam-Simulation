// Real-game wall-clock comparison: N self-play games scored by the shipped flat net vs. N scored by
// a freshly-created (untrained -- timing only, not quality) DeepSets net, same MCTS config held
// constant. Complements deepset_throughput_compare.js's synthetic forward()-only numbers with the
// actual end-to-end cost once state-cloning/legal-action enumeration are in the mix too.
const path = require('node:path');
const fs = require('node:fs');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan } = require('../src/ai/heuristic');
const { runMainPhaseMCTS, BALANCED_MCTS_CONFIG } = require('../src/ai/mcts');
const { loadNet: loadFlat } = require('../src/ai/valueNet');
const { createNet: createDeepSet } = require('../src/ai/deepSetValueNet');
const banlist = require('../data/banlist.json');

const MAX_TURNS = 60;
const N_GAMES = Number(process.argv[2] || 20);

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}
const deckNames = fs.readdirSync(path.join(__dirname, 'decklists')).slice(0, 10);
const decks = deckNames.map(loadDeck);

function playOne(valueModel) {
  const state = initializeGame(decks[0], decks[1], { decideMulligan });
  if (valueModel) {
    state.players[0].valueModel = valueModel;
    state.players[1].valueModel = valueModel;
  }
  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;
    runResourcePhase(state);
    runMainPhaseMCTS(state, state.activePlayerIdx, undefined, BALANCED_MCTS_CONFIG);
    if (state.winner !== null || state.draw) break;
    runEndPhase(state);
    passTurn(state);
  }
}

function timeGames(label, valueModel, n) {
  const t0 = Date.now();
  for (let i = 0; i < n; i++) playOne(valueModel);
  const ms = Date.now() - t0;
  console.log(`${label}: ${n} games in ${(ms / 1000).toFixed(1)}s (${(ms / n).toFixed(0)}ms/game)`);
  return ms;
}

const flatModel = loadFlat(path.join(__dirname, '..', 'data', 'valueNet.json'));
const deepSetModel = createDeepSet(1);

const flatMs = timeGames('flat net', flatModel, N_GAMES);
const deepSetMs = timeGames('deepset net', deepSetModel, N_GAMES);
console.log(`\nreal-game multiplier: ${(deepSetMs / flatMs).toFixed(2)}x`);
