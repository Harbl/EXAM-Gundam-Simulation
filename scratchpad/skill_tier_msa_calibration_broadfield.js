// Recalibrates the default skill tier against real MSA archetype-level win rates using the FULL
// ~196-deck real tournament pool as the opponent field (not just the 5 curated matchup decks from
// skill_tier_msa_calibration.js), and excludes Nu Gundam entirely -- both as a calibration target AND
// from the opponent pool -- since its search-quality overrating is already handled separately
// (src/ai/archetypeHandicaps.js) and would otherwise pollute every other archetype's deviation via
// matches against it. Jake's direction after the original 5-matchup sweep got shelved (Nu Gundam was
// dominating the MAD signal, no shared tier fixed both it and the normal archetypes): "exclude Nu, and
// don't just focus on those 4 other archetype decks. Sweep the full decklist."
//
// For each of the 4 remaining real-decklist-mapped archetypes, plays that archetype's real list against
// every other deck in the pool (minus itself and Nu Gundam), aggregates a single sim win rate (same
// "broad field" approach as nu_gundam_broad_field_check.js), and compares it to that archetype's real
// MSA archetype-level win rate (gundeckai_snapshot.json's "archetypes" array, NOT the narrower specific-
// matchup numbers the original calibration script used). MAD = mean absolute deviation across the 4
// archetypes, per tier -- lowest MAD is the best default-tier candidate. 'expert' stays excluded from
// the sweep (same reason as the original: ~80-90x cost of every other tier, not a realistic default).
//
// Usage: node skill_tier_msa_calibration_broadfield.js [gamesPerOpponent]
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
  'shining-and-master-gundam': 'shining_master_real.txt',
  'strike-freedom-and-maridas-banshee': 'strikefreedom_banshee_real.txt',
  'strike-freedom-and-barbatos-lupus': 'strikefreedom_barbatos_real.txt',
  'barbatos-rush-char-aznable': 'barbatos_real.txt'
};
const NU_GUNDAM_FILE = 'nu_gundam_real.txt';
const TIERS = process.argv[3] ? process.argv[3].split(',') : ['beginner', 'novice', 'casual', 'tight'];

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'gundeckai_snapshot.json'), 'utf8'));
const archetypeRealRate = Object.fromEntries(snapshot.archetypes.map((a) => [a.slug, a.winRate]));
const allDeckFiles = fs.readdirSync(path.join(__dirname, 'decklists'));
const GAMES_PER_OPPONENT = Number(process.argv[2] || 6);

function runTier(tierName) {
  const preset = SKILL_PRESETS[tierName];
  console.log(`--- ${tierName} (${preset.engine}${preset.mctsConfig ? `, playoutBudget=${preset.mctsConfig.playoutBudget}` : ''}) ---`);
  let sumAbsDeviation = 0;
  const rows = [];
  for (const [slug, file] of Object.entries(ARCHETYPE_DECKS)) {
    const deck = loadDeck(file);
    const opponentFiles = allDeckFiles.filter((n) => n !== file && n !== NU_GUNDAM_FILE);
    let wins = 0, total = 0;
    for (const oppFile of opponentFiles) {
      const opponent = loadDeck(oppFile);
      for (let i = 0; i < GAMES_PER_OPPONENT; i++) {
        const isFirst = i % 2 === 0;
        const r = playGame(isFirst ? deck : opponent, isFirst ? opponent : deck, {
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
    const simRate = total > 0 ? (wins / total) * 100 : NaN;
    const real = archetypeRealRate[slug];
    const deviation = simRate - real;
    sumAbsDeviation += Math.abs(deviation);
    rows.push({ slug, real, sim: simRate, deviation, total });
    console.log(`  ${slug}: real ${real}% / sim ${simRate.toFixed(1)}% (deviation ${deviation.toFixed(1)}pt, n=${total})`);
  }
  const mad = sumAbsDeviation / Object.keys(ARCHETYPE_DECKS).length;
  console.log(`  ${tierName} mean absolute deviation: ${mad.toFixed(1)}pt\n`);
  return { tier: tierName, mad, rows };
}

const opponentCount = allDeckFiles.length - 2;
console.log(`${Object.keys(ARCHETYPE_DECKS).length} archetypes vs full pool (${opponentCount} opponents each, Nu Gundam excluded from targets + pool), ${GAMES_PER_OPPONENT} games/opponent\n`);
const t0 = Date.now();
const results = [];
for (const tier of TIERS) results.push(runTier(tier));

results.sort((a, b) => a.mad - b.mad);
console.log('=== Summary (lowest MAD = best default candidate, Nu Gundam excluded) ===');
for (const r of results) console.log(`  ${r.tier}: MAD=${r.mad.toFixed(1)}pt`);
console.log(`\nRecommended default: ${results[0].tier}`);
console.log(`${((Date.now() - t0) / 1000 / 60).toFixed(1)} min total`);

fs.writeFileSync(path.join(__dirname, 'skill_tier_msa_calibration_broadfield_result.json'), JSON.stringify(results, null, 2));
