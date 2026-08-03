// Race-speed/tactical-ceiling investigation for the still-open Barbatos Rush vs Nu Gundam gap
// (sim ~20%, real MSA 64%, see project memory). Barbatos Rush is a low-curve aggressive archetype --
// if the AI isn't actually racing (attacking face aggressively, accepting trades to close the game
// fast) the way a real pilot would, we'd expect: (a) Barbatos's wins to be fast and its losses to be
// slow grinds where it got out-valued over time, and/or (b) going first/second to matter a lot more
// for Barbatos than a generic tempo-neutral deck would. This just measures those signals directly --
// no code changes, diagnostic only.
const fs = require('node:fs');
const path = require('node:path');
const { parseDecklistText } = require('../src/deck/parser');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const { playGame } = require('../src/sim/singleGame');

function loadDeck(name) {
  const text = fs.readFileSync(path.join(__dirname, 'decklists', name), 'utf8');
  const parsed = parseDecklistText(text);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

const barbatos = loadDeck('barbatos_real.txt');
const nuGundam = loadDeck('nu_gundam_real.txt');

const N = Number(process.argv[2] || 100);

let barbatosWinsAsFirst = 0, barbatosGamesAsFirst = 0;
let barbatosWinsAsSecond = 0, barbatosGamesAsSecond = 0;
const barbatosWinTurns = [];
const barbatosLossTurns = [];

for (let i = 0; i < N; i++) {
  const barbatosIsA = i % 2 === 0; // deckA is always turn-order-first in playGame
  const result = barbatosIsA ? playGame(barbatos, nuGundam) : playGame(nuGundam, barbatos);
  const barbatosIdx = barbatosIsA ? 0 : 1;
  const barbatosWon = result.winner === barbatosIdx;

  if (barbatosIsA) {
    barbatosGamesAsFirst++;
    if (barbatosWon) barbatosWinsAsFirst++;
  } else {
    barbatosGamesAsSecond++;
    if (barbatosWon) barbatosWinsAsSecond++;
  }

  const fullTurns = Math.ceil(result.turns / 2);
  if (result.winner === null) continue; // draw/timeout, exclude from win/loss turn stats
  if (barbatosWon) barbatosWinTurns.push(fullTurns);
  else barbatosLossTurns.push(fullTurns);
}

function avg(arr) { return arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'n/a'; }

console.log(`${N} games, Barbatos Rush vs Nu Gundam, MCTS both sides (DEFAULT_MCTS_CONFIG)\n`);
console.log(`Barbatos as first player:  ${barbatosWinsAsFirst}/${barbatosGamesAsFirst} (${((barbatosWinsAsFirst / barbatosGamesAsFirst) * 100).toFixed(1)}%)`);
console.log(`Barbatos as second player: ${barbatosWinsAsSecond}/${barbatosGamesAsSecond} (${((barbatosWinsAsSecond / barbatosGamesAsSecond) * 100).toFixed(1)}%)`);
console.log();
console.log(`Barbatos WINS avg length:  ${avg(barbatosWinTurns)} turns (n=${barbatosWinTurns.length})`);
console.log(`Barbatos LOSSES avg length: ${avg(barbatosLossTurns)} turns (n=${barbatosLossTurns.length})`);
