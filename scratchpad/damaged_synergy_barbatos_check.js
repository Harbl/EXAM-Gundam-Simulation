// Fast, cheap validation of the "damagedSynergy" hypothesis (see the project plan,
// moonlit-hugging-shannon.md) BEFORE committing to a value-net retrain: does giving boardValue credit
// for benefitsFromSelfDamage units (Gundam Barbatos 1st/4th Form, Barbatos Lupus Rex) actually help
// Barbatos Rush play better? Uses the pure linear scoreState formula (aiWeights override, no valueModel
// / no training needed) and src/ai/sprt.js directly, same shape as bin/train_value_net.js's sprtVerify
// -- a real Barbatos-mirror self-play comparison (candidate = damagedSynergy:3, champion:0), matching
// the same methodology every other DEFAULT_WEIGHTS entry in score.js was originally validated with
// (self-play coordinate descent, see score.js's own header comment).
//
// Step 2 (only runs if step 1's SPRT resolves 'accept'): a quick, non-SPRT directional check of the
// actual Barbatos-vs-Nu-Gundam win rate under both weight conditions -- same shape as
// scratchpad/barbatos_ai_asymmetry.js -- to see whether the fix is actually moving the needle on the
// specific documented sim/real gap, not just "helps Barbatos in general."
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_WEIGHTS } = require('../src/ai/score');
const { DEFAULT_SPRT, sprtBounds, llrIncrement, sprtVerdict } = require('../src/ai/sprt');
const banlist = require('../data/banlist.json');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const barbatos = loadDeck('barbatos_real.txt');
const nuGundam = loadDeck('nu_gundam_real.txt');

const candidateWeights = DEFAULT_WEIGHTS; // damagedSynergy: 3
const championWeights = { ...DEFAULT_WEIGHTS, damagedSynergy: 0 };

// --- Step 1: SPRT-gated Barbatos-mirror self-play (candidate weights vs champion weights) ---
function sprtMirrorCheck(maxGames) {
  const bounds = sprtBounds(DEFAULT_SPRT);
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0, llr = 0, total = 0;
  for (; total < maxGames; total++) {
    const candidateIsA = total % 2 === 0;
    const r = playGame(barbatos, barbatos, {
      weightsA: candidateIsA ? candidateWeights : championWeights,
      weightsB: candidateIsA ? championWeights : candidateWeights
    });
    let candidateWon = false;
    if (r.draw) draws++;
    else if (r.timedOut) timeouts++;
    else if ((r.winner === 0) === candidateIsA) {
      winsCandidate++;
      candidateWon = true;
    } else winsChampion++;

    llr += llrIncrement(candidateWon, DEFAULT_SPRT);
    const verdict = sprtVerdict(llr, bounds);
    if (verdict) {
      const n = total + 1;
      console.log(
        `Step 1 (Barbatos mirror, SPRT): candidate ${winsCandidate}-${winsChampion} champion ` +
          `(${((winsCandidate / n) * 100).toFixed(1)}%, llr=${llr.toFixed(2)}, n=${n}, draws=${draws}, timeouts=${timeouts}) <-- ${verdict.toUpperCase()}`
      );
      return verdict;
    }
  }
  console.log(`Step 1 (Barbatos mirror, SPRT): inconclusive after ${maxGames} games (candidate ${winsCandidate}-${winsChampion} champion)`);
  return 'inconclusive';
}

// --- Step 2: directional Barbatos-vs-Nu-Gundam win rate under each weight condition (not SPRT-gated
// -- an informational spot check, same shape as barbatos_ai_asymmetry.js) ---
function vsNuGundamWinRate(barbatosWeights, n) {
  let barbatosWins = 0, total = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < n; i++) {
    const barbatosIsA = i % 2 === 0;
    const r = playGame(barbatosIsA ? barbatos : nuGundam, barbatosIsA ? nuGundam : barbatos, {
      weightsA: barbatosIsA ? barbatosWeights : DEFAULT_WEIGHTS,
      weightsB: barbatosIsA ? DEFAULT_WEIGHTS : barbatosWeights
    });
    if (r.draw) { draws++; continue; }
    if (r.timedOut) { timeouts++; continue; }
    total++;
    if ((r.winner === 0) === barbatosIsA) barbatosWins++;
  }
  return { barbatosWins, total, draws, timeouts, rate: total > 0 ? (barbatosWins / total) * 100 : NaN };
}

const t0 = Date.now();
const MAX_GAMES = Number(process.argv[2] || 200); // safety cap, games (not games/deck -- single matchup)
const verdict = sprtMirrorCheck(MAX_GAMES);

if (verdict === 'accept') {
  console.log('\nStep 1 accepted -- running step 2 (Barbatos vs. Nu Gundam directional check)...');
  const N = Number(process.argv[3] || 60);
  const withFlag = vsNuGundamWinRate(candidateWeights, N);
  const withoutFlag = vsNuGundamWinRate(championWeights, N);
  console.log(
    `Barbatos (damagedSynergy:3) vs Nu Gundam: ${withFlag.barbatosWins}/${withFlag.total} (${withFlag.rate.toFixed(1)}%) ` +
      `draws=${withFlag.draws} timeouts=${withFlag.timeouts}`
  );
  console.log(
    `Barbatos (damagedSynergy:0) vs Nu Gundam: ${withoutFlag.barbatosWins}/${withoutFlag.total} (${withoutFlag.rate.toFixed(1)}%) ` +
      `draws=${withoutFlag.draws} timeouts=${withoutFlag.timeouts}`
  );
  console.log(`Delta: ${(withFlag.rate - withoutFlag.rate).toFixed(1)}pt (real ladder target: ~64%, sim baseline before this fix: ~20-27%)`);
} else {
  console.log(`\nStep 1 did not accept (${verdict}) -- stopping here, not running step 2. Treat as a tested, ${verdict === 'reject' ? 'ruled-out' : 'inconclusive'} hypothesis.`);
}

console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
