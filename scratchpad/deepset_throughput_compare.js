// Quick synthetic throughput comparison: flat net forward() vs. DeepSets net forward(), at
// representative board sizes -- isolates raw eval cost from game-simulation noise, per the project
// plan's "measure before committing to a full training run" step.
const { createNet: createFlat, forward: forwardFlat } = require('../src/ai/valueNet');
const { createNet: createDeepSet, forward: forwardDeepSet } = require('../src/ai/deepSetValueNet');
const { FEATURE_COUNT } = require('../src/ai/valueFeatures');
const { UNIT_FEATURE_COUNT } = require('../src/ai/valueFeaturesV2');

function randomFlatFeatures() {
  return Array.from({ length: FEATURE_COUNT }, () => Math.random());
}
function randomDeepSetSample(selfCount, enemyCount) {
  return {
    scalars: randomFlatFeatures(),
    selfUnits: Array.from({ length: selfCount }, () => Array.from({ length: UNIT_FEATURE_COUNT }, () => Math.random())),
    enemyUnits: Array.from({ length: enemyCount }, () => Array.from({ length: UNIT_FEATURE_COUNT }, () => Math.random()))
  };
}

const N = 200000;
const flatNet = createFlat(1);
const deepSetNet = createDeepSet(1);

function timeIt(label, fn) {
  const t0 = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < N; i++) sink += fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(`${label}: ${ms.toFixed(0)}ms for ${N} calls (${(ms / N * 1000).toFixed(2)}us/call) [sink=${sink.toFixed(2)}]`);
  return ms;
}

const flatFeatures = randomFlatFeatures();
const flatMs = timeIt('flat net (31 scalars)', () => forwardFlat(flatNet, flatFeatures));

const shapes = [
  [0, 0],
  [2, 2],
  [3, 3],
  [6, 6]
];
for (const [s, e] of shapes) {
  const sample = randomDeepSetSample(s, e);
  const ms = timeIt(`deepset net (${s}v${e} units)`, () => forwardDeepSet(deepSetNet, sample));
  console.log(`  -> ${(ms / flatMs).toFixed(2)}x the flat net's cost\n`);
}
