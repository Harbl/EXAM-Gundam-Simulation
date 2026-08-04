const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const realBanlist = require('../data/banlist.json');

test('parses a basic card line', () => {
  const { main } = parseDecklistText('4 Zaku II ST03-008');
  assert.deepEqual(main, [{ quantity: 4, name: 'Zaku II', number: 'ST03-008' }]);
});

test("parses a card name containing a possessive/apostrophe", () => {
  const { main } = parseDecklistText("1 Char's Gelgoog GD01-023");
  assert.deepEqual(main, [{ quantity: 1, name: "Char's Gelgoog", number: 'GD01-023' }]);
});

test('parses "quantity, number, name" ordering (number before the name)', () => {
  const { main } = parseDecklistText('2 GD01-039 Dopp');
  assert.deepEqual(main, [{ quantity: 2, name: 'Dopp', number: 'GD01-039' }]);
});

test('parses "4xST05-004" -- an x-multiplier glued directly to both the quantity and the number, no name', () => {
  const { main } = parseDecklistText('4xST05-004');
  assert.deepEqual(main, [{ quantity: 4, name: '', number: 'ST05-004' }]);
});

test('parses "4 x ST01-005" -- an x-multiplier as its own spaced-out token, no name', () => {
  const { main } = parseDecklistText('4 x ST01-005');
  assert.deepEqual(main, [{ quantity: 4, name: '', number: 'ST01-005' }]);
});

test('parses "quantity, number" with no name and no x at all', () => {
  const { main } = parseDecklistText('4 ST01-005');
  assert.deepEqual(main, [{ quantity: 4, name: '', number: 'ST01-005' }]);
});

test('a name starting with "X" is never mistaken for an x-multiplier (Xi Gundam, not "4" x "i Gundam ST08-001")', () => {
  const { main } = parseDecklistText('4 Xi Gundam ST08-001');
  assert.deepEqual(main, [{ quantity: 4, name: 'Xi Gundam', number: 'ST08-001' }]);
});

test('parses "quantity, name, (number)" -- number parenthesized at the end', () => {
  const { main } = parseDecklistText('4 Zaku II (ST03-008)');
  assert.deepEqual(main, [{ quantity: 4, name: 'Zaku II', number: 'ST03-008' }]);
});

test('a name containing its own parenthetical still resolves the trailing (number) correctly', () => {
  const { main } = parseDecklistText('1 Penelope (Flight Form) (GD04-002)');
  assert.deepEqual(main, [{ quantity: 1, name: 'Penelope (Flight Form)', number: 'GD04-002' }]);
});

test('a card name shaped like a card number (Re-GZ) is never mistaken for the number itself', () => {
  // Re-GZ (letters-hyphen-alnum) matches the same shape real card numbers do, so this only stays
  // correct because parseLine checks the end-of-line position before the start-of-line position --
  // checking start first previously misparsed this as number="RE-GZ", name="GD05-019".
  assert.deepEqual(parseDecklistText('4 Re-GZ GD05-019').main, [{ quantity: 4, name: 'Re-GZ', number: 'GD05-019' }]);
  assert.deepEqual(parseDecklistText('4 Re-GZ (GD05-019)').main, [{ quantity: 4, name: 'Re-GZ', number: 'GD05-019' }]);
});

test('"quantity, number, name" also handles a name with its own parenthetical', () => {
  const { main } = parseDecklistText('4 GD05-005 Strike Rouge (Ootori)');
  assert.deepEqual(main, [{ quantity: 4, name: 'Strike Rouge (Ootori)', number: 'GD05-005' }]);
});

test('mixed formats, including "quantity, number, name", all parse in the same paste', () => {
  const text = `
4 GD02-054 Gundam Barbatos 1st Form
4 GD05-005 Strike Rouge (Ootori)
4 Zaku II (ST03-008)
4xST05-004
`;
  const { main } = parseDecklistText(text);
  assert.deepEqual(main, [
    { quantity: 4, name: 'Gundam Barbatos 1st Form', number: 'GD02-054' },
    { quantity: 4, name: 'Strike Rouge (Ootori)', number: 'GD05-005' },
    { quantity: 4, name: 'Zaku II', number: 'ST03-008' },
    { quantity: 4, name: '', number: 'ST05-004' }
  ]);
});

test('mixed formats in the same decklist paste all parse correctly', () => {
  const text = `
2 GD01-039 Dopp
4xST05-004
4 GM ST01-005
4 x ST01-010
`;
  const { main } = parseDecklistText(text);
  assert.deepEqual(main, [
    { quantity: 2, name: 'Dopp', number: 'GD01-039' },
    { quantity: 4, name: '', number: 'ST05-004' },
    { quantity: 4, name: 'GM', number: 'ST01-005' },
    { quantity: 4, name: '', number: 'ST01-010' }
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
