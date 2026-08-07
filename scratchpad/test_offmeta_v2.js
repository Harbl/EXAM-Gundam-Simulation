const fs = require('fs');
const path = require('path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const { loadNet } = require('../src/ai/valueNet');
const { BALANCED_MCTS_CONFIG } = require('../src/ai/mcts');
const banlist = require('../data/banlist.json');

// All of this session's earlier off-meta matchup testing ran with no valueModel/mctsConfig set at
// all, i.e. the OLD linear scoreState at the OLD default budget (25 playouts) -- neither of which is
// what the app actually ships now. Re-running under the real current AI (trained net + the confirmed
// better BALANCED_MCTS_CONFIG budget) before touching a decklist again, since the gap measured earlier
// may already be smaller under the AI that's actually live.
const VALUE_MODEL = loadNet(path.join(__dirname, '..', 'data', 'valueNet.json'));

function loadDeck(name, dir = 'decklists') {
  const text = fs.readFileSync(path.join(__dirname, dir, name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const candidateName = process.argv[2];
const candidate = loadDeck(candidateName, 'decklists_offmeta');
const matchups = ['nu_gundam_real.txt', 'barbatos_real.txt', 'strikefreedom_barbatos_real.txt', 'strikefreedom_banshee_real.txt', 'shining_master_real.txt'];
const GAMES = 30;

for (const name of matchups) {
  const opp = loadDeck(name);
  let winsCand = 0, winsOpp = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < GAMES; i++) {
    const candIsA = i % 2 === 0;
    const r = playGame(candIsA ? candidate : opp, candIsA ? opp : candidate, {
      seed: Math.floor(Math.random() * 0x100000000),
      valueModelA: VALUE_MODEL,
      valueModelB: VALUE_MODEL,
      mctsConfigA: BALANCED_MCTS_CONFIG,
      mctsConfigB: BALANCED_MCTS_CONFIG
    });
    if (r.draw) draws++;
    else if (r.timedOut) timeouts++;
    else if ((r.winner === 0) === candIsA) winsCand++;
    else winsOpp++;
  }
  const total = winsCand + winsOpp + draws + timeouts;
  console.log(`vs ${name}: candidate ${winsCand}-${winsOpp} (${(winsCand/total*100).toFixed(1)}%), draws=${draws}, timeouts=${timeouts}`);
}
