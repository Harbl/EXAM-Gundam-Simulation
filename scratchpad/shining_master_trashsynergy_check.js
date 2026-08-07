// Investigates why shining-and-master-gundam is ~17-18pt underrated vs real MSA data even at the
// heaviest reasonable search tier (skill_tier_msa_calibration_broadfield.js, confirmed n=1552).
// Hypothesis: this deck's real payoff cards are a "trash pile as a resource" archetype -- literally
// the same shape trashSynergy was built to capture for Nu Gundam/Tekkadan/Athrun Zala -- but none of
// them are flagged:
//   - Master Gundam GD05-033 [Attack]: exile 2 (Special Move) Commands from trash -> Breach 5
//   - Shining Gundam GD05-066 [Deploy]: exile 2 MF Units + a Special Move Command from trash -> bonus
//   - Master Asia GD05-089 [Burst]: becomes a stronger Unit if 3+ MF cards are in trash
// None carry a `trashSynergy` declarative flag today (grep of src/cards confirms only 4 cards total
// have it: 1 Tekkadan, 2 Londo Bell/Nu Gundam, 1 Athrun Zala/purple). Since trashSynergyValue is a real
// input feature of the SHIPPED trained net (valueFeatures.js line ~108), this should be testable
// without a retrain -- the net already has a learned weight for this feature, flagging these cards just
// gives it a nonzero signal to respond to on this archetype's states.
//
// Monkey-patches the loaded deck's card defs in-memory (no JSON file edits) so this is a cheap, fully
// reversible before/after comparison against the full real-deck pool (same broad-field shape as
// nu_gundam_broad_field_check.js), using the actual shipped tight-tier preset (real engine + valueModel).
//
// Usage: node shining_master_trashsynergy_check.js [gamesPerOpponent]
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { SKILL_PRESETS } = require('../src/ai/skillPresets');
const banlist = require('../data/banlist.json');

const TRASH_SYNERGY_OVERRIDES = {
  'GD05-033': { traits: ['Special Move'], threshold: 2 }, // Master Gundam
  'GD05-066': { traits: ['MF'], threshold: 2 }, // Shining Gundam
  'GD05-089': { traits: ['MF'], threshold: 3 } // Master Asia
};

function loadDeck(name, { withTrashSynergy } = {}) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  const deck = buildGameDeck({ main: parsed.main }, lookupCard);
  if (withTrashSynergy) {
    deck.main = deck.main.map((card) => {
      const override = TRASH_SYNERGY_OVERRIDES[card.number];
      return override ? { ...card, trashSynergy: override } : card;
    });
  }
  return deck;
}

const TARGET_FILE = 'shining_master_real.txt';
const NU_GUNDAM_FILE = 'nu_gundam_real.txt';
const opponentNames = fs
  .readdirSync(path.join(__dirname, 'decklists'))
  .filter((n) => n !== TARGET_FILE && n !== NU_GUNDAM_FILE);

const GAMES_PER_OPPONENT = Number(process.argv[2] || 3);
const preset = SKILL_PRESETS.tight;
console.log(`shining-and-master-gundam vs ${opponentNames.length} pool opponents, ${GAMES_PER_OPPONENT} games/opponent each condition, tight tier (real shipped net)\n`);

function runCondition(withTrashSynergy) {
  const target = loadDeck(TARGET_FILE, { withTrashSynergy });
  let wins = 0, total = 0;
  for (const oppFile of opponentNames) {
    const opponent = loadDeck(oppFile);
    for (let i = 0; i < GAMES_PER_OPPONENT; i++) {
      const isFirst = i % 2 === 0;
      const r = playGame(isFirst ? target : opponent, isFirst ? opponent : target, {
        engineA: preset.engine,
        engineB: preset.engine,
        mctsConfigA: preset.mctsConfig,
        mctsConfigB: preset.mctsConfig,
        valueModelA: preset.valueModel,
        valueModelB: preset.valueModel
      });
      if (r.draw || r.timedOut) continue;
      total++;
      if ((r.winner === 0) === isFirst) wins++;
    }
  }
  return { wins, total, rate: (wins / total) * 100 };
}

const t0 = Date.now();
const baseline = runCondition(false);
console.log(`baseline (no trashSynergy flags): ${baseline.wins}/${baseline.total} (${baseline.rate.toFixed(1)}%)`);
const withFlags = runCondition(true);
console.log(`with trashSynergy flags:          ${withFlags.wins}/${withFlags.total} (${withFlags.rate.toFixed(1)}%)`);

const delta = withFlags.rate - baseline.rate;
const pooled = (baseline.wins + withFlags.wins) / (baseline.total + withFlags.total);
const se = Math.sqrt(pooled * (1 - pooled) * (2 / baseline.total)) * 100;
console.log(`\ndelta: ${delta.toFixed(1)}pt, z: ${(delta / se).toFixed(2)} (real MSA target: 49%)`);
console.log(`${((Date.now() - t0) / 1000 / 60).toFixed(1)} min total`);
