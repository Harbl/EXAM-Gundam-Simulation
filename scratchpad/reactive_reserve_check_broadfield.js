// Re-validation of reactive_reserve_check.js's single-deck reject, per Jake's standing methodology
// correction (2026-08-07, see feedback_gundam_ai_validate_full_deck_pool.md memory): "run the whole
// deck database and not just the 5 archetypes or the single deck I gave you last night. These new
// levers won't show results in every deck, but it's an important consideration for the AI to have."
//
// The original check only tested deck121.txt (the single highest-[Action]-density real deck) in
// isolation -- most decks in the pool run zero [Action]-timing Commands, so reactiveReserveValue is
// provably 0 for them and the lever can only ever matter in aggregate across the format's real deck
// diversity, never in a deck picked specifically to maximize it. Same broad-field methodology as
// scratchpad/nu_gundam_broad_field_check.js, generalized: every trial draws a FRESH random deck from
// the whole real pool (scratchpad/decklists/*.txt, all of them, not just deck*.txt) for a mirror match,
// instead of fixing one deck for the whole run.
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

const DECKLIST_DIR = path.join(__dirname, 'decklists');
const deckPool = [];
for (const name of fs.readdirSync(DECKLIST_DIR)) {
  const text = fs.readFileSync(path.join(DECKLIST_DIR, name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) continue; // a handful of scratch decklists in this dir are known-invalid/legacy; skip rather than crash
  deckPool.push({ name, def: buildGameDeck({ main: parsed.main }, lookupCard) });
}
console.log(`Loaded ${deckPool.length} valid decks from the real pool for broad-field mirror sampling.\n`);

// The shipped DEFAULT_WEIGHTS.reactiveReserve is currently 0 (zeroed after the single-deck reject) --
// re-test the ORIGINAL candidate value (4) here, not the current (now-zeroed) default, since the whole
// point of this re-run is to check whether the broader sample changes that verdict. Both built as
// fresh copies (never mutating the shared DEFAULT_WEIGHTS singleton itself).
const candidateWeights = { ...DEFAULT_WEIGHTS, reactiveReserve: 4 };
const championWeights = { ...DEFAULT_WEIGHTS, reactiveReserve: 0 };

function sprtMirrorCheck(maxGames) {
  const bounds = sprtBounds(DEFAULT_SPRT);
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0, llr = 0, total = 0;
  for (; total < maxGames; total++) {
    const deck = deckPool[Math.floor(Math.random() * deckPool.length)];
    const candidateIsA = total % 2 === 0;
    const r = playGame(deck.def, deck.def, {
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
        `Broad-field mirror (${deckPool.length} decks sampled), SPRT: candidate ${winsCandidate}-${winsChampion} champion ` +
          `(${((winsCandidate / n) * 100).toFixed(1)}%, llr=${llr.toFixed(2)}, n=${n}, draws=${draws}, timeouts=${timeouts}) <-- ${verdict.toUpperCase()}`
      );
      return verdict;
    }
  }
  console.log(`Broad-field mirror, SPRT: inconclusive after ${maxGames} games (candidate ${winsCandidate}-${winsChampion} champion)`);
  return 'inconclusive';
}

const t0 = Date.now();
const MAX_GAMES = Number(process.argv[2] || 6000); // higher safety cap than the single-deck run -- cross-deck variance likely needs more games to resolve
const verdict = sprtMirrorCheck(MAX_GAMES);
console.log(
  verdict === 'accept'
    ? '\nAccepted across the broad field -- the single-deck reject was a false negative from too narrow a sample. Proceed to wiring it into a valueNet retrain (plan step 4).'
    : `\nNot accepted (${verdict}) -- consistent with the original single-deck reject. Treat as confirmed tested-and-${verdict === 'reject' ? 'ruled-out' : 'inconclusive'} now with real pool-wide evidence behind it, not just one deck.`
);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s total`);
