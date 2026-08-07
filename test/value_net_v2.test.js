const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createNet, forward, computeGradients, trainStep, saveNet, loadNet } = require('../src/ai/deepSetValueNet');
const { UNIT_FEATURE_COUNT } = require('../src/ai/valueFeaturesV2');
const { FEATURE_COUNT } = require('../src/ai/valueFeatures');

function randomSample(selfCount, enemyCount, rng = Math.random) {
  return {
    scalars: Array.from({ length: FEATURE_COUNT }, () => rng()),
    selfUnits: Array.from({ length: selfCount }, () => Array.from({ length: UNIT_FEATURE_COUNT }, () => rng())),
    enemyUnits: Array.from({ length: enemyCount }, () => Array.from({ length: UNIT_FEATURE_COUNT }, () => rng()))
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('forward is deterministic for the same seed and sample', () => {
  const netA = createNet(7);
  const netB = createNet(7);
  const sample = randomSample(3, 2);
  assert.equal(forward(netA, sample), forward(netB, sample));
});

test('different seeds produce different networks', () => {
  const netA = createNet(1);
  const netB = createNet(2);
  const sample = randomSample(3, 2);
  assert.notEqual(forward(netA, sample), forward(netB, sample));
});

test('forward output is always finite and within +/-outputScale, across varied unit counts', () => {
  const net = createNet(3);
  const shapes = [
    [0, 0],
    [1, 0],
    [0, 1],
    [6, 6],
    [3, 5]
  ];
  for (const [selfCount, enemyCount] of shapes) {
    const sample = randomSample(selfCount, enemyCount);
    const out = forward(net, sample);
    assert.ok(Number.isFinite(out), `expected finite output for ${selfCount}v${enemyCount}, got ${out}`);
    assert.ok(Math.abs(out) <= net.outputScale, `expected |output| <= ${net.outputScale}, got ${out}`);
  }
});

test('empty board on both sides: finite output, no NaN', () => {
  const net = createNet(4);
  const out = forward(net, randomSample(0, 0));
  assert.ok(Number.isFinite(out));
});

test('asymmetric empty board (one side empty, the other not) does not crash or NaN', () => {
  const net = createNet(4);
  assert.ok(Number.isFinite(forward(net, randomSample(0, 4))));
  assert.ok(Number.isFinite(forward(net, randomSample(4, 0))));
});

test('permutation-invariance: shuffling unit order within a side leaves output unchanged (within float tolerance)', () => {
  const net = createNet(9);
  const sample = randomSample(5, 4);
  const base = forward(net, sample);

  const shuffled = { scalars: sample.scalars, selfUnits: shuffle(sample.selfUnits), enemyUnits: shuffle(sample.enemyUnits) };
  const afterShuffle = forward(net, shuffled);

  assert.ok(
    Math.abs(base - afterShuffle) < 1e-9,
    `expected shuffling unit order not to change the output (mean/max pooling are order-independent), got ${base} vs ${afterShuffle}`
  );
});

test('swapping which side is self vs. enemy DOES change output (self/enemy pooling is not accidentally symmetric)', () => {
  const net = createNet(9);
  const selfUnits = randomSample(4, 0).selfUnits;
  const enemyUnits = randomSample(3, 0).selfUnits; // different unit count/values on purpose
  const scalars = randomSample(0, 0).scalars;

  const normal = forward(net, { scalars, selfUnits, enemyUnits });
  const swapped = forward(net, { scalars, selfUnits: enemyUnits, enemyUnits: selfUnits });

  assert.notEqual(normal, swapped);
});

test('loss decreases over repeated trainStep calls on a single example, for a few different unit-count shapes', () => {
  for (const [selfCount, enemyCount] of [
    [0, 0],
    [2, 3]
  ]) {
    const net = createNet(11);
    const sample = randomSample(selfCount, enemyCount, () => 0.5);
    const target = 30;
    const firstLoss = trainStep(net, sample, target, 0.02);
    let lastLoss = firstLoss;
    for (let i = 0; i < 200; i++) lastLoss = trainStep(net, sample, target, 0.02);
    assert.ok(lastLoss < firstLoss, `[${selfCount}v${enemyCount}] expected loss to decrease (${firstLoss} -> ${lastLoss})`);
    assert.ok(Math.abs(forward(net, sample) - target) < 5, `[${selfCount}v${enemyCount}] expected the net to move toward the target`);
  }
});

test('trainStep handles back-to-back examples with wildly different unit counts (6-unit then 0-unit) without shape mismatch/NaN', () => {
  const net = createNet(21);
  const big = randomSample(6, 6);
  const empty = randomSample(0, 0);
  for (let i = 0; i < 20; i++) {
    const lossBig = trainStep(net, big, 40, 0.01);
    const lossEmpty = trainStep(net, empty, -40, 0.01);
    assert.ok(Number.isFinite(lossBig));
    assert.ok(Number.isFinite(lossEmpty));
  }
  assert.ok(Number.isFinite(forward(net, big)));
  assert.ok(Number.isFinite(forward(net, empty)));
});

test('saveNet/loadNet round-trips to a byte-identical forward pass, kind included', () => {
  const net = createNet(99);
  const sample = randomSample(3, 2);
  const before = forward(net, sample);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gundam-deepset-net-'));
  const filePath = path.join(dir, 'net.json');
  saveNet(net, filePath);
  const loaded = loadNet(filePath);

  assert.equal(loaded.kind, 'deepset');
  assert.equal(forward(loaded, sample), before);
});

// --- Numerical gradient check -----------------------------------------------------------------
//
// The highest-value test in this file, targeting the project's own biggest historical AI-training
// risk (two real hand-rolled-backprop bugs already found once in bin/train_value_net.js). Exercises
// computeGradients -- the ACTUAL production backward pass trainStep calls, not a reimplementation of
// it -- by perturbing every parameter of a small, hand-built net (independent of createNet's
// production sizes, purely so the check runs fast) and comparing to the symmetric finite-difference
// approximation.

function makeTinyNet() {
  const unitFeatureSize = 4;
  const unitEmbedSize = 3;
  const combinerHiddenSize = 4;
  const scalarSize = 2;
  const combinerInputSize = unitEmbedSize * 4 + scalarSize;
  const rand = () => (Math.random() * 2 - 1) * 0.5;
  return {
    unitFeatureSize,
    unitEmbedSize,
    combinerHiddenSize,
    combinerInputSize,
    outputScale: 50,
    WEnc: Array.from({ length: unitEmbedSize }, () => Array.from({ length: unitFeatureSize }, rand)),
    bEnc: Array.from({ length: unitEmbedSize }, rand),
    WC1: Array.from({ length: combinerHiddenSize }, () => Array.from({ length: combinerInputSize }, rand)),
    bC1: Array.from({ length: combinerHiddenSize }, rand),
    WC2: Array.from({ length: combinerHiddenSize }, rand),
    bC2: rand()
  };
}

function makeTinySample(selfCount, enemyCount, unitFeatureSize = 4, scalarSize = 2) {
  const rand = () => Math.random();
  return {
    scalars: Array.from({ length: scalarSize }, rand),
    selfUnits: Array.from({ length: selfCount }, () => Array.from({ length: unitFeatureSize }, rand)),
    enemyUnits: Array.from({ length: enemyCount }, () => Array.from({ length: unitFeatureSize }, rand))
  };
}

function lossAt(net, sample, target) {
  return 0.5 * (forward(net, sample) - target) ** 2;
}

function assertCloseRelative(numeric, analytic, tolerance, label) {
  const diff = Math.abs(numeric - analytic);
  const scale = Math.max(1, Math.abs(numeric), Math.abs(analytic));
  assert.ok(diff / scale < tolerance, `${label}: numeric=${numeric}, analytic=${analytic}, relDiff=${(diff / scale).toFixed(6)}`);
}

function checkMatrixGrad(net, sample, target, matrix, grad, eps, tolerance, label) {
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      const orig = matrix[r][c];
      matrix[r][c] = orig + eps;
      const lossPlus = lossAt(net, sample, target);
      matrix[r][c] = orig - eps;
      const lossMinus = lossAt(net, sample, target);
      matrix[r][c] = orig;
      assertCloseRelative((lossPlus - lossMinus) / (2 * eps), grad[r][c], tolerance, `${label}[${r}][${c}]`);
    }
  }
}

