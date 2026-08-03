// Fetches tcgcsv.com's raw product data for a Gundam Card Game set and caches a clean
// number -> {name, rarity, level, cost, cardType, color, trait, linkCondition, ap, hp, description, zone}
// map to scratchpad/<SET>-lookup.json. Usage: node fetch-set.js GD02 24408
const fs = require('fs');
const path = require('path');

const set = process.argv[2];
const groupId = process.argv[3];
if (!set || !groupId) {
  console.error('Usage: node fetch-set.js <SET> <groupId>');
  process.exit(1);
}

fetch(`https://tcgcsv.com/tcgplayer/86/${groupId}/products`, {
  headers: { 'User-Agent': 'gundam-tcg-sim/1.0.0 (research tool)' }
})
  .then((r) => r.json())
  .then((d) => {
    const out = {};
    for (const p of d.results) {
      const ext = {};
      for (const e of p.extendedData || []) ext[e.name] = e.value;
      const number = ext.Number;
      if (!number || !number.startsWith(set + '-')) continue;
      out[number] = {
        name: p.name,
        rarity: ext.Rarity,
        level: ext.Level,
        cost: ext.Cost,
        cardType: ext.CardType,
        color: ext.Color,
        trait: ext.Trait,
        linkCondition: ext['Link Condition'],
        ap: ext['Attack Points'],
        hp: ext['Hit Points'],
        description: ext.Description,
        zone: ext.Zone
      };
    }
    const outPath = path.join(__dirname, set + '-lookup.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log('wrote', Object.keys(out).length, 'cards to', outPath);
  })
  .catch((e) => console.error('ERR', e.message));
