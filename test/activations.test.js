const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, becomeBase } = require('../src/rules/actions');
const { RESOLVERS, collectActivateCandidates } = require('../src/ai/activations');

function resource(player, n = 1) {
  for (let i = 0; i < n; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, player.id));
}

test('collectActivateCandidates returns nothing when the condition is unmet, and the real args once it is (Geara Doga)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const source = deployUnit(state, player, lookupCard('GD01-053'));

  // No active resource yet -- not usable.
  assert.deepEqual(collectActivateCandidates(state, 0), []);

  resource(player, 1);
  opponent.battleArea.push(createInstance({ number: 'E', type: 'unit', ap: 1 }, 1));
  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, source);
});

test('RESOLVERS respects the once-per-turn activationsUsed guard (Baund Doc)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD03-015'));
  for (let i = 0; i < 3; i++) player.trash.push(createInstance({ number: `T${i}`, type: 'unit', traits: ['Titans'] }, 0));

  assert.ok(RESOLVERS['GD03-015'](state, player, null, source));
  source.activationsUsed.breach = true;
  assert.equal(RESOLVERS['GD03-015'](state, player, null, source), null);
});

test('Gaza C (no guard, self-destructs) is always offered while it remains a legal activator', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD02-047'));

  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, source);

  source.def.effects.activateMain(state, player, source, candidates[0].args);
  // The real effect destroys itself -- no longer in battleArea, so no longer offered.
  assert.equal(player.battleArea.includes(source), false);
  assert.deepEqual(collectActivateCandidates(state, 0), []);
});

test('GFreD only offers args once a Pilot actually exists in trash to exile as the cost', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD03-035'));
  resource(player, 1);

  assert.deepEqual(collectActivateCandidates(state, 0), []);

  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  player.trash.push(pilot);
  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].args.exilePilot, pilot);
});

test('GuAIZ (Commander Type) needs another friendly Unit to target, not itself', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD03-038'));

  assert.deepEqual(collectActivateCandidates(state, 0), []);

  const ally = createInstance({ number: 'A', type: 'unit', ap: 3 }, 0);
  player.battleArea.push(ally);
  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].args.target, ally);
});

test('White Base offers deploying a free token once 2 Resources are active, respects the once-per-turn guard', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployBase(state, player, lookupCard('ST01-015'));

  assert.deepEqual(collectActivateCandidates(state, 0), []);

  resource(player, 2);
  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  source.def.effects.activateMain(state, player, source, candidates[0].args);
  assert.equal(player.battleArea.some((u) => u.def.number === 'TOKEN-WB-GUNDAM'), true);
  assert.deepEqual(collectActivateCandidates(state, 0), []);
});

test('Archangel only offers reactivating a rested friendly Blocker, not an already-active one', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('ST04-015'));
  resource(player, 2);
  const activeBlocker = createInstance({ number: 'B1', type: 'unit', keywords: { blocker: true } }, 0);
  player.battleArea.push(activeBlocker);

  assert.deepEqual(collectActivateCandidates(state, 0), [], 'no rested Blocker yet -- nothing to usefully reactivate');

  activeBlocker.rested = true;
  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].args.target, activeBlocker);
});

test('Nena Trinity (Pilot) is discovered via the paired Unit, not her own (nonexistent) battleArea presence', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit' });
  const ally = createInstance({ number: 'A', type: 'unit', ap: 2 }, 0);
  player.battleArea.push(ally);
  const nena = createInstance(lookupCard('GD04-089'), 0);

  const { pairPilot } = require('../src/rules/actions');
  pairPilot(state, player, unit, nena);

  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1, 'the paired Unit is the activator, resolved via its .pilot');
  assert.equal(candidates[0].source, unit);
  candidates[0].handler(state, player, unit, candidates[0].args);
  assert.equal(unit.rested, true, "Nena Trinity's cost rests the paired Unit, not herself");
  assert.equal(ally.buffs.some((b) => b.ap === 2), true);
});

test('V2 Gundam is deliberately never offered -- its setActive benefit only matters while rested, which the shared activator filter excludes', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD05-001'));
  player.battleArea.push(createInstance({ number: 'A', type: 'unit' }, 0), createInstance({ number: 'B', type: 'unit' }, 0));
  source.rested = true;

  assert.deepEqual(collectActivateCandidates(state, 0), []);
});
