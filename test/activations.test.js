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

test('V2 Gundam is only offered while rested (2 other un-rested Units available to pay the cost)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD05-001'));
  const [a, b] = [createInstance({ number: 'A', type: 'unit', ap: 3 }, 0), createInstance({ number: 'B', type: 'unit', ap: 1 }, 0)];
  player.battleArea.push(a, b);

  assert.deepEqual(collectActivateCandidates(state, 0), [], 'active -- reactivating it would do nothing');

  source.rested = true;
  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].args.restUnits, [b, a], 'rests the 2 lowest-AP other Units, cheapest cost first');

  candidates[0].handler(state, player, source, candidates[0].args);
  assert.equal(source.rested, false, 'the real effect reactivates it');
  assert.equal(collectActivateCandidates(state, 0).length, 0, 'once-per-turn guard, and no longer rested anyway');
});

test('Unicorn Gundam 02 Banshee Norn (Destroy Mode) only offers reactivating while rested and Linked, with 3+ blue cards in trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD04-065'));
  source.rested = true;

  assert.deepEqual(collectActivateCandidates(state, 0), [], 'not a Link Unit yet');
  source.isLinkUnit = true;
  assert.deepEqual(collectActivateCandidates(state, 0), [], 'not enough blue cards in trash yet');

  for (let i = 0; i < 3; i++) player.trash.push(createInstance({ number: `Bl${i}`, type: 'unit', color: 'blue' }, 0));
  assert.equal(collectActivateCandidates(state, 0).length, 1);

  source.rested = false;
  assert.deepEqual(collectActivateCandidates(state, 0), [], 'active -- nothing to reactivate');
});

test("Graham's Union Flag Custom II only offers exiling 2 distinct qualifying cards, not the same card counted twice", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD04-071'));
  source.rested = true;

  assert.deepEqual(collectActivateCandidates(state, 0), []);

  const both = createInstance({ number: 'X', type: 'unit', traits: ['Superpower Bloc', 'UN'] }, 0);
  player.trash.push(both);
  assert.deepEqual(collectActivateCandidates(state, 0), [], 'only 1 real card qualifies for both slots');

  player.trash.push(createInstance({ number: 'Y', type: 'unit', traits: ['UN'] }, 0));
  assert.equal(collectActivateCandidates(state, 0).length, 1, 'now 2 distinct cards can fill the 2 slots');
});

test("Gyunei's Jagd Doga only offers self-destroy-to-reactivate while rested and with another friendly Unit to sacrifice", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD05-057'));
  source.rested = true;

  assert.deepEqual(collectActivateCandidates(state, 0), [], 'no other Unit to sacrifice');

  const ally = createInstance({ number: 'A', type: 'unit' }, 0);
  player.battleArea.push(ally);
  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);

  candidates[0].handler(state, player, source, candidates[0].args);
  assert.equal(player.battleArea.includes(ally), false, 'the sacrifice really destroys the ally');
  assert.equal(source.rested, false);
});

test('Tallgeese only offers reactivating while rested and 4 Resources are active', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('ST02-006'));
  source.rested = true;
  resource(player, 3);

  assert.deepEqual(collectActivateCandidates(state, 0), [], 'only 3 active Resources, needs 4');

  resource(player, 1);
  assert.equal(collectActivateCandidates(state, 0).length, 1);
});

test('<Support> Units (e.g. Buster Gundam) are offered as generic Activate*Main candidates and really buff an ally', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const source = deployUnit(state, player, lookupCard('GD01-046'));

  assert.deepEqual(collectActivateCandidates(state, 0), [], 'no other friendly Unit to target yet');

  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1 });
  const candidates = collectActivateCandidates(state, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, source);
  assert.equal(candidates[0].args.target, ally);

  candidates[0].handler(state, player, source, candidates[0].args);
  assert.equal(source.rested, true, 'Support rests the supporter as its own cost');
  assert.equal(ally.buffs.some((b) => b.ap === 3), true, 'Buster Gundam has Support 3');
  assert.deepEqual(collectActivateCandidates(state, 0), [], 'rested supporter is no longer a legal activator');
});
