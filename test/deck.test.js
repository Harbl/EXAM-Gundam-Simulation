const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck, resolveResourceDeck } = require('../src/deck/validator');
const realBanlist = require('../data/banlist.json');

test('parses a basic card line', () => {
  const { main } = parseDecklistText('4 Zaku II ST03-008');
  assert.deepEqual(main, [{ quantity: 4, name: 'Zaku II', number: 'ST03-008' }]);
});

test("parses a card name containing a possessive/apostrophe", () => {
  const { main } = parseDecklistText("1 Char's Gelgoog GD01-023");
  assert.deepEqual(main, [{ quantity: 1, name: "Char's Gelgoog", number: 'GD01-023' }]);
});

test('parses a resource-deck line', () => {
  const { resource } = parseDecklistText('6 Blue Resource / 4 Green Resource');
  assert.deepEqual(resource, [
    { quantity: 6, color: 'Blue' },
    { quantity: 4, color: 'Green' }
  ]);
});

test('ignores comments and blank lines', () => {
  const { main } = parseDecklistText('// Main Deck\n\n4 Zaku II ST03-008\n');
  assert.equal(main.length, 1);
});

test('throws on an unparseable line', () => {
  assert.throws(() => parseDecklistText('this is not a decklist line'));
});

function fakeLookup(defsByNumber) {
  return (number) => defsByNumber[number];
}

test('validator flags cards missing from the card database by number', () => {
  const parsed = { main: [{ quantity: 4, name: 'Mystery Unit', number: 'ZZ99-999' }] };
  const banlist = { banned: [], restricted: {}, bannedPairs: [], vanillaGroup: [] };
  const result = validateDeck(parsed, fakeLookup({}), banlist);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingCards, ['ZZ99-999']);
});

test('validator requires exactly 50 main-deck cards', () => {
  const parsed = { main: [{ quantity: 4, name: 'X', number: 'A1-001' }] };
  const banlist = { banned: [], restricted: {}, bannedPairs: [], vanillaGroup: [] };
  const result = validateDeck(parsed, fakeLookup({ 'A1-001': { color: 'blue' } }), banlist);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be exactly 50')));
});

test('validator rejects a banned card at any quantity', () => {
  const parsed = { main: [{ quantity: 1, name: 'Anksha', number: 'GD01-020' }] };
  const banlist = { banned: ['GD01-020'], restricted: {}, bannedPairs: [], vanillaGroup: [] };
  const result = validateDeck(parsed, fakeLookup({ 'GD01-020': { color: 'blue' } }), banlist);
  assert.ok(result.errors.some((e) => e.includes('banned')));
});

test('validator enforces a restricted card\'s copy cap', () => {
  const parsed = { main: [{ quantity: 3, name: 'Corsica Base', number: 'ST02-016' }] };
  const banlist = { banned: [], restricted: { 'ST02-016': 2 }, bannedPairs: [], vanillaGroup: [] };
  const result = validateDeck(parsed, fakeLookup({ 'ST02-016': { color: 'blue' } }), banlist);
  assert.ok(result.errors.some((e) => e.includes('exceeds its limit of 2')));
});

test('validator rejects a banned pair used together', () => {
  const parsed = {
    main: [
      { quantity: 4, name: 'Amuro Ray', number: 'ST01-010' },
      { quantity: 4, name: 'Mikazuki Augus', number: 'ST05-010' }
    ]
  };
  const banlist = { banned: [], restricted: {}, bannedPairs: [['ST01-010', 'ST05-010']], vanillaGroup: [] };
  const result = validateDeck(
    parsed,
    fakeLookup({ 'ST01-010': { color: 'blue' }, 'ST05-010': { color: 'blue' } }),
    banlist
  );
  assert.ok(result.errors.some((e) => e.includes('banned pair')));
});