function checkVectorGrad(net, sample, target, vec, grad, eps, tolerance, label) {
  for (let i = 0; i < vec.length; i++) {
    const orig = vec[i];
    vec[i] = orig + eps;
    const lossPlus = lossAt(net, sample, target);
    vec[i] = orig - eps;
    const lossMinus = lossAt(net, sample, target);
    vec[i] = orig;
    assertCloseRelative((lossPlus - lossMinus) / (2 * eps), grad[i], tolerance, `${label}[${i}]`);
  }
}

function gradientCheckAllParams(net, sample, target, eps = 1e-4, tolerance = 1e-4) {
  const grads = computeGradients(net, sample, target);
  checkMatrixGrad(net, sample, target, net.WEnc, grads.dWEnc, eps, tolerance, 'WEnc');
  checkVectorGrad(net, sample, target, net.bEnc, grads.dbEnc, eps, tolerance, 'bEnc');
  checkMatrixGrad(net, sample, target, net.WC1, grads.dWC1, eps, tolerance, 'WC1');
  checkVectorGrad(net, sample, target, net.bC1, grads.dbC1, eps, tolerance, 'bC1');
  checkVectorGrad(net, sample, target, net.WC2, grads.dWC2, eps, tolerance, 'WC2');
  // bC2 is a bare scalar on the net, not an array -- checked directly rather than forcing it through
  // the vector helper.
  const orig = net.bC2;
  net.bC2 = orig + eps;
  const lossPlus = lossAt(net, sample, target);
  net.bC2 = orig - eps;
  const lossMinus = lossAt(net, sample, target);
  net.bC2 = orig;
  assertCloseRelative((lossPlus - lossMinus) / (2 * eps), grads.dbC2, tolerance, 'bC2');
}

test('numerical gradient check: 2-vs-1 units, every parameter matches finite differences', () => {
  gradientCheckAllParams(makeTinyNet(), makeTinySample(2, 1), 20);
});

test('numerical gradient check: empty board (0-vs-0 units) -- only the combiner params are exercised, and must still match', () => {
  gradientCheckAllParams(makeTinyNet(), makeTinySample(0, 0), -15);
});

test('numerical gradient check: 6-vs-6 units (full production board size)', () => {
  gradientCheckAllParams(makeTinyNet(), makeTinySample(6, 6), 10);
});

test('numerical gradient check: a deliberate tie (two identical self units) exercises max-pool tie-break consistency', () => {
  const net = makeTinyNet();
  const sample = makeTinySample(2, 1);
  sample.selfUnits[1] = [...sample.selfUnits[0]]; // force an exact tie on every dimension after encoding
  gradientCheckAllParams(net, sample, 20);
});
