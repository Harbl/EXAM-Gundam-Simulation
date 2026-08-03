// Follow-up to race_speed_diagnostic.js: the first hand-read trace (trace_game_mcts.js) showed
// Barbatos Rush (a low-curve, cost-1/2 heavy deck) not deploying ANYTHING until turn 5 in one sample
// game -- surprising for a "rush" archetype. This measures, across many real games, whether that's
// bad-draw variance or a systemic AI problem: for each of Barbatos's first 4 turns, was a 'deploy'
// action actually legal (affordable + Level-eligible) at the start of that main phase, and if so, did
// the AI take ANY deploy action that turn? Distinguishes "no play available" from "had a play, skipped it".
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan, lookaheadHooks } = require('../src/ai/heuristic');
const { runMainPhaseMCTS, getLegalActions, DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const barbatos = loadDeck('barbatos_real.txt');
const nuGundam = loadDeck('nu_gundam_real.txt');

const N = Number(process.argv[2] || 40);
const WATCH_TURNS = 4; // Barbatos's own turn count, i.e. real turn 1/2/3/4 for that player

// perTurn[i] = { hadLegalDeploy, tookDeploy } counts across all games, for Barbatos's i-th own turn
const perTurn = Array.from({ length: WATCH_TURNS }, () => ({ hadLegalDeploy: 0, tookDeploy: 0, games: 0 }));

for (let i = 0; i < N; i++) {
  const barbatosIsA = i % 2 === 0;
  const state = barbatosIsA
    ? initializeGame(barbatos, nuGundam, { decideMulligan })
    : initializeGame(nuGundam, barbatos, { decideMulligan });
  const barbatosIdx = barbatosIsA ? 0 : 1;
  const hooks = lookaheadHooks(state);
  let barbatosOwnTurn = 0;

  while (state.winner === null && !state.draw && state.turnNumber <= 60 && barbatosOwnTurn < WATCH_TURNS) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;
    runResourcePhase(state);

    if (state.activePlayerIdx === barbatosIdx) {
      const legalBefore = getLegalActions(state, barbatosIdx);
      const hadLegalDeploy = legalBefore.some((a) => a.type === 'deploy');
      const battleAreaBefore = state.players[barbatosIdx].battleArea.length;
      const baseBefore = state.players[barbatosIdx].base;

      runMainPhaseMCTS(state, state.activePlayerIdx, hooks);

      const battleAreaAfter = state.players[barbatosIdx].battleArea.length;
      const baseAfter = state.players[barbatosIdx].base;
      const tookDeploy = battleAreaAfter > battleAreaBefore || baseAfter !== baseBefore;

      perTurn[barbatosOwnTurn].games++;
      if (hadLegalDeploy) perTurn[barbatosOwnTurn].hadLegalDeploy++;
      if (tookDeploy) perTurn[barbatosOwnTurn].tookDeploy++;
      barbatosOwnTurn++;
    } else {
      runMainPhaseMCTS(state, state.activePlayerIdx, hooks);
    }

    if (state.winner !== null || state.draw) break;
    runEndPhase(state);
    passTurn(state);
  }
}

console.log(`${N} games, Barbatos Rush vs Nu Gundam, MCTS both sides\n`);
console.log('Barbatos own-turn# | had legal deploy | actually deployed something');
perTurn.forEach((t, i) => {
  console.log(
    `  Turn ${i + 1}: ${t.games} games, legal-deploy-available ${t.hadLegalDeploy}/${t.games} (${((t.hadLegalDeploy / t.games) * 100).toFixed(0)}%), ` +
    `actually-deployed ${t.tookDeploy}/${t.games} (${((t.tookDeploy / t.games) * 100).toFixed(0)}%)` +
    (t.hadLegalDeploy > t.tookDeploy ? `  <-- ${t.hadLegalDeploy - t.tookDeploy} game(s) had a legal deploy but skipped it` : '')
  );
});
