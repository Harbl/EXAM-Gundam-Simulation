// One-off scratch tool: converts "E:\Gundam TCG DB\Gundam Deck Lists.txt" (format: qty NUMBER Name)
// into per-deck files this repo's parser expects (qty Name NUMBER), using our own card DB for the
// canonical name. Reports any card numbers not yet in our DB instead of guessing.
const fs = require('node:fs');
const path = require('node:path');
const { lookupCard } = require('../src/cards/index');

const SRC = 'E:/Gundam TCG DB/Gundam Deck Lists.txt';
const OUT_DIR = path.join(__dirname, 'decklists');
fs.mkdirSync(OUT_DIR, { recursive: true });

const text = fs.readFileSync(SRC, 'utf8');
const LINE = /^(\d+)\s+([A-Z]{1,4}\d{0,2}-[A-Z0-9]{2,4})\s+(.+)$/i;

let current = null;
const decks = [];
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  const header = line.match(/^\/\/Deck (\d+)\/\/$/);
  if (header) {
    current = { id: header[1], lines: [] };
    decks.push(current);
    continue;
  }
  if (!line || !current) continue;
  const m = line.match(LINE);
  if (!m) {
    console.error(`Deck ${current.id}: could not parse line: "${raw}"`);
    continue;
  }
  current.lines.push({ qty: Number(m[1]), number: m[2].toUpperCase(), rawName: m[3].trim() });
}

let usable = 0;
for (const deck of decks) {
  if (deck.lines.length === 0) continue; // empty/unpopulated decks (36-40)
  const missing = [];
  const outLines = [];
  let total = 0;
  for (const { qty, number, rawName } of deck.lines) {
    const card = lookupCard(number);
    total += qty;
    if (!card) {
      missing.push(number);
      continue;
    }
    outLines.push(`${qty} ${card.name} ${number}`);
  }
  if (missing.length > 0) {
    console.error(`Deck ${deck.id}: MISSING from DB: ${missing.join(', ')}`);
    continue;
  }
  if (total !== 50) {
    console.error(`Deck ${deck.id}: total is ${total}, not 50 -- skipping`);
    continue;
  }
  fs.writeFileSync(path.join(OUT_DIR, `deck${deck.id}.txt`), outLines.join('\n') + '\n');
  usable++;
}
console.error(`\n${usable} usable decks written to ${OUT_DIR}`);
