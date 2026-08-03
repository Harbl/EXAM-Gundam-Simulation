// One-off scratch tool: builds a random legal 50-card deck from the full researched card pool,
// for stress-testing the AI (not part of the app itself).
const fs = require('node:fs');
const path = require('node:path');
const { LIMITS } = require('../src/rules/constants');
const banlist = require('../data/banlist.json');

const CARDS_DIR = path.join(__dirname, '..', 'src', 'cards');
const all = [];
for (const f of fs.readdirSync(CARDS_DIR)) {
  if (!f.endsWith('.json')) continue;
  all.push(...JSON.parse(fs.readFileSync(path.join(CARDS_DIR, f), 'utf8')));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function capFor(def) {
  if (banlist.banned.includes(def.number)) return 0;
  if (banlist.restricted[def.number] !== undefined) return banlist.restricted[def.number];
  return LIMITS.MAX_COPIES;
}

function buildRandomDeck(seedColors) {
  const colors = seedColors || shuffle([...new Set(all.map((c) => c.color).filter(Boolean))]).slice(0, 2);
  const pool = shuffle(all.filter((c) => colors.includes(c.color)));

  const picks = []; // {def, qty}
  const usedVanilla = new Set();
  let total = 0;

  for (const def of pool) {
    if (total >= LIMITS.DECK_SIZE) break;
    if (banlist.vanillaGroup.includes(def.number) && usedVanilla.size > 0 && !usedVanilla.has(def.number)) continue;
    const cap = capFor(def);
    if (cap === 0) continue;
    const bannedPair = banlist.bannedPairs.find((pair) => pair.includes(def.number));
    if (bannedPair) {
      const other = bannedPair.find((n) => n !== def.number);
      if (picks.some((p) => p.def.number === other)) continue;
    }
    const qty = Math.min(cap, LIMITS.DECK_SIZE - total, 1 + Math.floor(Math.random() * cap));
    if (qty <= 0) continue;
    picks.push({ def, qty });
    total += qty;
    if (banlist.vanillaGroup.includes(def.number)) usedVanilla.add(def.number);
  }

  // Top up with more copies of already-picked cards if we're short (small pools / heavy color skew).
  let guard = 0;
  while (total < LIMITS.DECK_SIZE && guard++ < 2000) {
    const p = picks[Math.floor(Math.random() * picks.length)];
    const cap = capFor(p.def);
    if (p.qty < cap) {
      p.qty++;
      total++;
    }
  }

  return { colors, lines: picks.map((p) => `${p.qty} ${p.def.name} ${p.def.number}`), total };
}

const name = process.argv[2] || 'random';
const colorArg = process.argv[3]; // e.g. "blue,white"
const seedColors = colorArg ? colorArg.split(',') : undefined;
const deck = buildRandomDeck(seedColors);
console.error(`${name}: colors=${deck.colors.join('/')} total=${deck.total}`);
console.log(deck.lines.join('\n'));
