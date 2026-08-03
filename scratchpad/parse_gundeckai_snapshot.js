// Phase 5 step 5: extract real archetype win-rate + head-to-head matchup data from a saved gundeck.ai
// "Command Ctr" page snapshot (gundeck.ai is a client-rendered SPA WebFetch can't see through, so Jake
// saves the fully-rendered page directly -- see Phase 5 of the plan). Not hardcoded to one file: takes
// the snapshot path as an argument so a fresh save later can be re-parsed the same way.
//
// Targets the React component markup directly (data-loc="...HeadToHeadPanel.tsx:171" for the
// desktop-variant matchup rows, "...MetaBreakdownPanel.tsx:164" for archetype win-rate rows) rather
// than flattened text, since flattened text interleaves a duplicate mobile-layout copy of every row.
// Brittle to a future gundeck.ai redesign changing these component names/line numbers -- if a future
// snapshot parses to 0 rows, that's the first thing to check, not a bug in the underlying data.
const fs = require('node:fs');

function parseCount(str) {
  const m = str.trim().match(/^([\d.]+)k$/i);
  return m ? Math.round(parseFloat(m[1]) * 1000) : parseInt(str.replace(/,/g, ''), 10);
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseMatchups(html) {
  const rows = [];
  const chunks = html.split('HeadToHeadPanel.tsx:171').slice(1);
  for (const chunk of chunks) {
    const c = chunk.slice(0, 3200); // one row's worth of markup, well short of the next row starting
    const hrefs = [...c.matchAll(/archetypes\/([a-z0-9-]+)"[\s\S]*?title="([^"]+)"/g)];
    const wrs = [...c.matchAll(/tabular-nums text-center"[^>]*>(\d+)%<\/span>/g)];
    const games = c.match(/HeadToHeadPanel\.tsx:216[\s\S]*?>([\d.,]+k?)<\/span>/);
    if (hrefs.length < 2 || wrs.length < 2 || !games) continue;
    rows.push({
      deckA: { slug: hrefs[0][1], name: decodeEntities(hrefs[0][2]), winRate: Number(wrs[0][1]) },
      deckB: { slug: hrefs[1][1], name: decodeEntities(hrefs[1][2]), winRate: Number(wrs[1][1]) },
      games: parseCount(games[1])
    });
  }
  return rows;
}

function parseArchetypes(html) {
  const rows = [];
  const chunks = html.split('MetaBreakdownPanel.tsx:164').slice(1);
  for (const chunk of chunks) {
    const c = chunk.slice(0, 2200);
    const href = c.match(/archetypes\/([a-z0-9-]+)"/);
    const name = c.match(/font-600 break-words leading-snug"[^>]*>([^<]+)<\/span>/);
    const nums = [...c.matchAll(/tabular-nums"[^>]*>([\d.,]+k?)<\/span>/g)];
    const wr = c.match(/sm:hidden mono text-\[0\.78rem\] font-bold"[^>]*>(\d+)%<\/span>/);
    if (!href || !name || nums.length < 3 || !wr) continue;
    rows.push({
      slug: href[1],
      name: decodeEntities(name[1]),
      wins: parseCount(nums[0][1]),
      losses: parseCount(nums[1][1]),
      total: parseCount(nums[2][1]),
      winRate: Number(wr[1])
    });
  }
  return rows;
}

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scratchpad/parse_gundeckai_snapshot.js <path-to-saved-html>');
  process.exit(1);
}
const html = fs.readFileSync(filePath, 'utf8');
const result = { archetypes: parseArchetypes(html), matchups: parseMatchups(html) };

console.log(`Parsed ${result.archetypes.length} archetype rows, ${result.matchups.length} matchup rows.`);
const outPath = process.argv[3] || 'scratchpad/gundeckai_snapshot.json';
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`Wrote ${outPath}`);
