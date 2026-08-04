const fs = require('node:fs');
const { mulberry32 } = require('../rules/rng');
const { FEATURE_COUNT } = require('./valueFeatures');

const HIDDEN_SIZE = 24;
// Matches mcts.js's REWARD_SCALE exactly -- the whole point is that a trained net's output lands on
// the same calibrated scale the current linear scoreState already produces (measured in Phase 5's
// score_range_spike.js), so mcts.js's clampedScore/EXPLORATION_C machinery needs zero changes to work
// with a valueModel-backed scoreState. See src/ai/score.js's dispatch and src/ai/mcts.js's REWARD_SCALE.
const OUTPUT_SCALE = 50;

const ADAM_BETA1 = 0.9;
const ADAM_BETA2 = 0.999;
const ADAM_EPS = 1e-8;

function zeros(n) {
  return new Array(n).fill(0);
}
function zeroMatrix(rows, cols) {
  return Array.from({ length: rows }, () => zeros(cols));
}

/**
 * A tiny hand-rolled MLP (FEATURE_COUNT -> HIDDEN_SIZE -> 1, tanh activations throughout) -- this
 * project has zero ML dependencies (package.json only lists electron/electron-builder) and no GPU, so
 * the network has to be small enough to hand-roll and cheap enough to call inside MCTS's rollout loop,
 * which evaluates scoreState many thousands of times per game. Weights are seeded via mulberry32 (same
 * PRNG already used for reproducible game replay) so two createNet(seed) calls with the same seed are
 * byte-identical, useful for tests and for comparing training runs.
 */
function createNet(seed = 1) {
  const rng = mulberry32(seed);
  // He-ish initialization: small random values scaled down by fan-in, keeps early forward passes from
  // saturating tanh immediately (a net that starts fully saturated barely learns at first).
  const scale1 = Math.sqrt(2 / FEATURE_COUNT);
  const scale2 = Math.sqrt(2 / HIDDEN_SIZE);
  const randSmall = (scale) => (rng() * 2 - 1) * scale;

  return {
    inputSize: FEATURE_COUNT,
    hiddenSize: HIDDEN_SIZE,
    W1: Array.from({ length: HIDDEN_SIZE }, () => Array.from({ length: FEATURE_COUNT }, () => randSmall(scale1))),
    b1: zeros(HIDDEN_SIZE),
    W2: Array.from({ length: HIDDEN_SIZE }, () => randSmall(scale2)),
    b2: 0
  };
}

/** Internal: forward pass that also returns the hidden activations/pre-tanh output trainStep needs for backprop. */
function forwardWithCache(net, features) {
  const hidden = new Array(net.hiddenSize);
  for (let j = 0; j < net.hiddenSize; j++) {
    let sum = net.b1[j];
    const row = net.W1[j];
    for (let i = 0; i < net.inputSize; i++) sum += row[i] * features[i];
    hidden[j] = Math.tanh(sum);
  }
  let outPre = net.b2;
  for (let j = 0; j < net.hiddenSize; j++) outPre += net.W2[j] * hidden[j];
  const output = Math.tanh(outPre) * OUTPUT_SCALE;
  return { hidden, output };
}

/** Public forward pass: a single scalar, always finite (tanh-bounded at every layer -- see valueNet.test.js's NaN guard). */
function forward(net, features) {
  return forwardWithCache(net, features).output;
}

/** Lazily attaches Adam moment accumulators (all zero) the first time a net is trained -- lets a freshly
 * createNet()'d net or one loaded via loadNet (which only ever persists the weights themselves, not
 * optimizer state) be trained/fine-tuned without a separate "prepare for training" step. */
function ensureAdamState(net) {
  if (net.adam) return net.adam;
  net.adam = {
    t: 0,
    mW1: zeroMatrix(net.hiddenSize, net.inputSize),
    vW1: zeroMatrix(net.hiddenSize, net.inputSize),
    mb1: zeros(net.hiddenSize),
    vb1: zeros(net.hiddenSize),
    mW2: zeros(net.hiddenSize),
    vW2: zeros(net.hiddenSize),
    mb2: 0,
    vb2: 0
  };
  return net.adam;
}

