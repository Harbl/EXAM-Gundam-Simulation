// Broader test of the "Nu Gundam is systematically overrated in sim" pattern found via
// benchmark_vs_msa.js (4/4 curated real matchups all showed Nu Gundam over-performing, 18.7-45pt).
// Rather than restrict to the handful of archetypes with a confident MSA-slug mapping, use the FULL
// ~196-deck real tournament-decklist pool as a broad opponent field (Jake's direction: "we have a
// database of almost 200 decks... you can use all of those for more data"). Compares Nu Gundam's
// aggregate sim win rate across the whole field against its real ARCHETYPE-level win rate from
// gundeckai_snapshot.json's "archetypes" array (56%, n=17200 real games) -- independent of any single
// matchup's decklist mapping, so this is a genuinely different, broader piece of evidence.
//
// NOTE: playGame() with no valueModelA/B option (as here, and every other scratch script in this
// investigation) evaluates via the plain linear scoreState formula/DEFAULT_WEIGHTS, NOT the trained
// value net skillPresets.js actually ships to real users -- this whole benchmark thread has been
// testing score.js's hand-weighted formula specifically, which is exactly what's needed to test the
// trashSynergy/activationPotential-over-crediting hypothesis (both are formula weights), but it means
// a finding here isn't automatically proven to reproduce against the shipped net without a separate check.
//
// Usage: node nu_gundam_broad_field_check.js [gamesPerOpponent] [weightsOverrideJSON] [nuGundamEngine]
//   weightsOverrideJSON, if given, is merged onto DEFAULT_WEIGHTS and applied ONLY to Nu Gundam's side
//   -- e.g. '{"trashSynergy":0}' to test whether zeroing that one weight closes the overrating gap.
//   nuGundamEngine ('mcts', default, or 'lookahead') swaps Nu Gundam ONLY to the older, weaker
//   fixed-pipeline AI (src/ai/heuristic.js's runMainPhase) -- opponents stay on full MCTS -- to test
//   whether search quality itself (not scoreState's weights) explains the overrating.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_WEIGHTS } = require('../src/ai/score');
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
const opponentNames = fs.readdirSync(path.join(__dirname, 'decklists')).filter((n) => n !== NU_GUNDAM_FILE);

const GAMES_PER_OPPONENT = Number(process.argv[2] || 6);
const nuGundamWeights = process.argv[3] ? { ...DEFAULT_WEIGHTS, ...JSON.parse(process.argv[3]) } : DEFAULT_WEIGHTS;
const nuGundamEngine = process.argv[4] || 'mcts';
console.log(`Nu Gundam vs all ${opponentNames.length} other decks in the pool, ${GAMES_PER_OPPONENT} games/opponent (${opponentNames.length * GAMES_PER_OPPONENT} games total)`);
console.log(`Nu Gundam weights: ${JSON.stringify(nuGundamWeights)}, Nu Gundam engine: ${nuGundamEngine} (opponents always 'mcts')\n`);

const t0 = Date.now();
let nuWins = 0, total = 0, draws = 0, timeouts = 0;
const perOpponent = [];

for (const name of opponentNames) {
  const opponent = loadDeck(name);
  let wins = 0, n = 0;
  for (let i = 0; i < GAMES_PER_OPPONENT; i++) {
    const nuIsA = i % 2 === 0;
    const r = playGame(nuIsA ? nuGundam : opponent, nuIsA ? opponent : nuGundam, {
      weightsA: nuIsA ? nuGundamWeights : undefined,
      weightsB: nuIsA ? undefined : nuGundamWeights,
      engineA: nuIsA ? nuGundamEngine : 'mcts',
      engineB: nuIsA ? 'mcts' : nuGundamEngine
    });
    if (r.draw) { draws++; continue; }
    if (r.timedOut) { timeouts++; continue; }
    total++; n++;
    if ((r.winner === 0) === nuIsA) { nuWins++; wins++; }
  }
  perOpponent.push({ name, wins, n, rate: n > 0 ? wins / n : NaN });
}

const overallRate = nuWins / total;
console.log(`Nu Gundam aggregate: ${nuWins}/${total} (${(overallRate * 100).toFixed(1)}%), draws=${draws} timeouts=${timeouts}`);
console.log(`Real archetype-level MSA win rate: 56% (n=17200 real games)`);
const se = Math.sqrt(0.25 / total);
console.log(`Delta: ${(overallRate * 100 - 56).toFixed(1)}pt, z vs 56%: ${((overallRate - 0.56) / se).toFixed(2)}`);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s total`);

perOpponent.sort((a, b) => b.rate - a.rate);
console.log(`\nWorst 10 matchups for Nu Gundam (lowest win rate):`);
for (const o of perOpponent.slice(-10).reverse()) console.log(`  ${o.name}: ${o.wins}/${o.n} (${(o.rate * 100).toFixed(0)}%)`);
console.log(`\nBest 10 matchups for Nu Gundam (highest win rate):`);
for (const o of perOpponent.slice(0, 10)) console.log(`  ${o.name}: ${o.wins}/${o.n} (${(o.rate * 100).toFixed(0)}%)`);

fs.writeFileSync(path.join(__dirname, 'nu_gundam_broad_field_result.json'), JSON.stringify({ overallRate, nuWins, total, draws, timeouts, perOpponent }, null, 2));
