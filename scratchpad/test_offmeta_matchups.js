const fs = require('fs');
const path = require('path');
const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');
const banlist = require('../data/banlist.json');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  const v = validateDeck(parsed, lookupCard, banlist);
  if (!v.valid) throw new Error(`${name}: ${v.errors.join(' | ')}`);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const offmeta = loadDeck('neozeon_offmeta.txt');
const matchups = ['nu_gundam_real.txt', 'barbatos_real.txt', 'strikefreedom_barbatos_real.txt', 'strikefreedom_banshee_real.txt'];
const GAMES = 30;

for (const name of matchups) {
  const opp = loadDeck(name);
  let winsOffmeta = 0, winsOpp = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < GAMES; i++) {
    const offmetaIsA = i % 2 === 0;
    const r = playGame(offmetaIsA ? offmeta : opp, offmetaIsA ? opp : offmeta, { seed: Math.floor(Math.random() * 0x100000000) });
    if (r.draw) draws++;
    else if (r.timedOut) timeouts++;
    else if ((r.winner === 0) === offmetaIsA) winsOffmeta++;
    else winsOpp++;
  }
  const total = winsOffmeta + winsOpp + draws + timeouts;
  console.log(`vs ${name}: off-meta ${winsOffmeta}-${winsOpp} (${(winsOffmeta/total*100).toFixed(1)}%), draws=${draws}, timeouts=${timeouts}`);
}
