const fs = require('node:fs');
const { mulberry32 } = require('../rules/rng');
const { UNIT_FEATURE_COUNT } = require('./valueFeaturesV2');
const { FEATURE_COUNT } = require('./valueFeatures');
const { OUTPUT_SCALE } = require('./valueNet');

const UNIT_EMBED_SIZE = 12;
const COMBINER_HIDDEN_SIZE = 24; // matches valueNet.js's flat-net HIDDEN_SIZE -- same structural role, just fed a richer input

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
 * A DeepSets-style sibling to valueNet.js's flat MLP, deliberately a completely separate module (not
 * an in-place extension) -- see the project plan's "coexistence" section for why: valueNet.js's
 * forward() is the hottest function in the whole AI (called at every MCTS playout leaf), so a brand
 * new, unproven architecture shouldn't add branches/risk to that already-proven path. score.js's
 * scoreState dispatch picks this module vs. valueNet.js's based on a model's `kind` field.
 *
 * Architecture: each battle-area unit (valueFeaturesV2.js's 19-dim extractUnitVector, 0-6 per side) is
 * encoded by one SHARED per-unit encoder (weight-tied across both self and enemy units -- a unit's
 * stat line means the same thing regardless of side; side identity survives because self/enemy are
 * pooled and concatenated separately, never summed together). Each side's embeddings are pooled by
 * BOTH mean and max (concatenated, not just one) -- mean gives the same "aggregate board quality"
 * signal valueFeatures.js's boardAP/boardHP scalars already prove useful; max gives what mean
 * structurally cannot: distinguishing "1 huge threat + 5 nothings" from "6 mediocre units" with
 * identical sums, letting the net learn the class of cross-unit comparison vulnerableUnitCount tried
 * (and failed, per two z-gated retrains) to hand-approximate as one fixed scalar. The pooled
 * self/enemy vectors are concatenated with valueFeatures.js's existing 31 scalar features and fed
 * through one combiner hidden layer -> scalar output, same tanh*outputScale calibration as
 * valueNet.js so mcts.js's REWARD_SCALE/EXPLORATION_C machinery needs zero changes.
 */
function createNet(seed = 1) {
  const rng = mulberry32(seed);
  const randSmall = (scale) => (rng() * 2 - 1) * scale;
  const unitFeatureSize = UNIT_FEATURE_COUNT;
  const unitEmbedSize = UNIT_EMBED_SIZE;
  const combinerHiddenSize = COMBINER_HIDDEN_SIZE;
  const combinerInputSize = unitEmbedSize * 4 + FEATURE_COUNT; // [selfMean, selfMax, enemyMean, enemyMax, scalars]

  const scaleEnc = Math.sqrt(2 / unitFeatureSize);
  const scaleC1 = Math.sqrt(2 / combinerInputSize);
  const scaleC2 = Math.sqrt(2 / combinerHiddenSize);

  return {
    kind: 'deepset',
    unitFeatureSize,
    unitEmbedSize,
    combinerHiddenSize,
    combinerInputSize,
    outputScale: OUTPUT_SCALE,
    WEnc: Array.from({ length: unitEmbedSize }, () => Array.from({ length: unitFeatureSize }, () => randSmall(scaleEnc))),
    bEnc: zeros(unitEmbedSize),
    WC1: Array.from({ length: combinerHiddenSize }, () => Array.from({ length: combinerInputSize }, () => randSmall(scaleC1))),
    bC1: zeros(combinerHiddenSize),
    WC2: Array.from({ length: combinerHiddenSize }, () => randSmall(scaleC2)),
    bC2: 0
  };
}

/** Shared per-unit encoder: one unit's 19-dim vector -> {pre, act} (both cached -- act feeds pooling forward, pre feeds tanh' in backward). */
function encodeUnit(net, u) {
  const pre = new Array(net.unitEmbedSize);
  const act = new Array(net.unitEmbedSize);
  for (let j = 0; j < net.unitEmbedSize; j++) {
    let sum = net.bEnc[j];
    const row = net.WEnc[j];
    for (let i = 0; i < net.unitFeatureSize; i++) sum += row[i] * u[i];
    pre[j] = sum;
    act[j] = Math.tanh(sum);
  }
  return { pre, act };
}

/**
 * Mean+max pool a side's embeddings. Empty set (n=0, a side with no units) -> both mean and max are
 * all-zeros, an explicit branch rather than an accidental 0/0 or -Infinity fallthrough. `argmax` is
 * cached per output dim (index of the embedding that won that dimension's max, -1 if none) so
 * backward never has to -- and never should -- recompute "which unit had the max" from current
 * weights; ties keep the first unit encountered (strict `>`).
 */
function poolSide(embeds, dim) {
  const n = embeds.length;
  const mean = new Array(dim).fill(0);
  const max = new Array(dim).fill(0);
  const argmax = new Array(dim).fill(-1);
  if (n === 0) return { mean, max, argmax, n };
  const running = new Array(dim).fill(-Infinity);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < dim; j++) {
      mean[j] += embeds[k].act[j];
      if (embeds[k].act[j] > running[j]) {
        running[j] = embeds[k].act[j];
        argmax[j] = k;
      }
    }
  }
  for (let j = 0; j < dim; j++) {
    mean[j] /= n;
    max[j] = running[j];
  }
  return { mean, max, argmax, n };
}

