// Better-motivated archetype-signal candidate than avg cost/level (which pointed the wrong way): how
// much of a deck's plan depends on ability-driven DECISIONS (targeting choices, activation timing)
// vs. plain vanilla stats? Theory: more decision points per turn -> more for search depth to actually
// get right -> more benefit from extra search budget, which is what we just confirmed is true for
// Barbatos specifically (+9.4pt from more search). Proxy: fraction of the 50-card deck whose card def
// has an effectRefs entry at all (any wired ability) -- cheap, purely decklist-derived, no game state.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { lookupCard } = require('../src/cards/index');

function stats(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  let total = 0, withEffect = 0;
  const perCardEffectCount = {};
  for (const entry of parsed.main) {
    const def = lookupCard(entry.number);
    total += entry.quantity;
    if (def.effectRefs && Object.keys(def.effectRefs).length > 0) {
      withEffect += entry.quantity;
      perCardEffectCount[entry.number] = Object.keys(def.effectRefs).length;
    }
  }
  const fraction = withEffect / total;
  const avgEffectHooksPerCardWithEffect =
    Object.values(perCardEffectCount).reduce((s, n) => s + n, 0) / (Object.keys(perCardEffectCount).length || 1);
  console.log(`${name}: ${withEffect}/${total} cards have a wired effect (${(fraction * 100).toFixed(1)}%), avg ${avgEffectHooksPerCardWithEffect.toFixed(2)} hook(s)/card among those`);
  return { fraction, total, withEffect };
}

const barbatos = stats('barbatos_real.txt');
const nuGundam = stats('nu_gundam_real.txt');
console.log(`\nDelta (Barbatos - Nu Gundam) effect-card fraction: ${((barbatos.fraction - nuGundam.fraction) * 100).toFixed(1)}pt`);
console.log('(Theory predicts Barbatos should be HIGHER here, matching its confirmed extra benefit from search)');
