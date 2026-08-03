// Phase 5 MSA deep-dive: does adjusting scoreState's weights close the Barbatos Rush / Shining&Master
// vs Nu Gundam gap, specifically? Same self-play-vs-champion methodology as weight_tune.js, but the
// "win" metric here is simulated win% against the two real losing matchups from benchmark_vs_msa.js,
// not generic mirror-match win rate -- since that's the actual thing we're trying to fix.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_WEIGHTS } = require('../src/ai/score');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const nuGundam = loadDeck('nu_gundam_real.txt');
const barbatos = loadDeck('barbatos_real.txt');
const shiningMaster = loadDeck('shining_master_real.txt');

const N = Number(process.argv[3] || 30);

function winRateFor(deckA, deckB, weights) {
  let winsA = 0;
  for (let i = 0; i < N; i++) {
    const aIsFirst = i % 2 === 0;
    const r = aIsFirst
      ? playGame(deckA, deckB, { weightsA: weights, weightsB: weights })
      : playGame(deckB, deckA, { weightsA: weights, weightsB: weights });
    const aWon = aIsFirst ? r.winner === 0 : r.winner === 1;
    if (aWon) winsA++;
  }
  return winsA / N;
}

const candidatesArg = process.argv[2];
const CANDIDATES = candidatesArg
  ? JSON.parse(candidatesArg)
  : {
      DEFAULT: DEFAULT_WEIGHTS,
      shieldsUp: { ...DEFAULT_WEIGHTS, shields: 20 },
      shieldsWayUp: { ...DEFAULT_WEIGHTS, shields: 35 },
      boardStatsDown: { ...DEFAULT_WEIGHTS, boardStats: 0.4 },
      shieldsUpBoardDown: { ...DEFAULT_WEIGHTS, shields: 20, boardStats: 0.4 }
    };

console.log(`${N} games per matchup per candidate (both decks use the SAME candidate weights -- both sides equally "smarter", isolating whether the weight change helps the archetype, not just outplays a dumber opponent)\n`);

for (const [name, weights] of Object.entries(CANDIDATES)) {
  const barbatosRate = winRateFor(barbatos, nuGundam, weights);
  const smRate = winRateFor(shiningMaster, nuGundam, weights);
  console.log(`${name} (${JSON.stringify(weights)}):`);
  console.log(`  Barbatos Rush vs Nu Gundam: ${(barbatosRate * 100).toFixed(1)}% (MSA real: 64%)`);
  console.log(`  Shining&Master vs Nu Gundam: ${(smRate * 100).toFixed(1)}% (MSA real: 52%)`);
}
