// Quick smoke test for src/ai/sprt.js against real self-play (not simulated coin flips): null vs null
// (today's linear scoreState playing itself) is a true-p0-ish case, so it should resolve to reject or
// inconclusive quickly, never accept. Confirms sprtVerify's real game-playing loop terminates sensibly
// before trusting it on a real multi-hour training run.
const path = require('node:path');
const fs = require('node:fs');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { DEFAULT_SPRT, sprtBounds, llrIncrement, sprtVerdict } = require('../src/ai/sprt');
const banlist = require('../data/banlist.json');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}
const deckNames = fs.readdirSync(path.join(__dirname, 'decklists')).slice(0, 5);
const decks = deckNames.map(loadDeck);

function sprtVerify(candidateModel, championModel, maxGamesPerDeck, sprtParams = DEFAULT_SPRT) {
  const bounds = sprtBounds(sprtParams);
  const maxGames = maxGamesPerDeck * decks.length;
  let winsCandidate = 0, winsChampion = 0, draws = 0, timeouts = 0, llr = 0, total = 0;
  for (; total < maxGames; total++) {
    const deck = decks[total % decks.length];
    const candidateIsA = total % 2 === 0;
    const r = playGame(deck, deck, {
      valueModelA: candidateIsA ? candidateModel : championModel,
      valueModelB: candidateIsA ? championModel : candidateModel
    });
    let candidateWon = false;
    if (r.draw) draws++;
    else if (r.timedOut) timeouts++;
    else if ((r.winner === 0) === candidateIsA) { winsCandidate++; candidateWon = true; }
    else winsChampion++;
    llr += llrIncrement(candidateWon, sprtParams);
    const verdict = sprtVerdict(llr, bounds);
    console.log(`  game ${total + 1}: candidateWon=${candidateWon} llr=${llr.toFixed(3)}`);
    if (verdict) return { winsCandidate, winsChampion, draws, timeouts, total: total + 1, llr, verdict };
  }
  return { winsCandidate, winsChampion, draws, timeouts, total, llr, verdict: 'inconclusive' };
}

console.log('null vs null (linear scoreState vs itself), cap 20 games/deck...');
const result = sprtVerify(null, null, 20);
console.log('\nResult:', result);
