// Second attempt at a generalizable density-driven search-budget mechanism, after the absolute
// per-deck version (deck_density_search_budget_check.js) failed to reproduce the confirmed effect
// (both sides got boosted, cancelling out -- 0.6pt, z=0.22). Reframed as RELATIVE: only the side that
// is MORE decision-dense than its specific opponent gets a boost (scaled by how many pool-std the gap
// is), the less-dense side stays at DEFAULT_MCTS_CONFIG's baseline (25, unboosted, un-penalized) --
// mirrors the empirically-confirmed setup (Barbatos boosted, Nu Gundam left alone) but derives the
// boost SIZE from a principled, pool-calibrated formula rather than reusing the exact known-good
// numbers, so this is a real test of the mechanism, not a trivial reproduction.
//
// boost = MAX_BOOST * clamp01(gapInStd / SATURATION_STD), MAX_BOOST=75 (DEFAULT..BALANCED range),
// SATURATION_STD=3 (a 3-pool-std density gap gets the full boost) -- deliberately gentler than what
// would exactly reproduce Barbatos=100/NuGundam=25 by construction, so a positive result here is new
// evidence, not circular.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');
const banlist = require('../data/banlist.json');

const POOL_STD = 0.083;
const BASE_BUDGET = 25, MAX_BOOST = 75, SATURATION_STD = Number(process.argv[3] || 3);

function densityOf(parsed) {
  let total = 0, withEffect = 0;
  for (const entry of parsed.main) {
    const def = lookupCard(entry.number);
    total += entry.quantity;
    if (def.effectRefs && Object.keys(def.effectRefs).length > 0) withEffect += entry.quantity;
  }
  return withEffect / total;
}

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return { deck: buildGameDeck({ main: parsed.main }, lookupCard), density: densityOf(parsed) };
}

const barbatos = loadDeck('barbatos_real.txt');
const nuGundam = loadDeck('nu_gundam_real.txt');

const gapInStd = (barbatos.density - nuGundam.density) / POOL_STD;
const barbatosBoost = Math.round(MAX_BOOST * Math.max(0, Math.min(1, gapInStd / SATURATION_STD)));
const nuGundamBoost = Math.round(MAX_BOOST * Math.max(0, Math.min(1, -gapInStd / SATURATION_STD)));
const barbatosBudget = BASE_BUDGET + barbatosBoost;
const nuGundamBudget = BASE_BUDGET + nuGundamBoost;
console.log(
  `Relative density gap: ${gapInStd.toFixed(2)} std -- Barbatos budget=${barbatosBudget} (boost ${barbatosBoost}), ` +
    `Nu Gundam budget=${nuGundamBudget} (boost ${nuGundamBoost})\n`
);

const barbatosConfig = { ...DEFAULT_MCTS_CONFIG, playoutBudget: barbatosBudget };
const nuGundamConfig = { ...DEFAULT_MCTS_CONFIG, playoutBudget: nuGundamBudget };

function runCondition(label, barbatosCfg, nuCfg, n) {
  let barbatosWins = 0, total = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < n; i++) {
    const barbatosIsA = i % 2 === 0;
    const r = playGame(barbatosIsA ? barbatos.deck : nuGundam.deck, barbatosIsA ? nuGundam.deck : barbatos.deck, {
      mctsConfigA: barbatosIsA ? barbatosCfg : nuCfg,
      mctsConfigB: barbatosIsA ? nuCfg : barbatosCfg
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

const N = Number(process.argv[2] || 500);
console.log(`${N} games per condition\n`);
const t0 = Date.now();
const baseline = runCondition('Equal search (both DEFAULT_MCTS_CONFIG, 25 playouts)', DEFAULT_MCTS_CONFIG, DEFAULT_MCTS_CONFIG, N);
const derived = runCondition(`Relative density-derived budgets (Barbatos ${barbatosBudget}, Nu Gundam ${nuGundamBudget})`, barbatosConfig, nuGundamConfig, N);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
console.log(`Delta from relative density-derived budgets: ${(derived - baseline).toFixed(1)}pt`);

const p1 = baseline / 100, p2 = derived / 100;
const pooled = (p1 + p2) / 2;
const se = Math.sqrt(pooled * (1 - pooled) * (2 / N));
console.log(`Two-proportion z: ${((p2 - p1) / se).toFixed(2)} (>= 2.5 is this project's significance bar)`);
