// One-off scratch tool: runs many deck-pair batches from scratchpad/decklists and reports aggregate
// crash/timeout/draw stats plus per-matchup win rates, without spamming a subprocess per pairing.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const banlist = require('../data/banlist.json');

const dir = path.join(__dirname, 'decklists');
const names = fs.readdirSync(dir).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
const decks = {};
for (const f of names) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${f}: ${v.errors.join(' | ')}`);
  decks[f] = buildGameDeck({ main: parsed.main }, lookupCard);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const GAMES_PER_PAIR = Number(process.argv[2] || 40);
const PAIRS_ARG = process.argv[3] || '20';

const pairs = [];
if (PAIRS_ARG === 'all') {
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) pairs.push([names[i], names[j]]);
  }
} else {
  const NUM_PAIRS = Number(PAIRS_ARG);
  const shuffled = shuffle(names);
  for (let i = 0; i < NUM_PAIRS; i++) {
    const a = shuffled[i % shuffled.length];
    const b = shuffled[(i + 7) % shuffled.length]; // offset to avoid always-adjacent pairing
    if (a === b) continue;
    pairs.push([a, b]);
  }
}

let totalGames = 0;
let totalDraws = 0;
let totalTimeouts = 0;
let totalTurns = 0;
let totalCrashes = 0;
const crashes = [];
const notable = [];

for (const [a, b] of pairs) {
  let winsA = 0, winsB = 0, draws = 0, timeouts = 0, turns = 0, crashesHere = 0;
  for (let i = 0; i < GAMES_PER_PAIR; i++) {
    try {
      const r = playGame(decks[a], decks[b]);
      if (r.draw) draws++;
      else if (r.timedOut) timeouts++;
      else if (r.winner === 0) winsA++;
      else winsB++;
      turns += Math.ceil(r.turns / 2); // turnNumber counts per-player turns, not rounds
    } catch (err) {
      crashesHere++;
      crashes.push({ a, b, gameIdx: i, message: err.message, stack: err.stack });
      console.error(`CRASH: ${a} vs ${b}, game ${i}: ${err.message}`);
    }
  }
  totalGames += GAMES_PER_PAIR;
  totalDraws += draws;
  totalTimeouts += timeouts;
  totalTurns += turns;
  totalCrashes += crashesHere;
  if (draws > 0 || timeouts > 0 || crashesHere > 0) {
    notable.push(`${a} vs ${b}: ${winsA}-${winsB} (draws=${draws}, timeouts=${timeouts}, crashes=${crashesHere})`);
  }
}

console.log(`\n${notable.length} notable pairings (draw/timeout/crash) out of ${pairs.length}:`);
for (const line of notable) console.log(line);

console.log(`\nTOTAL: ${totalGames} games across ${pairs.length} pairings`);
console.log(`Draws: ${totalDraws}, Timeouts: ${totalTimeouts}, Crashes: ${totalCrashes}, Avg turns: ${(totalTurns / totalGames).toFixed(1)}`);
if (crashes.length > 0) {
  console.log('\n--- Crash details (first 5) ---');
  for (const c of crashes.slice(0, 5)) {
    console.log(`${c.a} vs ${c.b} game ${c.gameIdx}: ${c.message}\n${c.stack}\n`);
  }
}
