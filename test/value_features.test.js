const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { extractFeatures, FEATURE_COUNT } = require('../src/ai/valueFeatures');

// Index layout: [selfShields, selfBaseHP, selfBoardAP, selfBoardHP, selfMaxUnitAP, selfMaxUnitHP,
// selfBlockerCount, selfFirstStrikeCount, selfRestedCount, selfLinkUnitCount, selfUnitCount, selfHand,
// selfNormalResources, selfExResourceHeld, selfActivationPotential, selfTrashSynergy] x2 (self, enemy),
// then turnNumber -- see extractFeatures's own header comment in src/ai/valueFeatures.js.
const SELF = {
  shields: 0,
  baseHP: 1,
  boardAP: 2,
  boardHP: 3,
  maxUnitAP: 4,
  maxUnitHP: 5,
  blockerCount: 6,
  firstStrikeCount: 7,
  restedCount: 8,
  linkUnitCount: 9,
  unitCount: 10,
  hand: 11,
  normalResources: 12,
  exResourceHeld: 13,
  activationPotential: 14,
  trashSynergy: 15
};
const ENEMY_OFFSET = 16;
const TURN_IDX = 32;

test('extractFeatures returns exactly FEATURE_COUNT numbers, all in normalized range', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  const f = extractFeatures(state, 0);
  assert.equal(f.length, FEATURE_COUNT);
  assert.equal(FEATURE_COUNT, 33);
  for (const x of f) {
    assert.ok(Number.isFinite(x), `expected a finite number, got ${x}`);
    assert.ok(x >= 0 && x <= 1, `expected a value in [0,1], got ${x}`);
  }
});

test('an empty starting state (no shields/hand/board/resources, turn 1) is all zeros except turnNumber', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  const f = extractFeatures(state, 0);
  for (let i = 0; i < FEATURE_COUNT; i++) {
    if (i === TURN_IDX) continue;
    assert.equal(f[i], 0, `expected index ${i} to be 0`);
  }
  assert.equal(f[TURN_IDX], 1 / 30);
});

test('normal Resources and a held EX Resource token are counted separately, not conflated', () => {
  const player = createPlayer(0);
  const resourceDef = { number: 'X-RES', type: 'resource', color: 'blue' };
  const exResourceDef = { number: 'X-EXRES', type: 'resource', color: 'blue', isToken: true };
  player.resourceArea.push(
    createInstance(resourceDef, 0),
    createInstance(resourceDef, 0),
    createInstance(resourceDef, 0),
    createInstance(exResourceDef, 0)
  );
  const state = createGame(player, createPlayer(1));
  const f = extractFeatures(state, 0);
  assert.equal(f[SELF.normalResources], 3 / 10); // LIMITS.RESOURCE_DECK_SIZE, not /15
  assert.equal(f[SELF.exResourceHeld], 1);
});

test('a value deliberately over its rules cap clamps to 1, not something out of range', () => {
  const player = createPlayer(0);
  // 8 shields is not reachable under real rules (SHIELD_COUNT is 6), but the feature extractor
  // itself must never emit >1 regardless of what state it's handed.
  for (let i = 0; i < 8; i++) player.shields.push(createInstance({ number: `SH${i}`, type: 'unit' }, 0));
  const state = createGame(player, createPlayer(1));
  const f = extractFeatures(state, 0);
  assert.equal(f[SELF.shields], 1);
});

test('self/enemy halves are perspective-relative: swapping playerIdx swaps which half is which', () => {
  const playerA = createPlayer(0);
  const playerB = createPlayer(1);
  playerA.shields.push(createInstance({ number: 'SH', type: 'unit' }, 0));
  playerA.shields.push(createInstance({ number: 'SH2', type: 'unit' }, 0));
  playerA.hand.push(createInstance({ number: 'H', type: 'command' }, 0));
  playerB.shields.push(createInstance({ number: 'SH3', type: 'unit' }, 1));

  const state = createGame(playerA, playerB);
  const fromA = extractFeatures(state, 0);
  const fromB = extractFeatures(state, 1);

  assert.equal(fromA[SELF.shields], 2 / 6);
  assert.equal(fromA[ENEMY_OFFSET + SELF.shields], 1 / 6);
  assert.equal(fromA[SELF.hand], 1 / 10);

  // From playerB's perspective, self/enemy flip -- playerB's own (1-shield) half should match
  // what playerA's view called "enemy", and vice versa.
  assert.equal(fromB[SELF.shields], 1 / 6);
  assert.equal(fromB[ENEMY_OFFSET + SELF.shields], 2 / 6);
  assert.equal(fromB[ENEMY_OFFSET + SELF.hand], 1 / 10);
});

test('turnNumber is normalized by the same 30-turn cap for both players and clamps at 1', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  state.turnNumber = 15;
  assert.equal(extractFeatures(state, 0)[TURN_IDX], 0.5);
  state.turnNumber = 999;
  assert.equal(extractFeatures(state, 0)[TURN_IDX], 1);
});

function unit(overrides = {}) {
  return Object.assign(createInstance({ number: 'U', type: 'unit', ap: 2, hp: 3, keywords: {} }, 0), overrides);
}

test('maxUnitAP/maxUnitHP reflect the single strongest unit, not the board sum', () => {
  const player = createPlayer(0);
  player.battleArea.push(
    createInstance({ number: 'BIG', type: 'unit', ap: 10, hp: 8, keywords: {} }, 0),
    createInstance({ number: 'SMALL1', type: 'unit', ap: 2, hp: 1, keywords: {} }, 0),
    createInstance({ number: 'SMALL2', type: 'unit', ap: 2, hp: 1, keywords: {} }, 0)
  );
  const state = createGame(player, createPlayer(1));
  const f = extractFeatures(state, 0);
  assert.equal(f[SELF.maxUnitAP], 10 / 15); // MAX_UNIT_STAT_CAP, not the sum (14) or /30
  assert.equal(f[SELF.maxUnitHP], 8 / 15);
  assert.equal(f[SELF.boardAP], 14 / 30); // sum still behaves as before
});

test('blockerCount/firstStrikeCount count only units that actually have the keyword', () => {
  const player = createPlayer(0);
  player.battleArea.push(
    createInstance({ number: 'B1', type: 'unit', ap: 1, hp: 1, keywords: { blocker: true } }, 0),
    createInstance({ number: 'FS1', type: 'unit', ap: 1, hp: 1, keywords: { firstStrike: true } }, 0),
    createInstance({ number: 'PLAIN', type: 'unit', ap: 1, hp: 1, keywords: {} }, 0)
  );
  const state = createGame(player, createPlayer(1));
  const f = extractFeatures(state, 0);
  assert.equal(f[SELF.blockerCount], 1 / 6); // LIMITS.MAX_BATTLE_AREA
  assert.equal(f[SELF.firstStrikeCount], 1 / 6);
});

test('restedCount/linkUnitCount reflect live instance state, not the card definition', () => {
  const player = createPlayer(0);
  const rested = unit();
  rested.rested = true;
  const linked = unit();
  linked.isLinkUnit = true;
  const plain = unit();
  player.battleArea.push(rested, linked, plain);

  const state = createGame(player, createPlayer(1));
  const f = extractFeatures(state, 0);
  assert.equal(f[SELF.restedCount], 1 / 6);
  assert.equal(f[SELF.linkUnitCount], 1 / 6);
});

test('an empty battle area gives 0 for maxUnitAP/maxUnitHP, not NaN or -Infinity', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  const f = extractFeatures(state, 0);
  assert.equal(f[SELF.maxUnitAP], 0);
  assert.equal(f[SELF.maxUnitHP], 0);
});
