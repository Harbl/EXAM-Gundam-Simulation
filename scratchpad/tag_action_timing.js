const fs = require('fs');
const path = require('path');
const results = JSON.parse(fs.readFileSync('scratchpad/action_timing_cards.json', 'utf8'));
const timingByNumber = {};
for (const r of results) timingByNumber[r.number] = r.timing;
delete timingByNumber['GD04-066'];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const dir = 'src/cards';
let totalTagged = 0;
const remaining = Object.assign({}, timingByNumber);
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith('.json')) continue;
  const full = path.join(dir, file);
  let text = fs.readFileSync(full, 'utf8');
  let changed = false;
  for (const [number, timing] of Object.entries(remaining)) {
    const re = new RegExp('("number": "' + escapeRegex(number) + '",)');
    if (re.test(text)) {
      text = text.replace(re, '$1 "actionTiming": "' + timing + '",');
      changed = true;
      totalTagged++;
      delete remaining[number];
    }
  }
  if (changed) fs.writeFileSync(full, text);
}
console.log('tagged', totalTagged, 'entries');
console.log('unmatched (not found in any file):', Object.keys(remaining));
