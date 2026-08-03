// One-off diagnostic: is Isaribi (ST05-015, newly wired this batch, real Tekkadan self-damage
// synergy) ever actually deployed and actually offered as a legal Activate*Main action in real
// Barbatos Rush vs Nu Gundam games? If it's rarely/never deployed, wiring its ability can't have
// moved the benchmark needle regardless of how good the resolver is.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan } = require('../src/ai/heuristic');
const { runMainPhaseMCTS, DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');
const { RESOLVERS } = require('../src/ai/activations');

const WATCH = { 'ST05-015': 'Isaribi' };
let offeredCount = 0;
for (const num of Object.keys(WATCH)) {
  const original = RESOLVERS[num];
  RESOLVERS[num] = (state, player, opponent, source) => {
    const args = original(state, player, opponent, source);
    if (args) offeredCount++;
    return args;
  };
}

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const barbatos = loadDeck('barbatos_real.txt');
const nuGundam = loadDeck('nu_gundam_real.txt');

const N = Number(process.argv[2] || 40);
let deployedGames = 0;
let totalGames = 0;

for (let i = 0; i < N; i++) {
  totalGames++;
  const barbatosIsA = i % 2 === 0;
  const state = barbatosIsA ? initializeGame(barbatos, nuGundam, { decideMulligan }) : initializeGame(nuGundam, barbatos, { decideMulligan });
  const barbatosIdx = barbatosIsA ? 0 : 1;
  let everDeployed = false;
  let turns = 0;
  while (state.winner === null && !state.draw && turns++ < 60) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;
    runResourcePhase(state);
    runMainPhaseMCTS(state, state.activePlayerIdx, undefined, DEFAULT_MCTS_CONFIG);
    const bp = state.players[barbatosIdx];
    if ((bp.base && bp.base.def.number === 'ST05-015') || bp.battleArea.some((u) => u.def.number === 'ST05-015')
      || bp.trash.some((c) => c.def.number === 'ST05-015')) {
      everDeployed = true;
    }
    if (state.winner !== null || state.draw) break;
    runEndPhase(state);
    passTurn(state);
  }
  if (everDeployed) deployedGames++;
}

console.log(`${totalGames} games (Barbatos Rush vs Nu Gundam, MCTS both sides)`);
console.log(`Isaribi (ST05-015) deployed/trashed at some point: ${deployedGames}/${totalGames} games (${((deployedGames / totalGames) * 100).toFixed(1)}%)`);
console.log(`Isaribi's Activate*Main offered (non-null resolver) total across all games: ${offeredCount}`);
