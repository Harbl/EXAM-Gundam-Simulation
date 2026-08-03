// Phase 5 step 5: compare our simulated matchup win rates against real ranked-play data (gundeck.ai's
// MSA-derived Command Ctr snapshot, parsed by parse_gundeckai_snapshot.js -- run that first). For each
// top real-world matchup we can confidently map to an actual decklist in our pool (by the archetype's
// defining card(s) appearing in the list -- see ARCHETYPE_DECKS below), runs N self-play games with
// MCTS driving both sides and reports our win% next to MSA's real win%/game-count.
//
// Success criterion is directional agreement, not exact match: a named archetype covers many slightly
// different real builds, and MSA's numbers reflect real (imperfect) human piloting + meta adaptation,
// not a ground-truth-optimal baseline. A large deviation (>10-15 points) is worth investigating -- either
// a missing card interaction/rules gap, or a genuine AI weakness in that matchup shape -- not proof the
// engine is wrong.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const banlist = require('../data/banlist.json');

// archetype slug (from gundeckai_snapshot.json) -> a representative decklist file. All 5 below are
// real competitive lists Jake provided directly (card numbers, cross-referenced against real
// tcgtopdecks-hq.com archetype names -- "Barbatos" = Barbatos Rush, "NeonZeon StrikeFreedom" =
// StrikeFreedom+Banshee, "GundamFighter" = Shining&Master), not auto-matched guesses -- the first pass
// of this benchmark used "first pool deck containing the signature card" for all 6, which turned out to
// pick unfocused splash decks for 5 of them (confirmed by swapping in the real Nu Gundam list alone,
// which made every deviation *worse*, ruling out Nu Gundam's own list as the problem). One card
// (GD01-118, "Overflowing Affection") in Jake's first StrikeFreedom+Banshee paste turned out to be a
// typo on tcgtopdecks-hq.com's part (pushed the deck to 3 colors, an illegal deck) -- Jake supplied a
// corrected real list instead. "Strike Freedom & League Militaire" from the original top-10 table has
// no equivalent in Jake's real-archetype list (StrikeFreedom splits only into Barbatos/Banshee variants
// per tcgtopdecks-hq.com's naming) so it's dropped rather than guessed at again.
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

function zScoreDelta(simRate, realRate, n) {
  // How many standard errors apart our simulated rate is from MSA's real rate, treating n as our own
  // sample size (MSA's own sample is thousands of games, effectively noise-free by comparison).
  const se = Math.sqrt((simRate * (1 - simRate)) / n);
  return se === 0 ? 0 : (simRate - realRate) / se;
}

const snapshotPath = process.argv[2] || 'scratchpad/gundeckai_snapshot.json';
const GAMES_PER_MATCHUP = Number(process.argv[3] || 60);
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

console.log(`${GAMES_PER_MATCHUP} games per matchup, MCTS (DEFAULT_MCTS_CONFIG) both sides\n`);

const t0 = Date.now();
let skipped = 0;
for (const m of snapshot.matchups) {
  const deckAFile = ARCHETYPE_DECKS[m.deckA.slug];
  const deckBFile = ARCHETYPE_DECKS[m.deckB.slug];
  if (!deckAFile || !deckBFile) {
    skipped++;
    continue;
  }
  const deckA = loadDeck(deckAFile);
  const deckB = loadDeck(deckBFile);

  let winsA = 0, winsB = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < GAMES_PER_MATCHUP; i++) {
    const aIsFirst = i % 2 === 0;
    const r = aIsFirst ? playGame(deckA, deckB) : playGame(deckB, deckA);
    if (r.draw) draws++;
    else if (r.timedOut) timeouts++;
    else if ((r.winner === 0) === aIsFirst) winsA++;
    else winsB++;
  }
  const total = winsA + winsB;
  const simRateA = total > 0 ? winsA / total : NaN;
  const z = zScoreDelta(simRateA, m.deckA.winRate / 100, total);

  console.log(
    `${m.deckA.name} vs ${m.deckB.name}:\n` +
    `  MSA (real, ${m.games} games):  ${m.deckA.winRate}% / ${m.deckB.winRate}%\n` +
    `  Sim (${total} games, ${deckAFile} vs ${deckBFile}):  ${(simRateA * 100).toFixed(1)}% / ${((1 - simRateA) * 100).toFixed(1)}%` +
    `  (delta ${((simRateA * 100) - m.deckA.winRate).toFixed(1)}pt, z=${z.toFixed(2)})` +
    (Math.abs(simRateA * 100 - m.deckA.winRate) > 15 ? '  <-- LARGE DEVIATION' : '') +
    ` draws=${draws} timeouts=${timeouts}\n`
  );
}

if (skipped > 0) console.log(`(${skipped} of ${snapshot.matchups.length} matchups skipped -- no confident decklist mapping for one or both archetypes)`);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s total`);
