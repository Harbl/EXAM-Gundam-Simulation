// Jake's question: maybe the 20% sim vs 64% real gap isn't a Barbatos Rush problem at all -- maybe
// our MCTS bot just pilots Nu Gundam exceptionally tightly (attrition/board-control decks are easier
// for a shallow evaluation function to play well) while real MSA ladder opponents piloting Nu Gundam
// aren't as sharp, and/or Barbatos Rush is a deck whose real 64% win rate partly comes from punishing
// imperfect human blocking/sequencing that our bot (playing itself) never actually makes.
//
// Since the SAME MCTS algorithm pilots both sides today, if there's a real asymmetry it has to come
// from scoreState/search suiting one deck's plan better, not from "the code plays one side smarter."
// Direct test: swap one side to the deliberately weaker old lookahead AI (proven ~65-69% weaker than
// MCTS in self-play) and see which side's win rate moves more. If downgrading Nu Gundam's piloting
// moves Barbatos's win rate up a lot, that's real evidence for "sim Nu Gundam is just tightly played."
// If downgrading Barbatos's own piloting barely changes anything, that suggests Barbatos's ceiling
// isn't the bottleneck either -- pointing at the evaluation function undervaluing its actual game plan.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { initializeGame } = require('../src/rules/setup');
const { runStartPhase, runDrawPhase, runResourcePhase, runEndPhase, passTurn } = require('../src/rules/phases');
const { checkDefeat } = require('../src/rules/management');
const { decideMulligan, runMainPhase, lookaheadHooks } = require('../src/ai/heuristic');
const { runMainPhaseMCTS, DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const barbatos = loadDeck('barbatos_real.txt');
const nuGundam = loadDeck('nu_gundam_real.txt');

/** barbatosAI/nuAI: 'mcts' or 'old'. barbatosIsA: which deck is player A this game (turn-order rotates). */
function playOne(barbatosAI, nuAI, barbatosIsA) {
  const deckA = barbatosIsA ? barbatos : nuGundam;
  const deckB = barbatosIsA ? nuGundam : barbatos;
  const state = initializeGame(deckA, deckB, { decideMulligan });
  const barbatosIdx = barbatosIsA ? 0 : 1;
  const hooks = lookaheadHooks(state);

  while (state.winner === null && !state.draw && state.turnNumber <= 60) {
    runStartPhase(state);
    runDrawPhase(state);
    checkDefeat(state);
    if (state.winner !== null || state.draw) break;
    runResourcePhase(state);
    const isBarbatosTurn = state.activePlayerIdx === barbatosIdx;
    const ai = isBarbatosTurn ? barbatosAI : nuAI;
    if (ai === 'old') runMainPhase(state, state.activePlayerIdx, hooks);
    else runMainPhaseMCTS(state, state.activePlayerIdx, hooks, DEFAULT_MCTS_CONFIG);
    if (state.winner !== null || state.draw) break;
    runEndPhase(state);
    passTurn(state);
  }
  return { winner: state.winner, draw: state.draw, timedOut: state.winner === null && !state.draw, barbatosIdx };
}

function runCondition(label, barbatosAI, nuAI, n) {
  let barbatosWins = 0, total = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < n; i++) {
    const r = playOne(barbatosAI, nuAI, i % 2 === 0);
    if (r.draw) { draws++; continue; }
    if (r.timedOut) { timeouts++; continue; }
    total++;
    if (r.winner === r.barbatosIdx) barbatosWins++;
  }
  const rate = total > 0 ? (barbatosWins / total) * 100 : NaN;
  console.log(`${label}: Barbatos ${barbatosWins}/${total} (${rate.toFixed(1)}%) draws=${draws} timeouts=${timeouts}`);
  return rate;
}

const N = Number(process.argv[2] || 60);
console.log(`${N} games per condition\n`);
const t0 = Date.now();
const baseline = runCondition('Baseline (both MCTS)', 'mcts', 'mcts', N);
const weakerNu = runCondition('Nu Gundam downgraded to OLD lookahead', 'mcts', 'old', N);
const weakerBarbatos = runCondition('Barbatos downgraded to OLD lookahead', 'old', 'mcts', N);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
console.log(`\nDelta from downgrading Nu: ${(weakerNu - baseline).toFixed(1)}pt`);
console.log(`Delta from downgrading Barbatos: ${(weakerBarbatos - baseline).toFixed(1)}pt`);
