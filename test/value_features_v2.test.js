const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { extractUnitVector, extractDeepSetFeatures, UNIT_FEATURE_COUNT } = require('../src/ai/valueFeaturesV2');
const { extractFeatures } = require('../src/ai/valueFeatures');

// Field order extractUnitVector must produce -- see its own header comment in valueFeaturesV2.js.
// backward's correctness in deepSetValueNet.js depends on this order matching forward's construction
// exactly, so this index map is itself a regression test, not just documentation.
const IDX = {
  ap: 0,
  hp: 1,
  rested: 2,
  isLinkUnit: 3,
  hasPilot: 4,
  isDamaged: 5,
  level: 6,
  blocker: 7,
  firstStrike: 8,
  highManeuver: 9,
  support: 10,
  repair: 11,
  breach: 12,
  colorWhite: 13,
  colorBlue: 14,
  colorGreen: 15,
  colorRed: 16,
  colorPurple: 17,
  buffCount: 18
};

test('extractUnitVector returns exactly UNIT_FEATURE_COUNT numbers, all in [0,1]', () => {
  const u = createInstance({ number: 'U', type: 'unit', ap: 3, hp: 4, level: 5, color: 'blue' }, 0);
  const v = extractUnitVector(u);
  assert.equal(v.length, UNIT_FEATURE_COUNT);
  assert.equal(UNIT_FEATURE_COUNT, 19);
  for (const x of v) {
    assert.ok(Number.isFinite(x), `expected a finite number, got ${x}`);
    assert.ok(x >= 0 && x <= 1, `expected a value in [0,1], got ${x}`);
  }
});

test('a fresh, undamaged, unbuffed, unpaired unit reads mostly zero except AP/HP/level/color', () => {
  const u = createInstance({ number: 'U', type: 'unit', ap: 2, hp: 4, level: 3, color: 'red' }, 0);
  const v = extractUnitVector(u);
  assert.equal(v[IDX.ap], 2 / 10);
  assert.equal(v[IDX.hp], 4 / 10);
  assert.equal(v[IDX.rested], 0);
  assert.equal(v[IDX.isLinkUnit], 0);
  assert.equal(v[IDX.hasPilot], 0);
  assert.equal(v[IDX.isDamaged], 0);
  assert.equal(v[IDX.level], 3 / 10);
  assert.equal(v[IDX.blocker], 0);
  assert.equal(v[IDX.firstStrike], 0);
  assert.equal(v[IDX.highManeuver], 0);
  assert.equal(v[IDX.support], 0);
  assert.equal(v[IDX.repair], 0);
  assert.equal(v[IDX.breach], 0);
  assert.deepEqual([v[IDX.colorWhite], v[IDX.colorBlue], v[IDX.colorGreen], v[IDX.colorRed], v[IDX.colorPurple]], [0, 0, 0, 1, 0]);
  assert.equal(v[IDX.buffCount], 0);
});

test('rested/isLinkUnit/hasPilot/isDamaged flags and keyword amounts read correctly', () => {
  const u = createInstance({ number: 'U', type: 'unit', ap: 1, hp: 5, keywords: { blocker: true, firstStrike: true, highManeuver: true, support: 2, repair: 1, breach: 3 } }, 0);
  u.rested = true;
  u.isLinkUnit = true;
  u.pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  u.damage = 2;
  u.buffs.push({ ap: 1, scope: 'battle' }, { ap: 1, scope: 'turn' }); // ap buffs only -- an hp buff would change getRemainingHP too, muddying the isolated HP assertion below

  const v = extractUnitVector(u);
  assert.equal(v[IDX.rested], 1);
  assert.equal(v[IDX.isLinkUnit], 1);
  assert.equal(v[IDX.hasPilot], 1);
  assert.equal(v[IDX.isDamaged], 1);
  assert.equal(v[IDX.hp], (5 - 2) / 10, 'remaining HP, not printed HP');
  assert.equal(v[IDX.blocker], 1);
  assert.equal(v[IDX.firstStrike], 1);
  assert.equal(v[IDX.highManeuver], 1);
  assert.equal(v[IDX.support], 2 / 3);
  assert.equal(v[IDX.repair], 1 / 3);
  assert.equal(v[IDX.breach], 3 / 5);
  assert.equal(v[IDX.buffCount], 2 / 4);
});

test('values deliberately over their reasoned caps clamp to 1, not something out of range', () => {
  const u = createInstance({ number: 'U', type: 'unit', ap: 99, hp: 99, level: 99, keywords: { support: 99, repair: 99, breach: 99 } }, 0);
  for (let i = 0; i < 20; i++) u.buffs.push({ ap: 1, scope: 'battle' });
  const v = extractUnitVector(u);
  assert.equal(v[IDX.ap], 1);
  assert.equal(v[IDX.hp], 1);
  assert.equal(v[IDX.level], 1);
  assert.equal(v[IDX.support], 1);
  assert.equal(v[IDX.repair], 1);
  assert.equal(v[IDX.breach], 1);
  assert.equal(v[IDX.buffCount], 1);
});

test('an unrecognized/missing color produces an all-zero one-hot, not a crash or a stray 1', () => {
  const u = createInstance({ number: 'U', type: 'unit', ap: 1, hp: 1 }, 0); // no color field at all
  const v = extractUnitVector(u);
  assert.deepEqual([v[IDX.colorWhite], v[IDX.colorBlue], v[IDX.colorGreen], v[IDX.colorRed], v[IDX.colorPurple]], [0, 0, 0, 0, 0]);
});

test('extractDeepSetFeatures: scalars matches extractFeatures exactly, unit lists match battleArea length and content', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const a = createInstance({ number: 'A', type: 'unit', ap: 3, hp: 3, color: 'green' }, 0);
  const b = createInstance({ number: 'B', type: 'unit', ap: 1, hp: 1, color: 'white' }, 0);
  player.battleArea.push(a, b);
  const e = createInstance({ number: 'E', type: 'unit', ap: 5, hp: 5, color: 'purple' }, 1);
  opponent.battleArea.push(e);

  const state = createGame(player, opponent);
  const f = extractDeepSetFeatures(state, 0);

  assert.deepEqual(f.scalars, extractFeatures(state, 0));
  assert.equal(f.selfUnits.length, 2);
  assert.equal(f.enemyUnits.length, 1);
  assert.deepEqual(f.selfUnits[0], extractUnitVector(a));
  assert.deepEqual(f.selfUnits[1], extractUnitVector(b));
  assert.deepEqual(f.enemyUnits[0], extractUnitVector(e));
});

test('extractDeepSetFeatures on an empty board returns empty unit arrays, not undefined/crash', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  const f = extractDeepSetFeatures(state, 0);
  assert.deepEqual(f.selfUnits, []);
  assert.deepEqual(f.enemyUnits, []);
});