/** Internal: forward pass that also returns everything trainStep needs for backprop. `sample` = {scalars, selfUnits, enemyUnits}, see valueFeaturesV2.js's extractDeepSetFeatures. */
function forwardWithCache(net, sample) {
  const selfEmbeds = sample.selfUnits.map((u) => encodeUnit(net, u));
  const enemyEmbeds = sample.enemyUnits.map((u) => encodeUnit(net, u));
  const selfPool = poolSide(selfEmbeds, net.unitEmbedSize);
  const enemyPool = poolSide(enemyEmbeds, net.unitEmbedSize);
  const combinerInput = [...selfPool.mean, ...selfPool.max, ...enemyPool.mean, ...enemyPool.max, ...sample.scalars];

  const hidden = new Array(net.combinerHiddenSize);
  for (let j = 0; j < net.combinerHiddenSize; j++) {
    let sum = net.bC1[j];
    const row = net.WC1[j];
    for (let i = 0; i < combinerInput.length; i++) sum += row[i] * combinerInput[i];
    hidden[j] = Math.tanh(sum);
  }
  let outPre = net.bC2;
  for (let j = 0; j < net.combinerHiddenSize; j++) outPre += net.WC2[j] * hidden[j];
  const output = Math.tanh(outPre) * net.outputScale;

  return { selfEmbeds, enemyEmbeds, selfPool, enemyPool, combinerInput, hidden, output };
}

/** Public forward pass: a single scalar, always finite (tanh-bounded at every layer, same as valueNet.js). */
function forward(net, sample) {
  return forwardWithCache(net, sample).output;
}

