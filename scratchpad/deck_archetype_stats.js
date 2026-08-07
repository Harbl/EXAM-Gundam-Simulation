// Quick check of the actual "deck-construction-aware feature" premise: do Barbatos Rush and Nu Gundam
// actually differ by a real margin on simple, purely decklist-derived stats (no game-state needed at
// all -- computed straight from the 50-card list), before building any mechanism around it?
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { lookupCard } = require('../src/cards/index');

function stats(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const units = [];
  for (const entry of parsed.main) {
    const def = lookupCard(entry.number);
    if (def.type === 'unit') for (let i = 0; i < entry.quantity; i++) units.push(def);
  }
  const avgCost = units.reduce((s, u) => s + (u.cost || 0), 0) / units.length;
  const avgLevel = units.reduce((s, u) => s + (u.level || 0), 0) / units.length;
  const avgAP = units.reduce((s, u) => s + (u.ap || 0), 0) / units.length;
  const avgHP = units.reduce((s, u) => s + (u.hp || 0), 0) / units.length;
  console.log(`${name}: ${units.length} Units, avgCost=${avgCost.toFixed(2)} avgLevel=${avgLevel.toFixed(2)} avgAP=${avgAP.toFixed(2)} avgHP=${avgHP.toFixed(2)}`);
  return { avgCost, avgLevel, avgAP, avgHP };
}

const barbatos = stats('barbatos_real.txt');
const nuGundam = stats('nu_gundam_real.txt');
console.log(`\nDelta (Nu Gundam - Barbatos): avgCost=${(nuGundam.avgCost - barbatos.avgCost).toFixed(2)} avgLevel=${(nuGundam.avgLevel - barbatos.avgLevel).toFixed(2)}`);
