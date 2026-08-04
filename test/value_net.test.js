const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createNet, forward, trainStep, saveNet, loadNet, OUTPUT_SCALE } = require('../src/ai/valueNet');
const { FEATURE_COUNT } = require('../src/ai/valueFeatures');

function randomFeatures(rng = Math.random) {
  return Array.from({ length: FEATURE_COUNT }, () => rng());
}

test('forward is deterministic for the same seed and features', () => {
  const netA = createNet(7);
  const netB = createNet(7);
  const features = randomFeatures();
  assert.equal(forward(netA, features), forward(netB, features));
});

test('different seeds produce different networks', () => {
  const netA = createNet(1);
  const netB = createNet(2);
  const features = randomFeatures();
  assert.notEqual(forward(netA, features), forward(netB, features));
});

test('forward output is always finite and within +/-OUTPUT_SCALE, even for extreme inputs', () => {
  const net = createNet(3);
  const extremeInputs = [
    new Array(FEATURE_COUNT).fill(0),
    new Array(FEATURE_COUNT).fill(1),
    new Array(FEATURE_COUNT).fill(-1000),
    new Array(FEATURE_COUNT).fill(1e10),
    Array.from({ length: FEATURE_COUNT }, () => (Math.random() - 0.5) * 1e6)
  ];
  for (const features of extremeInputs) {
    const out = forward(net, features);
    assert.ok(Number.isFinite(out), `expected finite output, got ${out}`);
    assert.ok(Math.abs(out) <= OUTPUT_SCALE, `expected |output| <= ${OUTPUT_SCALE}, got ${out}`);
  }
});

test('trainStep reduces loss over repeated steps on a single example (backprop sanity check)', () => {
  const net = createNet(11);
  const features = randomFeatures(() => 0.5);
  const target = 30;
  const firstLoss = trainStep(net, features, target, 0.02);
  let lastLoss = firstLoss;
  for (let i = 0; i < 200; i++) lastLoss = trainStep(net, features, target, 0.02);
  assert.ok(lastLoss < firstLoss, `expected loss to decrease (${firstLoss} -> ${lastLoss})`);
  assert.ok(lastLoss < 0.01, `expected the net to nearly memorize a single example, loss was ${lastLoss}`);
  assert.ok(Math.abs(forward(net, features) - target) < 0.5);
});

test('trainStep can fit multiple distinct examples at once (not just collapse to one output)', () => {
  const net = createNet(21);
  const examples = [
    { features: new Array(FEATURE_COUNT).fill(0), target: -40 },
    { features: new Array(FEATURE_COUNT).fill(1), target: 40 },
    { features: new Array(FEATURE_COUNT).fill(0.5), target: 0 }
  ];
  for (let epoch = 0; epoch < 500; epoch++) {
    for (const { features, target } of examples) trainStep(net, features, target, 0.02);
  }
  for (const { features, target } of examples) {
    const out = forward(net, features);
    assert.ok(Math.abs(out - target) < 5, `expected ~${target}, got ${out}`);
  }
});

test('saveNet/loadNet round-trips to a byte-identical forward pass', () => {
  const net = createNet(99);
  const features = randomFeatures();
  const before = forward(net, features);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gundam-value-net-'));
  const filePath = path.join(dir, 'net.json');
  saveNet(net, filePath);
  const loaded = loadNet(filePath);

  assert.equal(forward(loaded, features), before);
});

test('a net loaded via loadNet (no persisted Adam state) can still be trained further', () => {
  const net = createNet(5);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gundam-value-net-'));
  const filePath = path.join(dir, 'net.json');
  saveNet(net, filePath);
  const loaded = loadNet(filePath);
  assert.equal(loaded.adam, undefined);

  const features = randomFeatures(() => 0.3);
  const before = forward(loaded, features);
  for (let i = 0; i < 100; i++) trainStep(loaded, features, 25, 0.02);
  const after = forward(loaded, features);
  assert.ok(Math.abs(after - 25) < Math.abs(before - 25), 'expected training to move output toward the target');
});