function adamUpdate(param, grad, m, v, t, learningRate) {
  const newM = ADAM_BETA1 * m + (1 - ADAM_BETA1) * grad;
  const newV = ADAM_BETA2 * v + (1 - ADAM_BETA2) * grad * grad;
  const mHat = newM / (1 - ADAM_BETA1 ** t);
  const vHat = newV / (1 - ADAM_BETA2 ** t);
  const newParam = param - (learningRate * mHat) / (Math.sqrt(vHat) + ADAM_EPS);
  return { param: newParam, m: newM, v: newV };
}

/**
 * One Adam gradient-descent step toward `target` (a scalar on the same OUTPUT_SCALE-calibrated range
 * forward() produces) for a single (features, target) example, updating `net` in place. MSE loss
 * (0.5*(output-target)^2), standard backprop through both tanh layers -- see the module header for why
 * this is a well-understood, small enough piece of math to hand-roll rather than reach for a dependency.
 */
function trainStep(net, features, target, learningRate) {
  const { hidden, output } = forwardWithCache(net, features);
  const adam = ensureAdamState(net);
  adam.t += 1;

  // dL/doutput = (output - target); output = tanh(outPre) * OUTPUT_SCALE, so
  // doutput/doutPre = OUTPUT_SCALE * (1 - tanh(outPre)^2) = OUTPUT_SCALE * (1 - (output/OUTPUT_SCALE)^2).
  const dOutput = output - target;
  const tanhOutPre = output / OUTPUT_SCALE;
  const dOutPre = dOutput * OUTPUT_SCALE * (1 - tanhOutPre * tanhOutPre);

  // Layer 2 (hidden -> output) gradients.
  const dW2 = new Array(net.hiddenSize);
  const dHidden = new Array(net.hiddenSize);
  for (let j = 0; j < net.hiddenSize; j++) {
    dW2[j] = dOutPre * hidden[j];
    dHidden[j] = dOutPre * net.W2[j];
  }
  const dB2 = dOutPre;

  // Layer 1 (input -> hidden) gradients, through tanh's derivative (1 - hidden^2).
  const dHiddenPre = new Array(net.hiddenSize);
  for (let j = 0; j < net.hiddenSize; j++) {
    dHiddenPre[j] = dHidden[j] * (1 - hidden[j] * hidden[j]);
  }

  // Apply Adam updates.
  for (let j = 0; j < net.hiddenSize; j++) {
    for (let i = 0; i < net.inputSize; i++) {
      const grad = dHiddenPre[j] * features[i];
      const r = adamUpdate(net.W1[j][i], grad, adam.mW1[j][i], adam.vW1[j][i], adam.t, learningRate);
      net.W1[j][i] = r.param;
      adam.mW1[j][i] = r.m;
      adam.vW1[j][i] = r.v;
    }
    const rb1 = adamUpdate(net.b1[j], dHiddenPre[j], adam.mb1[j], adam.vb1[j], adam.t, learningRate);
    net.b1[j] = rb1.param;
    adam.mb1[j] = rb1.m;
    adam.vb1[j] = rb1.v;

    const rw2 = adamUpdate(net.W2[j], dW2[j], adam.mW2[j], adam.vW2[j], adam.t, learningRate);
    net.W2[j] = rw2.param;
    adam.mW2[j] = rw2.m;
    adam.vW2[j] = rw2.v;
  }
  const rb2 = adamUpdate(net.b2, dB2, adam.mb2, adam.vb2, adam.t, learningRate);
  net.b2 = rb2.param;
  adam.mb2 = rb2.m;
  adam.vb2 = rb2.v;

  return 0.5 * dOutput * dOutput; // the loss for this example, for callers tracking training/val loss
}

/** Persists only the weights (not Adam optimizer state) -- a saved net is meant to be loaded for
 * inference (scoreState's valueModel dispatch) or, if retrained later, gets fresh Adam accumulators
 * lazily via ensureAdamState rather than resuming stale moment estimates from a previous run. */
function saveNet(net, filePath) {
  fs.writeFileSync(
    filePath,
    JSON.stringify({ inputSize: net.inputSize, hiddenSize: net.hiddenSize, W1: net.W1, b1: net.b1, W2: net.W2, b2: net.b2 })
  );
}

function loadNet(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { inputSize: data.inputSize, hiddenSize: data.hiddenSize, W1: data.W1, b1: data.b1, W2: data.W2, b2: data.b2 };
}

module.exports = { createNet, forward, trainStep, saveNet, loadNet, HIDDEN_SIZE, OUTPUT_SCALE };
