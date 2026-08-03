const test = require('node:test');
const assert = require('node:assert/strict');

const { SKILL_PRESETS } = require('../src/ai/skillPresets');
const { MCTS_PRESETS } = require('../src/ai/mcts');

test('SKILL_PRESETS covers the 5 named tiers, in ascending strength order, each with a label and a resolvable engine', () => {
  assert.deepEqual(Object.keys(SKILL_PRESETS), ['beginner', 'novice', 'casual', 'tight', 'expert']);
  for (const preset of Object.values(SKILL_PRESETS)) {
    assert.equal(typeof preset.label, 'string');
    assert.ok(preset.engine === 'mcts' || preset.engine === 'lookahead');
  }
});

test('beginner is the old lookahead engine with no MCTS config; the other 4 tiers map onto MCTS_PRESETS at increasing strength', () => {
  assert.equal(SKILL_PRESETS.beginner.engine, 'lookahead');
  assert.equal(SKILL_PRESETS.beginner.mctsConfig, undefined);

  assert.equal(SKILL_PRESETS.novice.engine, 'mcts');
  assert.equal(SKILL_PRESETS.novice.mctsConfig, MCTS_PRESETS.weak);
  assert.equal(SKILL_PRESETS.casual.mctsConfig, MCTS_PRESETS.fast);
  assert.equal(SKILL_PRESETS.tight.mctsConfig, MCTS_PRESETS.balanced);
  assert.equal(SKILL_PRESETS.expert.mctsConfig, MCTS_PRESETS.strong);
});
