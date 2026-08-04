// One-off scratch tool: automated coordinate-descent tuning of every scoreState weight, built on top
// of weight_tune.js's rigorous self-play harness (same deck both sides, weights differ, z-score-gated
// significance) rather than a single manual round. Starts from the current champion (DEFAULT_WEIGHTS),
// and for each weight tries a +/-30% nudge; if either nudge beats the champion with |z| >= 2.5, the
// better one becomes the new champion. Repeats full passes over every weight until a pass adopts
// nothing (a local optimum) or MAX_PASSES is hit (safety valve against endless noise-chasing). Ends
// with one larger-sample confirmation of the final champion vs. the ORIGINAL DEFAULT_WEIGHTS, so the
// cumulative effect of however many small adoptions happened is itself verified significant before
// anyone edits src/ai/score.js off the back of this.
//
// Usage: node scratchpad/weight_coordinate_descent.js [gamesPerDeckPerPass] [maxPasses] [confirmGamesPerDeck]
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

function zScore(winRate, n) {
  const se = Math.sqrt(0.25 / n);
  return (winRate - 0.5) / se;
}

// Same 10-deck spread weight_tune.js used for the original shields/baseHP/boardStats/hand/resources/
// exResourceHeld tuning, so this round is directly comparable to that precedent rather than measured
// against a different sample.
const DECK_NAMES = [
  'deck1.txt', 'deck3.txt', 'deck8.txt', 'deck9.txt', 'deck14.txt',
  'deck17.txt', 'deck22.txt', 'deck24.txt', 'deck29.txt', 'deck34.txt'
];
const decks = DECK_NAMES.map((n) => ({ name: n, deck: loadDeck(n) }));

const GAMES_PER_DECK = Number(process.argv[2] || 60);
const MAX_PASSES = Number(process.argv[3] || 6);
const CONFIRM_GAMES_PER_DECK = Number(process.argv[4] || 400);
const SIGNIFICANCE_Z = 2.5;
const NUDGE_FACTORS = [0.7, 1.3];

function runVariant(champion, candidate, gamesPerDeck) {
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0;
  for (const { deck } of decks) {
    for (let i = 0; i < gamesPerDeck; i++) {
      const candidateIsA = i % 2 === 0;
      const r = playGame(deck, deck, {
        weightsA: candidateIsA ? candidate : champion,
        weightsB: candidateIsA ? champion : candidate
      });
      if (r.draw) draws++;
      else if (r.timedOut) timeouts++;
      else if ((r.winner === 0) === candidateIsA) winsCandidate++;
      else winsChampion++;
    }
  }
  const total = winsCandidate + winsChampion + draws + timeouts;
  const winRate = winsCandidate / total;
  return { winsCandidate, winsChampion, draws, timeouts, total, winRate, z: zScore(winRate, total) };
}

function fmt(weights) {
  return Object.entries(weights).map(([k, v]) => `${k}:${v}`).join(', ');
}

console.log(`Starting champion: ${fmt(DEFAULT_WEIGHTS)}`);
console.log(
  `${decks.length} decks x ${GAMES_PER_DECK} games/deck x 2 = ${decks.length * GAMES_PER_DECK} games per nudge, ` +
    `up to ${MAX_PASSES} passes, significance threshold |z| >= ${SIGNIFICANCE_Z}\n`
);

let champion = { ...DEFAULT_WEIGHTS };
const originalWeights = { ...DEFAULT_WEIGHTS };
const adoptionLog = [];
const startedAt = Date.now();

for (let pass = 1; pass <= MAX_PASSES; pass++) {
  console.log(`--- Pass ${pass} ---`);
  let adoptedThisPass = false;

  for (const key of Object.keys(champion)) {
    let best = null;
    for (const factor of NUDGE_FACTORS) {
      const candidate = { ...champion, [key]: Math.round(champion[key] * factor * 100) / 100 };
      if (candidate[key] === champion[key]) continue;
      const r = runVariant(champion, candidate, GAMES_PER_DECK);
      const sig = Math.abs(r.z) >= SIGNIFICANCE_Z;
      console.log(
        `  ${key} -> ${candidate[key]} (x${factor}): ${r.winsCandidate}-${r.winsChampion} ` +
          `(${(r.winRate * 100).toFixed(1)}%, z=${r.z.toFixed(2)}, draws=${r.draws}, timeouts=${r.timeouts})` +
          (sig && r.z > 0 ? ' <-- SIGNIFICANT WIN' : sig ? ' <-- significant loss' : '')
      );
      if (sig && r.z > 0 && (!best || r.z > best.z)) {
        best = { value: candidate[key], z: r.z, winRate: r.winRate };
      }
    }
    if (best) {
      console.log(`  ADOPTED: ${key} ${champion[key]} -> ${best.value} (z=${best.z.toFixed(2)})`);
      adoptionLog.push({ pass, key, from: champion[key], to: best.value, z: best.z, winRate: best.winRate });
      champion = { ...champion, [key]: best.value };
      adoptedThisPass = true;
    }
  }

  if (!adoptedThisPass) {
    console.log(`\nNo adoptions this pass -- local optimum reached after ${pass} pass(es).`);
    break;
  }
  if (pass === MAX_PASSES) {
    console.log(`\nHit MAX_PASSES (${MAX_PASSES}) with adoptions still happening -- stopping as a safety valve.`);
  }
}

console.log(`\nFinal champion: ${fmt(champion)}`);
console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(0)}s\n`);

console.log(
  `--- Confirmation run: final champion vs. original DEFAULT_WEIGHTS, ` +
    `${decks.length} decks x ${CONFIRM_GAMES_PER_DECK} games/deck x 2 = ${decks.length * CONFIRM_GAMES_PER_DECK * 2} games ---`
);
const confirmation =
  JSON.stringify(champion) === JSON.stringify(originalWeights)
    ? null
    : runVariant(originalWeights, champion, CONFIRM_GAMES_PER_DECK);
if (!confirmation) {
  console.log('Champion is identical to the original weights -- nothing to confirm.');
} else {
  const sig = Math.abs(confirmation.z) >= SIGNIFICANCE_Z;
  console.log(
    `Final champion ${confirmation.winsCandidate}-${confirmation.winsChampion} original ` +
      `(${(confirmation.winRate * 100).toFixed(1)}%, z=${confirmation.z.toFixed(2)}, ` +
      `draws=${confirmation.draws}, timeouts=${confirmation.timeouts})` +
      (sig && confirmation.z > 0 ? ' <-- SIGNIFICANT OVERALL WIN' : sig ? ' <-- SIGNIFICANT OVERALL LOSS (do not adopt!)' : ' <-- not significant')
  );
}

const result = { originalWeights, finalWeights: champion, adoptionLog, confirmation };
const outPath = path.join(__dirname, 'weight_coordinate_descent_result.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`\nFull result written to ${outPath}`);
