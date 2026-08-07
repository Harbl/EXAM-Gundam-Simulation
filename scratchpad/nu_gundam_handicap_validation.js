// Final validation of src/ai/archetypeHandicaps.js: does the real shipped pathway (SKILL_PRESETS'
// trained valueModel + applyArchetypeHandicap) actually close Nu Gundam's overrating, not just the
// bare-linear-formula diagnostic scripts from earlier? Nu Gundam (handicapped) vs a sample of the real
// deck pool, 'casual' tier, compared to the same sample WITHOUT the handicap applied.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { SKILL_PRESETS } = require('../src/ai/skillPresets');
const { applyArchetypeHandicap } = require('../src/ai/archetypeHandicaps');
const banlist = require('../data/banlist.json');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const NU_GUNDAM_FILE = 'nu_gundam_real.txt';
const nuGundam = loadDeck(NU_GUNDAM_FILE);
const allOpponents = fs.readdirSync(path.join(__dirname, 'decklists')).filter((n) => n !== NU_GUNDAM_FILE);
// Deterministic sample (every 3rd deck) rather than all 195, to keep this validation run quick.
const opponentNames = allOpponents.filter((_, i) => i % 3 === 0);

const GAMES_PER_OPPONENT = Number(process.argv[2] || 4);
const preset = SKILL_PRESETS.casual;

function run(useHandicap) {
  let nuWins = 0, total = 0;
  for (const name of opponentNames) {
    const opponent = loadDeck(name);
    const nuConfig = useHandicap
      ? applyArchetypeHandicap(nuGundam, { engine: preset.engine, mctsConfig: preset.mctsConfig, valueModel: preset.valueModel })
      : { engine: preset.engine, mctsConfig: preset.mctsConfig, valueModel: preset.valueModel };
    for (let i = 0; i < GAMES_PER_OPPONENT; i++) {
      const nuIsA = i % 2 === 0;
      const r = playGame(nuIsA ? nuGundam : opponent, nuIsA ? opponent : nuGundam, {
        engineA: nuIsA ? nuConfig.engine : preset.engine,
        engineB: nuIsA ? preset.engine : nuConfig.engine,
        mctsConfigA: nuIsA ? nuConfig.mctsConfig : preset.mctsConfig,
        mctsConfigB: nuIsA ? preset.mctsConfig : nuConfig.mctsConfig,
        valueModelA: preset.valueModel,
        valueModelB: preset.valueModel
      });
      if (r.draw || r.timedOut) continue;
      total++;
      if ((r.winner === 0) === nuIsA) nuWins++;
    }
  }
  return { nuWins, total, rate: (nuWins / total) * 100 };
}

console.log(`Nu Gundam vs ${opponentNames.length} sampled real decks, ${GAMES_PER_OPPONENT} games/opponent, 'casual' tier (real trained valueModel)\n`);
const t0 = Date.now();
const without = run(false);
console.log(`Without handicap: ${without.nuWins}/${without.total} (${without.rate.toFixed(1)}%)`);
const withH = run(true);
console.log(`With handicap:    ${withH.nuWins}/${withH.total} (${withH.rate.toFixed(1)}%)`);
console.log(`\nReal archetype-level MSA win rate: 56%`);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s total`);
