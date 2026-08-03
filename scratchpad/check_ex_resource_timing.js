// Throwaway investigation: does the payCost fix (prefer normal Resources, EX Resource as last
// resort) actually make the AI hold the EX Resource for multiple turns now, or does it still get
// spent almost immediately? Runs N real games (MCTS default engine, no engine option override) and
// logs, for Player Two (the only side that ever starts with an EX Resource, 6-2-4), the turn number
// and player-Level (resourceArea.length) at the moment it gets spent -- or confirms it survives to
// game end.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const banlist = require('../data/banlist.json');

const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan, lookaheadHooks } = require('../src/ai/heuristic');
const { runMainPhaseMCTS } = require('../src/ai/mcts');

function loadDeck(fileName) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', fileName), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${fileName}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const [deckAName, deckBName, gamesArg] = process.argv.slice(2);
if (!deckAName || !deckBName) {
  console.error('Usage: node scratchpad/check_ex_resource_timing.js deckA.txt deckB.txt [games=15]');
  process.exit(1);
}
const GAMES = Number(gamesArg) || 15;
const deckA = loadDeck(deckAName);
const deckB = loadDeck(deckBName);

const MAX_TURNS = 60;

function playOneTracked() {
  const state = initializeGame(deckA, deckB, { decideMulligan });
  const tokenIdx = state.players.findIndex((p) => p.resourceArea.some((r) => r.def.isToken));
  const p1 = state.players[tokenIdx];
  const startedWithToken = tokenIdx !== -1;
  if (!startedWithToken) return { hadToken: false };

  const hooks = lookaheadHooks(state);
  let spentAtTurn = null;
  let spentAtLevel = null;
  while (state.winner === null && !state.draw && state.turnNumber <= MAX_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;

    runResourcePhase(state);
    const levelBefore = p1.resourceArea.length;
    runMainPhaseMCTS(state, state.activePlayerIdx, hooks);
    if (spentAtTurn === null && !p1.resourceArea.some((r) => r.def.isToken)) {
      spentAtTurn = state.turnNumber;
      spentAtLevel = levelBefore; // Level (resourceArea.length) at the moment it was still present
    }
    if (state.winner !== null || state.draw) break;

    runEndPhase(state);
    passTurn(state);
  }

  return { hadToken: true, spentAtTurn, spentAtLevel, gameTurns: state.turnNumber };
}

let neverSpent = 0;
const spentTurns = [];
const spentLevels = [];
for (let i = 0; i < GAMES; i++) {
  const result = playOneTracked();
  if (!result.hadToken) continue;
  if (result.spentAtTurn === null) {
    neverSpent++;
    console.log(`game ${i + 1}: EX Resource never spent (game lasted ${result.gameTurns} turns)`);
  } else {
    spentTurns.push(result.spentAtTurn);
    spentLevels.push(result.spentAtLevel);
    console.log(`game ${i + 1}: EX Resource spent on turn ${result.spentAtTurn} (P2's Level was ${result.spentAtLevel} just before)`);
  }
}

console.log('\n--- Summary ---');
console.log(`Games: ${GAMES}, never spent: ${neverSpent}, spent: ${spentTurns.length}`);
if (spentTurns.length) {
  console.log(`Spent-at-turn: min ${Math.min(...spentTurns)}, max ${Math.max(...spentTurns)}, avg ${(spentTurns.reduce((a, b) => a + b, 0) / spentTurns.length).toFixed(1)}`);
  console.log(`Level at spend: min ${Math.min(...spentLevels)}, max ${Math.max(...spentLevels)}, avg ${(spentLevels.reduce((a, b) => a + b, 0) / spentLevels.length).toFixed(1)}`);
}
