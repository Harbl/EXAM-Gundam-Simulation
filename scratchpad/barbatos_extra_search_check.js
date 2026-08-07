// Free, zero-new-production-code probe: the established theory (barbatos_ai_asymmetry.js,
// project memory) is that search quality helps Nu Gundam's plan more than Barbatos Rush's. If that's
// the actual cause of the sim-vs-real gap (sim ~20-27% Barbatos, real ~64%), then pointing MORE search
// specifically at Barbatos (not less at Nu Gundam -- deliberately handicapping one side to hit a target
// number would be the "AI cheating" anti-pattern, not a real fix) should narrow the gap, since it
// directly compensates for search's uneven benefit rather than changing what's being evaluated.
// Reuses existing BALANCED_MCTS_CONFIG (mcts.js) and playGame's mctsConfigA/B options -- no new code.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_MCTS_CONFIG, BALANCED_MCTS_CONFIG } = require('../src/ai/mcts');
const banlist = require('../data/banlist.json');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const barbatos = loadDeck('barbatos_real.txt');
const nuGundam = loadDeck('nu_gundam_real.txt');

function runCondition(label, barbatosConfig, nuConfig, n) {
  let barbatosWins = 0, total = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < n; i++) {
    const barbatosIsA = i % 2 === 0;
    const r = playGame(barbatosIsA ? barbatos : nuGundam, barbatosIsA ? nuGundam : barbatos, {
      mctsConfigA: barbatosIsA ? barbatosConfig : nuConfig,
      mctsConfigB: barbatosIsA ? nuConfig : barbatosConfig
    });
    if (r.draw) { draws++; continue; }
    if (r.timedOut) { timeouts++; continue; }
    total++;
    if ((r.winner === 0) === barbatosIsA) barbatosWins++;
  }
  const rate = total > 0 ? (barbatosWins / total) * 100 : NaN;
  console.log(`${label}: Barbatos ${barbatosWins}/${total} (${rate.toFixed(1)}%) draws=${draws} timeouts=${timeouts}`);
  return rate;
}

const N = Number(process.argv[2] || 100);
console.log(`${N} games per condition (real ladder target: ~64% Barbatos; today's equal-search sim baseline: ~20-27%)\n`);
const t0 = Date.now();
const baseline = runCondition('Equal search (both DEFAULT_MCTS_CONFIG)', DEFAULT_MCTS_CONFIG, DEFAULT_MCTS_CONFIG, N);
const barbatosBoosted = runCondition('Barbatos gets BALANCED (100 playouts), Nu Gundam stays DEFAULT (25)', BALANCED_MCTS_CONFIG, DEFAULT_MCTS_CONFIG, N);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
console.log(`Delta from boosting Barbatos's search: ${(barbatosBoosted - baseline).toFixed(1)}pt`);

// Two-proportion z-test (independent samples, not SPRT -- there's no clean paired/head-to-head framing
// here since both conditions play the same fixed opponent rather than each other), same z>=2.5 bar as
// every other significance check in this project.
const p1 = baseline / 100, p2 = barbatosBoosted / 100;
const pooled = (p1 + p2) / 2;
const se = Math.sqrt(pooled * (1 - pooled) * (2 / N));
console.log(`Two-proportion z: ${((p2 - p1) / se).toFixed(2)} (>= 2.5 is this project's significance bar)`);
