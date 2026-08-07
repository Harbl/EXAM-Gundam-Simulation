// Real test of whether effect-card density can drive a GENERALIZABLE (not hardcoded-per-matchup)
// search-budget mechanism: derive each deck's MCTS playoutBudget from its own decklist density
// relative to the whole 196-deck pool's distribution (scratchpad/deck_decision_density_pool.js:
// mean=0.816, std=0.083), instead of hand-picking "Barbatos always gets 100." If this reproduces
// something close to the confirmed hardcoded effect (+9.4pt, z=3.44,
// scratchpad/barbatos_extra_search_check.js), that's real evidence the proxy generalizes as a
// mechanism, not just a two-data-point coincidence.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_MCTS_CONFIG } = require('../src/ai/mcts');
const banlist = require('../data/banlist.json');

const POOL_MEAN = 0.816, POOL_STD = 0.083;
const MIN_BUDGET = 25, MAX_BUDGET = 100;

function densityOf(parsed) {
  let total = 0, withEffect = 0;
  for (const entry of parsed.main) {
    const def = lookupCard(entry.number);
    total += entry.quantity;
    if (def.effectRefs && Object.keys(def.effectRefs).length > 0) withEffect += entry.quantity;
  }
  return withEffect / total;
}

function budgetFromDensity(d) {
  const z = (d - POOL_MEAN) / POOL_STD;
  const t = Math.max(0, Math.min(1, (z + 2) / 4)); // z in [-2,+2] -> [0,1], clamped outside
  return Math.round(MIN_BUDGET + (MAX_BUDGET - MIN_BUDGET) * t);
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
const barbatosBudget = budgetFromDensity(barbatos.density);
const nuGundamBudget = budgetFromDensity(nuGundam.density);
console.log(`Derived playoutBudget -- Barbatos: density=${barbatos.density.toFixed(3)} -> ${barbatosBudget}; Nu Gundam: density=${nuGundam.density.toFixed(3)} -> ${nuGundamBudget}\n`);

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
const derived = runCondition(`Density-derived budgets (Barbatos ${barbatosBudget}, Nu Gundam ${nuGundamBudget})`, barbatosConfig, nuGundamConfig, N);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
console.log(`Delta from density-derived budgets: ${(derived - baseline).toFixed(1)}pt`);

const p1 = baseline / 100, p2 = derived / 100;
const pooled = (p1 + p2) / 2;
const se = Math.sqrt(pooled * (1 - pooled) * (2 / N));
console.log(`Two-proportion z: ${((p2 - p1) / se).toFixed(2)} (>= 2.5 is this project's significance bar)`);
