#!/usr/bin/env node
// Downloads card art from gundamtcg.one into electron/renderer/assets/cards, where the app bundles
// and ships it from -- this is not a local-reference-only cache, it's the actual shipped asset dir.
// Usage: node bin/download-images.js GD03-021 ST01-001 ...
//        node bin/download-images.js --file path/to/numbers.txt   (one card number per line)
//        node bin/download-images.js --all   (every known set, auto-stops each set after a run of misses)

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const OUT_DIR = path.join(__dirname, '..', 'electron', 'renderer', 'assets', 'cards');
const URL_TEMPLATE = (number) => `https://www.gundamtcg.one/cards/${number}-640w.webp`;
const DELAY_MS = 300;

// Starter decks + booster sets released as of mid-2026 (per gundam-gcg.com's set list).
// New sets ship over time, so this list will need a number added when Bandai releases one.
const SET_PREFIXES = [
  'ST01', 'ST02', 'ST03', 'ST04', 'ST05', 'ST06', 'ST07', 'ST08', 'ST09', 'ST10',
  'GD01', 'GD02', 'GD03', 'GD04', 'GD05',
  'EB01'
];
const MISS_STREAK_TO_STOP_SET = 6; // consecutive 404s that mean "past the end of this set"
const MAX_PER_SET = 200; // hard ceiling per set, just in case the miss-streak heuristic misbehaves

function parseArgs(argv) {
  const fileIdx = argv.indexOf('--file');
  if (fileIdx !== -1) {
    const listPath = argv[fileIdx + 1];
    return fs.readFileSync(listPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return argv.filter((a) => a !== '--file');
}

/** Generates card numbers for every known set, probing sequentially and stopping each set once it runs dry. */
async function* discoverAllNumbers() {
  for (const prefix of SET_PREFIXES) {
    let misses = 0;
    for (let n = 1; n <= MAX_PER_SET && misses < MISS_STREAK_TO_STOP_SET; n++) {
      const number = `${prefix}-${String(n).padStart(3, '0')}`;
      const result = await download(number);
      console.log(`${result.number}: ${result.status}`);
      misses = result.status.startsWith('failed (HTTP 404)') ? misses + 1 : 0;
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
}

function download(number) {
  return new Promise((resolve) => {
    const dest = path.join(OUT_DIR, `${number}.webp`);
    if (fs.existsSync(dest)) return resolve({ number, status: 'skipped (already have it)' });

    https.get(URL_TEMPLATE(number), (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ number, status: `failed (HTTP ${res.statusCode})` });
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve({ number, status: 'downloaded' })));
    }).on('error', (err) => resolve({ number, status: `failed (${err.message})` }));
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (process.argv.includes('--all')) {
    for await (const _ of discoverAllNumbers()) { /* logging happens inside the generator */ }
    return;
  }

  const numbers = parseArgs(process.argv.slice(2));
  if (numbers.length === 0) {
    console.error('Usage: node bin/download-images.js <CARD-NUMBER...>  or  --file <list.txt>  or  --all');
    process.exit(1);
  }

  for (const number of numbers) {
    const result = await download(number);
    console.log(`${result.number}: ${result.status}`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
}

main();
