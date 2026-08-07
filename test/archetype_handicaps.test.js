const test = require('node:test');
const assert = require('node:assert/strict');

const { archetypeCardCount, applyArchetypeHandicap } = require('../src/ai/archetypeHandicaps');

function deckWith(numbers) {
  return { main: numbers.map((number) => ({ number })), resource: [] };
}

test('archetypeCardCount counts only the listed card numbers, across duplicates', () => {
  const deck = deckWith(['GD05-017', 'GD05-017', 'GD05-017', 'GD05-020', 'GD05-020', 'ST01-010']);
  assert.equal(archetypeCardCount(deck.main, ['GD05-017', 'GD05-020']), 5);
  assert.equal(archetypeCardCount(deck.main, ['ST01-010']), 1);
  assert.equal(archetypeCardCount(deck.main, ['GD01-001']), 0);
});

test('applyArchetypeHandicap downgrades a real Nu Gundam deck (4+ combined copies) to lookahead', () => {
  const nuGundamDeck = deckWith(['GD05-017', 'GD05-017', 'GD05-017', 'GD05-017', 'GD05-020', 'GD05-020', 'GD05-020']);
  const result = applyArchetypeHandicap(nuGundamDeck, { engine: 'mcts', mctsConfig: { playoutBudget: 25 }, valueModel: {} });
  assert.equal(result.engine, 'lookahead');
  assert.equal(result.handicapped, 'Nu Gundam (Londo Bell)');
});

test('applyArchetypeHandicap leaves a deck with only a token splash (below minCopies) unchanged', () => {
  const splashDeck = deckWith(['GD05-017', 'GD05-020', 'ST01-010', 'ST01-010']);
  const config = { engine: 'mcts', mctsConfig: { playoutBudget: 25 }, valueModel: {} };
  const result = applyArchetypeHandicap(splashDeck, config);
  assert.deepEqual(result, config);
  assert.equal(result.handicapped, undefined);
});

test('applyArchetypeHandicap leaves a deck with none of the archetype cards unchanged', () => {
  const otherDeck = deckWith(['ST01-010', 'ST01-010', 'ST01-010', 'ST01-010']);
  const config = { engine: 'mcts', mctsConfig: { playoutBudget: 25 }, valueModel: {} };
  assert.deepEqual(applyArchetypeHandicap(otherDeck, config), config);
});

test('applyArchetypeHandicap never strengthens an already-non-mcts engine choice back up', () => {
  const nuGundamDeck = deckWith(['GD05-017', 'GD05-017', 'GD05-017', 'GD05-017']);
  const alreadyWeak = { engine: 'lookahead', mctsConfig: undefined, valueModel: {} };
  assert.deepEqual(applyArchetypeHandicap(nuGundamDeck, alreadyWeak), alreadyWeak);
});