function ensureAdamState(net) {
  if (net.adam) return net.adam;
  net.adam = {
    t: 0,
    mWEnc: zeroMatrix(net.unitEmbedSize, net.unitFeatureSize),
    vWEnc: zeroMatrix(net.unitEmbedSize, net.unitFeatureSize),
    mbEnc: zeros(net.unitEmbedSize),
    vbEnc: zeros(net.unitEmbedSize),
    mWC1: zeroMatrix(net.combinerHiddenSize, net.combinerInputSize),
    vWC1: zeroMatrix(net.combinerHiddenSize, net.combinerInputSize),
    mbC1: zeros(net.combinerHiddenSize),
    vbC1: zeros(net.combinerHiddenSize),
    mWC2: zeros(net.combinerHiddenSize),
    vWC2: zeros(net.combinerHiddenSize),
    mbC2: 0,
    vbC2: 0
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
 * Backprops a pooled dimension's upstream gradient back to each unit's embedding activation.
 * Mean-pool backward is a uniform 1/n split of dMean across every unit (every unit contributed
 * equally to the mean). Max-pool backward routes dMax[j] ENTIRELY to the single unit recorded in
 * pool.argmax[j] -- cached from the matching forward pass, never recomputed here.
 */
function backpropPool(pool, dMean, dMax, dim) {
  const dAct = Array.from({ length: pool.n }, () => new Array(dim).fill(0));
  if (pool.n === 0) return dAct;
  for (let k = 0; k < pool.n; k++) {
    for (let j = 0; j < dim; j++) dAct[k][j] += dMean[j] / pool.n;
  }
  for (let j = 0; j < dim; j++) {
    const winner = pool.argmax[j];
    if (winner >= 0) dAct[winner][j] += dMax[j];
  }
  return dAct;
}

/** Accumulates (SUMS, never overwrites) into the shared encoder's gradient tensors for every unit in `embeds`/`units` -- the standard DeepSets tied-weight rule. Called once for self units, once for enemy units, into the same dWEnc/dbEnc accumulators. */
function accumulateEncoderGrad(dWEnc, dbEnc, embeds, units, dAct, unitEmbedSize, unitFeatureSize) {
  for (let k = 0; k < embeds.length; k++) {
    const { act } = embeds[k];
    for (let j = 0; j < unitEmbedSize; j++) {
      const dPre = dAct[k][j] * (1 - act[j] * act[j]); // tanh'
      dbEnc[j] += dPre;
      for (let i = 0; i < unitFeatureSize; i++) dWEnc[j][i] += dPre * units[k][i];
    }
  }
}

/**
 * The full analytic backward pass for a single (sample, target) example -- MSE loss, every gradient
 * tensor, no mutation of `net` and no Adam. Split out from `trainStep` specifically so tests can
 * gradient-check the *actual production backward pass* (compare these analytic gradients against
 * finite differences) rather than a reimplementation of it, which would only prove the test agrees
 * with itself. `trainStep` below is a thin wrapper: call this, then apply Adam.
 */
function computeGradients(net, sample, target) {
  const { selfEmbeds, enemyEmbeds, selfPool, enemyPool, combinerInput, hidden, output } = forwardWithCache(net, sample);

  const dOutput = output - target;
  const tanhOutPre = output / net.outputScale;
  const dOutPre = dOutput * net.outputScale * (1 - tanhOutPre * tanhOutPre);

  // Combiner layer 2 (hidden -> output).
  const dWC2 = new Array(net.combinerHiddenSize);
  const dHidden = new Array(net.combinerHiddenSize);
  for (let j = 0; j < net.combinerHiddenSize; j++) {
    dWC2[j] = dOutPre * hidden[j];
    dHidden[j] = dOutPre * net.WC2[j];
  }
  const dBC2 = dOutPre;

  // Combiner layer 1 (combinerInput -> hidden), through tanh'.
  const dHiddenPre = new Array(net.combinerHiddenSize);
  for (let j = 0; j < net.combinerHiddenSize; j++) dHiddenPre[j] = dHidden[j] * (1 - hidden[j] * hidden[j]);

  const dWC1 = zeroMatrix(net.combinerHiddenSize, combinerInput.length);
  for (let j = 0; j < net.combinerHiddenSize; j++) {
    for (let i = 0; i < combinerInput.length; i++) dWC1[j][i] = dHiddenPre[j] * combinerInput[i];
  }
  const dBC1 = dHiddenPre;

  // dCombinerInput[i] = sum_j dHiddenPre[j] * WC1[j][i] -- needed to route gradient back through pooling.
  const dCombinerInput = new Array(combinerInput.length).fill(0);
  for (let j = 0; j < net.combinerHiddenSize; j++) {
    const row = net.WC1[j];
    for (let i = 0; i < combinerInput.length; i++) dCombinerInput[i] += dHiddenPre[j] * row[i];
  }

  // Split dCombinerInput back into its [selfMean, selfMax, enemyMean, enemyMax, scalars] segments --
  // MUST match forwardWithCache's construction order exactly. dScalars is discarded (extractFeatures
  // isn't parameterized, nothing upstream of it to train).
  const dim = net.unitEmbedSize;
  const dSelfMean = dCombinerInput.slice(0, dim);
  const dSelfMax = dCombinerInput.slice(dim, 2 * dim);
  const dEnemyMean = dCombinerInput.slice(2 * dim, 3 * dim);
  const dEnemyMax = dCombinerInput.slice(3 * dim, 4 * dim);

  const dSelfAct = backpropPool(selfPool, dSelfMean, dSelfMax, dim);
  const dEnemyAct = backpropPool(enemyPool, dEnemyMean, dEnemyMax, dim);

  const dWEnc = zeroMatrix(net.unitEmbedSize, net.unitFeatureSize);
  const dbEnc = zeros(net.unitEmbedSize);
  accumulateEncoderGrad(dWEnc, dbEnc, selfEmbeds, sample.selfUnits, dSelfAct, net.unitEmbedSize, net.unitFeatureSize);
  accumulateEncoderGrad(dWEnc, dbEnc, enemyEmbeds, sample.enemyUnits, dEnemyAct, net.unitEmbedSize, net.unitFeatureSize);

  return { loss: 0.5 * dOutput * dOutput, dWEnc, dbEnc, dWC1, dbC1: dBC1, dWC2, dbC2: dBC2 };
}

/**
 * One Adam step toward `target` for a single (sample, target) example, updating `net` in place. MSE
 * loss, same as valueNet.js's trainStep -- see that file's header for why hand-rolled backprop is the
 * right call here (no ML framework dependency, small enough to verify by hand/gradient-check).
 */
function trainStep(net, sample, target, learningRate) {
  const { loss, dWEnc, dbEnc, dWC1, dbC1, dWC2, dbC2 } = computeGradients(net, sample, target);
  const adam = ensureAdamState(net);
  adam.t += 1;

  for (let j = 0; j < net.combinerHiddenSize; j++) {
    for (let i = 0; i < net.combinerInputSize; i++) {
      const r = adamUpdate(net.WC1[j][i], dWC1[j][i], adam.mWC1[j][i], adam.vWC1[j][i], adam.t, learningRate);
      net.WC1[j][i] = r.param;
      adam.mWC1[j][i] = r.m;
      adam.vWC1[j][i] = r.v;
    }
    const rb1 = adamUpdate(net.bC1[j], dbC1[j], adam.mbC1[j], adam.vbC1[j], adam.t, learningRate);
    net.bC1[j] = rb1.param;
    adam.mbC1[j] = rb1.m;
    adam.vbC1[j] = rb1.v;

    const rw2 = adamUpdate(net.WC2[j], dWC2[j], adam.mWC2[j], adam.vWC2[j], adam.t, learningRate);
    net.WC2[j] = rw2.param;
    adam.mWC2[j] = rw2.m;
    adam.vWC2[j] = rw2.v;
  }
  const rb2 = adamUpdate(net.bC2, dbC2, adam.mbC2, adam.vbC2, adam.t, learningRate);
  net.bC2 = rb2.param;
  adam.mbC2 = rb2.m;
  adam.vbC2 = rb2.v;

  // Shared encoder -- one update per weight, using the SUMMED gradient across every unit application.
  for (let j = 0; j < net.unitEmbedSize; j++) {
    for (let i = 0; i < net.unitFeatureSize; i++) {
      const r = adamUpdate(net.WEnc[j][i], dWEnc[j][i], adam.mWEnc[j][i], adam.vWEnc[j][i], adam.t, learningRate);
      net.WEnc[j][i] = r.param;
      adam.mWEnc[j][i] = r.m;
      adam.vWEnc[j][i] = r.v;
    }
    const rbEnc = adamUpdate(net.bEnc[j], dbEnc[j], adam.mbEnc[j], adam.vbEnc[j], adam.t, learningRate);
    net.bEnc[j] = rbEnc.param;
    adam.mbEnc[j] = rbEnc.m;
    adam.vbEnc[j] = rbEnc.v;
  }

  return loss;
}

/** Persists only the weights (not Adam optimizer state), same convention as valueNet.js's saveNet. */
function saveNet(net, filePath) {
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      kind: 'deepset',
      unitFeatureSize: net.unitFeatureSize,
      unitEmbedSize: net.unitEmbedSize,
      combinerHiddenSize: net.combinerHiddenSize,
      combinerInputSize: net.combinerInputSize,
      outputScale: net.outputScale,
      WEnc: net.WEnc,
      bEnc: net.bEnc,
      WC1: net.WC1,
      bC1: net.bC1,
      WC2: net.WC2,
      bC2: net.bC2
    })
  );
}

function loadNet(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    kind: 'deepset',
    unitFeatureSize: data.unitFeatureSize,
    unitEmbedSize: data.unitEmbedSize,
    combinerHiddenSize: data.combinerHiddenSize,
    combinerInputSize: data.combinerInputSize,
    outputScale: data.outputScale,
    WEnc: data.WEnc,
    bEnc: data.bEnc,
    WC1: data.WC1,
    bC1: data.bC1,
    WC2: data.WC2,
    bC2: data.bC2
  };
}

module.exports = {
  createNet,
  forward,
  forwardWithCache,
  computeGradients,
  trainStep,
  saveNet,
  loadNet,
  UNIT_EMBED_SIZE,
  COMBINER_HIDDEN_SIZE
};