test('validator rejects two distinct vanilla stat-twins but allows one', () => {
  const banlist = { banned: [], restricted: {}, bannedPairs: [], vanillaGroup: ['GD01-035', 'ST01-005'] };
  const lookup = fakeLookup({ 'GD01-035': { color: 'green' }, 'ST01-005': { color: 'green' } });

  const both = validateDeck(
    { main: [{ quantity: 4, name: 'A', number: 'GD01-035' }, { quantity: 4, name: 'B', number: 'ST01-005' }] },
    lookup,
    banlist
  );
  assert.ok(both.errors.some((e) => e.includes('vanilla stat-twin')));

  const oneOnly = validateDeck({ main: [{ quantity: 4, name: 'A', number: 'GD01-035' }] }, lookup, banlist);
  assert.ok(!oneOnly.errors.some((e) => e.includes('vanilla stat-twin')));
});

test('validator rejects more than 2 colors', () => {
  const parsed = {
    main: [
      { quantity: 4, name: 'A', number: 'A1' },
      { quantity: 4, name: 'B', number: 'B1' },
      { quantity: 4, name: 'C', number: 'C1' }
    ]
  };
  const banlist = { banned: [], restricted: {}, bannedPairs: [], vanillaGroup: [] };
  const lookup = fakeLookup({ A1: { color: 'blue' }, B1: { color: 'green' }, C1: { color: 'red' } });
  const result = validateDeck(parsed, lookup, banlist);
  assert.ok(result.errors.some((e) => e.includes('at most 2')));
});

test('resolveResourceDeck passes a valid provided resource deck through unchanged', () => {
  const provided = [{ quantity: 6, color: 'Blue' }, { quantity: 4, color: 'Green' }];
  assert.deepEqual(resolveResourceDeck(provided, { blue: 25, green: 25 }), provided);
});

test('resolveResourceDeck rejects a provided resource deck of the wrong size', () => {
  assert.throws(() => resolveResourceDeck([{ quantity: 6, color: 'Blue' }], { blue: 50 }));
});

test("resolveResourceDeck defaults to an even split when the main deck's colors are evenly split", () => {
  const result = resolveResourceDeck([], { blue: 25, green: 25 });
  const total = result.reduce((sum, e) => sum + e.quantity, 0);
  assert.equal(total, 10);
  assert.deepEqual(new Set(result.map((e) => e.quantity)), new Set([5]));
});

test("resolveResourceDeck weights the split by each color's actual share of the main deck, not an even split across colors used", () => {
  // A 31/19 (62%/38%) red/blue deck should draw resources close to that ratio, not 50/50 --
  // a flat even split starved this exact color mix of red mana in real batch-sim testing.
  const result = resolveResourceDeck([], { red: 31, blue: 19 });
  const total = result.reduce((sum, e) => sum + e.quantity, 0);
  assert.equal(total, 10);
  const red = result.find((e) => e.color === 'red').quantity;
  const blue = result.find((e) => e.color === 'blue').quantity;
  assert.equal(red, 6, '31/50 of 10 rounds to 6');
  assert.equal(blue, 4, '19/50 of 10 rounds to 4');
});

test("Jake's corrected Blue/Green decklist validates clean against the real banlist", () => {
  const text = `
// Main Deck
4 GM ST01-005
4 Guntank GD01-008
4 Zaku II ST03-008
4 Char's Zaku II GD01-026
4 Char's Zaku II ST03-006
4 Char Aznable ST03-011
4 Rick Dom GD01-030
4 ReZEL GD01-018
4 Amuro Ray ST01-010
4 Gundam ST01-001
4 A Show of Resolve GD01-100
2 Delta Plus GD01-006
2 Jaburo GD04-122
2 Zeong GD04-017
`;
  const parsed = parseDecklistText(text);
  const colorByNumber = {
    'ST01-005': 'blue',
    'GD01-008': 'blue',
    'ST03-008': 'green',
    'GD01-026': 'green',
    'ST03-006': 'green',
    'ST03-011': 'green',
    'GD01-030': 'green',
    'GD01-018': 'blue',
    'ST01-010': 'blue',
    'ST01-001': 'blue',
    'GD01-100': 'green',
    'GD01-006': 'blue',
    'GD04-122': 'blue',
    'GD04-017': 'green'
  };
  const lookup = fakeLookup(
    Object.fromEntries(Object.entries(colorByNumber).map(([number, color]) => [number, { color }]))
  );
  const result = validateDeck(parsed, lookup, realBanlist);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});
