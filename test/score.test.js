const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlayer, createGame } = require('../src/rules/state');
const { scoreState } = require('../src/ai/score');
const { createNet: createFlatNet } = require('../src/ai/valueNet');
const { createNet: createDeepSetNet } = require('../src/ai/deepSetValueNet');

// scoreState's valueModel dispatch (src/ai/score.js) is the one production seam this whole DeepSets
// addition touches -- see the project plan's "coexistence" section for why everything else (mcts.js,
// skillPresets.js, the electron workers) never needed to change: they only ever pass an opaque
// valueModel object through, and this dispatch is where its shape actually matters.

test('a valueModel with kind "deepset" routes to the DeepSets forward path, not the flat one', () => {
  const player = createPlayer(0);
  player.valueModel = createDeepSetNet(1);
  const state = createGame(player, createPlayer(1));

  // Would throw/produce a nonsense value if routed through the flat path (extractFeatures's flat
  // array fed to a net expecting {scalars, selfUnits, enemyUnits}) -- a clean finite number confirms
  // the deepset path actually ran.
  const score = scoreState(state, 0);
  assert.ok(Number.isFinite(score));
});

test('a valueModel with no kind field (old saved flat net) still routes to the flat path unchanged', () => {
  const player = createPlayer(0);
  player.valueModel = createFlatNet(1);
  assert.equal(player.valueModel.kind, undefined, 'sanity check: the flat net genuinely has no kind field');
  const state = createGame(player, createPlayer(1));

  const score = scoreState(state, 0);
  assert.ok(Number.isFinite(score));
});

test('no valueModel at all still falls back to the linear scoreState formula', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const score = scoreState(state, 0);
  assert.equal(score, 0, 'an empty starting board should score exactly even (0) under the linear formula');
});
