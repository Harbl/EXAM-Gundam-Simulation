const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_SPRT, sprtBounds, llrIncrement, sprtVerdict } = require('../src/ai/sprt');

// Deterministic RNG (mulberry32) so the Monte-Carlo tests below are reproducible, not flaky.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs one simulated SPRT series at a given true win rate, returns the verdict reached. */
function simulateSprt(trueWinRate, rng, params, maxGames) {
  const bounds = sprtBounds(params);
  let llr = 0;
  for (let i = 0; i < maxGames; i++) {
    const candidateWon = rng() < trueWinRate;
    llr += llrIncrement(candidateWon, params);
    const verdict = sprtVerdict(llr, bounds);
    if (verdict) return verdict;
  }
  return 'inconclusive';
}

test('sprtBounds matches the closed-form Wald formula', () => {
  const b = sprtBounds({ alpha: 0.05, beta: 0.05 });
  assert.ok(Math.abs(b.upper - Math.log(0.95 / 0.05)) < 1e-9);
  assert.ok(Math.abs(b.lower - Math.log(0.05 / 0.95)) < 1e-9);
  assert.ok(b.upper > 0 && b.lower < 0, 'upper bound positive, lower bound negative');

  // Tighter alpha/beta (fewer false accepts/rejects allowed) widens the bounds -- more evidence needed.
  const tighter = sprtBounds({ alpha: 0.01, beta: 0.01 });
  assert.ok(tighter.upper > b.upper);
  assert.ok(tighter.lower < b.lower);
});

test('llrIncrement pushes the LLR toward accept on a win, toward reject on a loss, when p1>p0', () => {
  const params = { p0: 0.5, p1: 0.54 };
  assert.ok(llrIncrement(true, params) > 0, 'a candidate win should increase LLR');
  assert.ok(llrIncrement(false, params) < 0, 'a candidate loss should decrease LLR');
});

test('sprtVerdict triggers exactly at the boundary, not before', () => {
  const bounds = { upper: 2.9, lower: -2.9 };
  assert.equal(sprtVerdict(2.89, bounds), null);
  assert.equal(sprtVerdict(2.9, bounds), 'accept');
  assert.equal(sprtVerdict(3.5, bounds), 'accept');
  assert.equal(sprtVerdict(-2.89, bounds), null);
  assert.equal(sprtVerdict(-2.9, bounds), 'reject');
  assert.equal(sprtVerdict(-3.5, bounds), 'reject');
  assert.equal(sprtVerdict(0, bounds), null);
});

test('Monte Carlo: a true null (p=p0) mostly resolves reject/inconclusive, rarely accept', () => {
  const rng = mulberry32(42);
  const N = 400;
  const maxGames = 20000;
  let accepts = 0;
  for (let i = 0; i < N; i++) {
    if (simulateSprt(DEFAULT_SPRT.p0, rng, DEFAULT_SPRT, maxGames) === 'accept') accepts++;
  }
  // alpha=0.05 means at most ~5% false-accepts in the long run at the exact null; allow slack for
  // Monte Carlo noise at N=400 and for the (rare) inconclusive-at-cap outcome eating into the count.
  assert.ok(accepts / N < 0.15, `expected a low false-accept rate at p0, got ${accepts}/${N}`);
});

test('Monte Carlo: a true effect (p=p1) mostly resolves accept, rarely reject', () => {
  const rng = mulberry32(1337);
  const N = 400;
  const maxGames = 20000;
  let rejects = 0, accepts = 0;
  for (let i = 0; i < N; i++) {
    const v = simulateSprt(DEFAULT_SPRT.p1, rng, DEFAULT_SPRT, maxGames);
    if (v === 'reject') rejects++;
    if (v === 'accept') accepts++;
  }
  assert.ok(rejects / N < 0.15, `expected a low false-reject rate at p1, got ${rejects}/${N}`);
  assert.ok(accepts / N > 0.7, `expected most true-effect runs to accept, got ${accepts}/${N}`);
});

test('a game cap without resolving reports inconclusive, not a silent false verdict', () => {
  const rng = mulberry32(7);
  // True rate exactly at p0 with a tiny game cap -- essentially guaranteed not to resolve.
  const verdict = simulateSprt(0.5, rng, DEFAULT_SPRT, 3);
  assert.equal(verdict, 'inconclusive');
});
