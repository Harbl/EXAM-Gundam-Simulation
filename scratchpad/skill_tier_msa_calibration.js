// Recalibrates the batch-simulation default skill tier (src/ai/skillPresets.js's SKILL_PRESETS,
// batchWorker.js's resolveSkill() falls back to 'casual' today) against real MSA ladder data, instead
// of assuming full/default-strength MCTS is the most "realistic" choice. Unlike benchmark_vs_msa.js
// (which used the bare linear scoreState formula, no valueModel), this runs each tier's ACTUAL shipped
// config -- engine + mctsConfig + valueModel -- since that's what a user picking a skill tier actually
// gets. For each tier, both sides play at that tier (symmetric), across the same 5 real matchups
// benchmark_vs_msa.js already has confident decklist mappings for. Reports mean absolute deviation
// (MAD) from real MSA win rates per tier -- the tier with the lowest MAD is the best default candidate.
//
// 'expert' (STRONG_MCTS_CONFIG, 'good' rollout) is EXCLUDED from the main sweep -- measured elsewhere
// (mcts.js's own comments) at ~80-90x the cost of every other tier (~14.3s/game vs ~180ms/game), and
// it's explicitly documented as "much slower per game," not a realistic batch-default candidate anyway.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { SKILL_PRESETS } = require('../src/ai/skillPresets');
const banlist = require('../data/banlist.json');

const ARCHETYPE_DECKS = {
  'nu-gundam': 'nu_gundam_real.txt',
  'shining-and-master-gundam': 'shining_master_real.txt',
  'strike-freedom-and-maridas-banshee': 'strikefreedom_banshee_real.txt',
  'strike-freedom-and-barbatos-lupus': 'strikefreedom_barbatos_real.txt',
  'barbatos-rush-char-aznable': 'barbatos_real.txt'
};

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'gundeckai_snapshot.json'), 'utf8'));
const matchups = snapshot.matchups
  .map((m) => ({ ...m, deckAFile: ARCHETYPE_DECKS[m.deckA.slug], deckBFile: ARCHETYPE_DECKS[m.deckB.slug] }))
  .filter((m) => m.deckAFile && m.deckBFile);

const TIER_GAMES = { beginner: 100, novice: 100, casual: 100, tight: 60 };

function runTier(tierName, gamesPerMatchup) {
  const preset = SKILL_PRESETS[tierName];
  console.log(`--- ${tierName} (${preset.engine}${preset.mctsConfig ? `, playoutBudget=${preset.mctsConfig.playoutBudget}` : ''}) ---`);
  let sumAbsDeviation = 0;
  const rows = [];
  for (const m of matchups) {
    const deckA = loadDeck(m.deckAFile);
    const deckB = loadDeck(m.deckBFile);
    let winsA = 0, total = 0;
    for (let i = 0; i < gamesPerMatchup; i++) {
      const aIsFirst = i % 2 === 0;
      const r = playGame(aIsFirst ? deckA : deckB, aIsFirst ? deckB : deckA, {
        engineA: preset.engine,
        engineB: preset.engine,
        mctsConfigA: preset.mctsConfig,
        mctsConfigB: preset.mctsConfig,
        valueModelA: preset.valueModel,
        valueModelB: preset.valueModel
      });
      if (r.draw || r.timedOut) continue;
      total++;
      if ((r.winner === 0) === aIsFirst) winsA++;
    }
    const simRateA = total > 0 ? (winsA / total) * 100 : NaN;
    const deviation = simRateA - m.deckA.winRate;
    sumAbsDeviation += Math.abs(deviation);
    rows.push({ label: `${m.deckA.name} vs ${m.deckB.name}`, real: m.deckA.winRate, sim: simRateA, deviation });
    console.log(`  ${m.deckA.name} vs ${m.deckB.name}: real ${m.deckA.winRate}% / sim ${simRateA.toFixed(1)}% (deviation ${deviation.toFixed(1)}pt)`);
  }
  const mad = sumAbsDeviation / matchups.length;
  console.log(`  ${tierName} mean absolute deviation: ${mad.toFixed(1)}pt\n`);
  return { tier: tierName, mad, rows };
}

console.log(`${matchups.length} real matchups with confident decklist mappings\n`);
const t0 = Date.now();
const results = [];
for (const [tier, games] of Object.entries(TIER_GAMES)) {
  results.push(runTier(tier, games));
}

results.sort((a, b) => a.mad - b.mad);
console.log('=== Summary (lowest MAD = best default candidate) ===');
for (const r of results) console.log(`  ${r.tier}: MAD=${r.mad.toFixed(1)}pt`);
console.log(`\nRecommended default: ${results[0].tier}`);
console.log(`${((Date.now() - t0) / 1000 / 60).toFixed(1)} min total`);

fs.writeFileSync(path.join(__dirname, 'skill_tier_msa_calibration_result.json'), JSON.stringify(results, null, 2));
