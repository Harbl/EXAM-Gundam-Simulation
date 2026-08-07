const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { extractFeatures, FEATURE_COUNT } = require('../src/ai/valueFeatures');

// Index layout: [selfShields, selfBaseHP, selfBoardAP, selfBoardHP, selfUnitCount,
// selfActiveUnitCount, selfActiveBoardAP, selfBlockerCount, selfHand, selfNormalResources,
// selfExResourceHeld, selfActivationPotential, selfTrashSynergy] x2 (self, enemy), then turnNumber,
// then [selfThreatRatio, enemyThreatRatio], then [selfVulnerableUnitCount, enemyVulnerableUnitCount],
// then [selfReactiveReserve, enemyReactiveReserve] -- see extractFeatures's own header comment in
// src/ai/valueFeatures.js.
const SELF = {
  shields: 0, baseHP: 1, boardAP: 2, boardHP: 3, unitCount: 4, activeUnitCount: 5, activeBoardAP: 6,
  blockerCount: 7, hand: 8, normalResources: 9, exResourceHeld: 10, activationPotential: 11, trashSynergy: 12
};
const ENEMY_OFFSET = 13;
const TURN_IDX = 26;
const SELF_THREAT_IDX = 27;
const ENEMY_THREAT_IDX = 28;
const SELF_VULN_IDX = 29;
const ENEMY_VULN_IDX = 30;
const SELF_REACTIVE_RESERVE_IDX = 31;
const ENEMY_REACTIVE_RESERVE_IDX = 32;

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

test('a rested unit still counts toward the raw board totals but not the active-only ones', () => {
  const player = createPlayer(0);
  const unit = createInstance({ number: 'U', type: 'unit', ap: 3, hp: 3 }, 0);
  unit.rested = true;
  player.battleArea.push(unit);
  const state = createGame(player, createPlayer(1));
  const f = extractFeatures(state, 0);

  assert.equal(f[SELF.boardAP], 3 / 30);
  assert.equal(f[SELF.unitCount], 1 / 6);
  assert.equal(f[SELF.activeUnitCount], 0, 'the unit is rested, so it should not count as active');
  assert.equal(f[SELF.activeBoardAP], 0, 'a rested unit contributes no active AP');
});

test('blockerCount only counts untapped Blocker-keyword units', () => {
  const player = createPlayer(0);
  const activeBlocker = createInstance({ number: 'B1', type: 'unit', ap: 1, hp: 1, keywords: { blocker: true } }, 0);
  const restedBlocker = createInstance({ number: 'B2', type: 'unit', ap: 1, hp: 1, keywords: { blocker: true } }, 0);
  restedBlocker.rested = true;
  const nonBlocker = createInstance({ number: 'N', type: 'unit', ap: 1, hp: 1 }, 0);
  player.battleArea.push(activeBlocker, restedBlocker, nonBlocker);
  const state = createGame(player, createPlayer(1));
  const f = extractFeatures(state, 0);

  assert.equal(f[SELF.blockerCount], 1 / 3, 'only the untapped Blocker should count -- a rested Blocker cannot block (13-1-4)');
});

test('threatRatio reflects active board AP against the opponent\'s remaining life, not the enemy\'s own', () => {
  const attacker = createPlayer(0);
  const unit = createInstance({ number: 'U', type: 'unit', ap: 6, hp: 6 }, 0);
  attacker.battleArea.push(unit);
  const defender = createPlayer(1);
  defender.shields.push(createInstance({ number: 'SH', type: 'unit' }, 1)); // remainingLife = 1 (1 shield, no base)

  const state = createGame(attacker, defender);
  const f = extractFeatures(state, 0);

  // selfThreatRatio = min(1, activeBoardAP / enemy remainingLife) = min(1, 6 / 1) = 1 (clamped).
  assert.equal(f[SELF_THREAT_IDX], 1);
  // enemyThreatRatio = enemy's active board AP (0, empty board) / self's remainingLife = 0.
  assert.equal(f[ENEMY_THREAT_IDX], 0);
});

test('vulnerableUnitCount flags a unit the enemy can safely kill (Nu Gundam GD05-017\'s [When Paired] shape), not just any combat', () => {
  const self = createPlayer(0);
  // AP2/HP4: the enemy's AP5 unit can one-shot it (HP4 <= 5) and can't be killed back (AP2 < enemy's HP5).
  const sniped = createInstance({ number: 'V', type: 'unit', ap: 2, hp: 4 }, 0);
  // AP6/HP4: same HP, but its own AP (6) is NOT less than the enemy's remaining HP (5) -- trading into
  // it would kill the enemy back too, so Nu Gundam's own ability would never pick it (not "vulnerable").
  const safe = createInstance({ number: 'S', type: 'unit', ap: 6, hp: 4 }, 0);
  self.battleArea.push(sniped, safe);
  const enemy = createPlayer(1);
  enemy.battleArea.push(createInstance({ number: 'E', type: 'unit', ap: 5, hp: 5 }, 1));

  const state = createGame(self, enemy);
  const f = extractFeatures(state, 0);

  assert.equal(f[SELF_VULN_IDX], 1 / 6, 'exactly one of self\'s two units is actually exposed to a safe kill');
  assert.equal(f[ENEMY_VULN_IDX], 0, 'the enemy\'s own unit (AP5/HP5) isn\'t threatened by anything on a board with no attackers capable of it');
});

test('vulnerableUnitCount is 0 both ways on an empty board (no false positives from vacuous comparisons)', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  const f = extractFeatures(state, 0);
  assert.equal(f[SELF_VULN_IDX], 0);
  assert.equal(f[ENEMY_VULN_IDX], 0);
});

test('reactiveReserve feature reflects Resources actively held open for a real [Action]-timing Command, normalized by REACTIVE_RESERVE_CAP (6)', () => {
  const self = createPlayer(0);
  for (let i = 0; i < 3; i++) self.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  self.hand.push(createInstance({ number: 'ACT', type: 'command', actionTiming: 'action', level: 1, cost: 2 }, 0));
  const enemy = createPlayer(1); // no held Resources/Action Command at all

  const state = createGame(self, enemy);
  const f = extractFeatures(state, 0);

  assert.equal(f[SELF_REACTIVE_RESERVE_IDX], 2 / 6);
  assert.equal(f[ENEMY_REACTIVE_RESERVE_IDX], 0);
});
