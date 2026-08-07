// Effect-card density (scratchpad/deck_decision_density_stats.js) correctly predicted Barbatos needs
// more search than Nu Gundam, unlike avg cost/level which pointed backward. Before turning it into a
// real per-deck search-budget formula, get the real distribution across the whole 196-deck pool (cheap
// -- pure decklist parsing, no simulation) so a mapping from density -> playoutBudget is calibrated
// against the actual format, not just eyeballed off two decks.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { lookupCard } = require('../src/cards/index');

function density(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  let total = 0, withEffect = 0;
  for (const entry of parsed.main) {
    const def = lookupCard(entry.number);
    total += entry.quantity;
    if (def.effectRefs && Object.keys(def.effectRefs).length > 0) withEffect += entry.quantity;
  }
  return withEffect / total;
}

const names = fs.readdirSync(path.join(__dirname, 'decklists'));
const densities = names.map((n) => ({ name: n, density: density(n) }));
const values = densities.map((d) => d.density);
const mean = values.reduce((s, v) => s + v, 0) / values.length;
const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
const std = Math.sqrt(variance);
const sorted = [...values].sort((a, b) => a - b);
const min = sorted[0], max = sorted[sorted.length - 1];
const median = sorted[Math.floor(sorted.length / 2)];

console.log(`${names.length} decks: mean=${mean.toFixed(3)} std=${std.toFixed(3)} min=${min.toFixed(3)} median=${median.toFixed(3)} max=${max.toFixed(3)}`);

const barbatos = densities.find((d) => d.name === 'barbatos_real.txt');
const nuGundam = densities.find((d) => d.name === 'nu_gundam_real.txt');
console.log(`\nbarbatos_real.txt: density=${barbatos.density.toFixed(3)} (${((barbatos.density - mean) / std).toFixed(2)} std from mean)`);
console.log(`nu_gundam_real.txt: density=${nuGundam.density.toFixed(3)} (${((nuGundam.density - mean) / std).toFixed(2)} std from mean)`);

fs.writeFileSync(path.join(__dirname, 'deck_decision_density_pool.json'), JSON.stringify(densities, null, 2));
console.log(`\nFull per-deck density written to scratchpad/deck_decision_density_pool.json`);
