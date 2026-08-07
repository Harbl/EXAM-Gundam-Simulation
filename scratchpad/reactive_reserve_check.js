// Fast, cheap validation of the "reactiveReserve" hypothesis (see the project plan,
// moonlit-hugging-shannon.md, "Deploy-timing / board-flooding" section) BEFORE committing to a
// value-net retrain: does giving boardValue credit for holding active Resources open for a real
// [Action]-timing Command in hand actually help a deck that runs such cards? Uses the pure linear
// scoreState formula (aiWeights override, no valueModel / no training needed) and src/ai/sprt.js
// directly, same shape as scratchpad/damaged_synergy_barbatos_check.js -- a mirror self-play
// comparison (candidate = reactiveReserve:4, champion = reactiveReserve:0).
//
// Deck choice matters here: the effect only has anything to bite on if the deck actually runs
// [Action]-timing Commands. scratchpad/decklists/deck121.txt was the highest-density real deck in the
// full ~196-deck pool (4 copies of Graceful Demeanor GD04-117 -- Lv.4/cost 2, actionTiming: "action"),
// found via a one-off scan of every pool decklist for actionTiming action/both copies.
//
// RESULT (2026-08-07): REJECT, n=2543, 51.3%, llr=-2.95 -- no measurable win-rate improvement on this
// deck. Closed as a tested negative; see the project plan for the full writeup and code disposition
// (DEFAULT_WEIGHTS.reactiveReserve zeroed back to 0, reactiveReserveValue/the feature stay in place).
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

const deck = loadDeck('deck121.txt');

const candidateWeights = DEFAULT_WEIGHTS; // reactiveReserve: 4
const championWeights = { ...DEFAULT_WEIGHTS, reactiveReserve: 0 };

function sprtMirrorCheck(maxGames) {
  const bounds = sprtBounds(DEFAULT_SPRT);
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0, llr = 0, total = 0;
  for (; total < maxGames; total++) {
    const candidateIsA = total % 2 === 0;
    const r = playGame(deck, deck, {
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
        `deck121 mirror, SPRT: candidate ${winsCandidate}-${winsChampion} champion ` +
          `(${((winsCandidate / n) * 100).toFixed(1)}%, llr=${llr.toFixed(2)}, n=${n}, draws=${draws}, timeouts=${timeouts}) <-- ${verdict.toUpperCase()}`
      );
      return verdict;
    }
  }
  console.log(`deck121 mirror, SPRT: inconclusive after ${maxGames} games (candidate ${winsCandidate}-${winsChampion} champion)`);
  return 'inconclusive';
}

const t0 = Date.now();
const MAX_GAMES = Number(process.argv[2] || 4000); // safety cap, single matchup
const verdict = sprtMirrorCheck(MAX_GAMES);
console.log(
  verdict === 'accept'
    ? '\nAccepted -- reactiveReserve is a real improvement on this Action-timing-heavy deck. Proceed to wiring it into a valueNet retrain (plan step 4).'
    : `\nNot accepted (${verdict}) -- treat as tested-and-${verdict === 'reject' ? 'ruled-out' : 'inconclusive'}, same rigor as vulnerableUnitCount/the DeepSets architecture. Do not spend retrain time on this without a real signal here.`
);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
