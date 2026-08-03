const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer } = require('../src/rules/state');
const { canAfford, payCost } = require('../src/rules/cost');

function resource(rested = false) {
  const r = createInstance({ number: 'RESOURCE', name: 'Resource', type: 'resource' }, 0);
  r.rested = rested;
  return r;
}

test('canAfford ignores color entirely -- any active Resources pay any Cost (2-10-1)', () => {
  const player = createPlayer(0);
  player.resourceArea.push(resource(), resource(), resource());
  assert.equal(canAfford(player, { level: 3, cost: 3, color: 'red' }), true);
  assert.equal(canAfford(player, { level: 3, cost: 3, color: 'blue' }), true, 'no color on the resources to match against');
});

test('canAfford requires Level as a total resource-count threshold, active or rested (2-9-1)', () => {
  const player = createPlayer(0);
  player.resourceArea.push(resource(true), resource(true), resource(false));
  assert.equal(canAfford(player, { level: 3, cost: 1 }), true, 'rested resources still count toward Level');
  assert.equal(canAfford(player, { level: 4, cost: 1 }), false, 'only 3 resources in play, Level 4 not met');
});

test('canAfford requires Cost as an active-resource count, separate from Level', () => {
  const player = createPlayer(0);
  player.resourceArea.push(resource(true), resource(true), resource(false));
  assert.equal(canAfford(player, { level: 3, cost: 2 }), false, 'only 1 active resource, Cost 2 not payable');
});

test('payCost rests exactly Cost-many active Resources, any of them', () => {
  const player = createPlayer(0);
  const [r1, r2, r3] = [resource(), resource(), resource()];
  player.resourceArea.push(r1, r2, r3);
  payCost(player, { cost: 2 });
  const restedCount = player.resourceArea.filter((r) => r.rested).length;
  assert.equal(restedCount, 2);
});

test('payCost removes an EX Resource from the game entirely when spent, instead of just resting it (5-17-3-2-3)', () => {
  const player = createPlayer(0);
  const exResource = createInstance({ number: 'EX-RESOURCE', name: 'EX Resource', type: 'resource', isToken: true }, 0);
  player.resourceArea.push(exResource);
  payCost(player, { cost: 1 });
  assert.equal(player.resourceArea.includes(exResource), false, 'spent EX Resource is gone, not just rested');
  assert.equal(player.resourceArea.length, 0);
});

test('payCost still just rests a normal (non-token) Resource when spent', () => {
  const player = createPlayer(0);
  const r = resource();
  player.resourceArea.push(r);
  payCost(player, { cost: 1 });
  assert.equal(player.resourceArea.includes(r), true, 'a normal Resource stays in play, just rested');
  assert.equal(r.rested, true);
});

test('payCost prefers resting normal Resources over spending a token, even when the token is first in resourceArea', () => {
  // Regression test: an EX Resource starts in Player Two's resourceArea *before* any turn's own
  // Resource is ever added (setup.js pushes it at game start; runResourcePhase only ever pushes to
  // the end afterward), so a payment order that just took active[0..cost) would always burn the EX
  // Resource on the very first payment of the game -- permanently losing the Level point it
  // represents, when resting a normal Resource instead would have cost nothing. Jake caught this by
  // noticing the AI "blowing" its EX Resource immediately in a replay.
  const player = createPlayer(0);
  const exResource = createInstance({ number: 'EX-RESOURCE', name: 'EX Resource', type: 'resource', isToken: true }, 0);
  const [r1, r2] = [resource(), resource()];
  player.resourceArea.push(exResource, r1, r2); // token first, matching the real setup.js order

  payCost(player, { cost: 1 });
  assert.equal(player.resourceArea.includes(exResource), true, 'the token should NOT be touched while a normal Resource is available');
  assert.equal(player.resourceArea.length, 3, 'no Resource was removed -- Level stays at 3');

  payCost(player, { cost: 1 });
  assert.equal(player.resourceArea.includes(exResource), true, 'still untouched -- both normal Resources get used up first');
  assert.equal(player.resourceArea.length, 3);

  // Now both normal Resources are rested; only the token remains active, so paying Cost 1 has no
  // choice but to spend it -- this is the one case where using it is correct, not a bug.
  payCost(player, { cost: 1 });
  assert.equal(player.resourceArea.includes(exResource), false, 'once no normal Resource is left active, the token is the payment of last resort');
  assert.equal(player.resourceArea.length, 2);
});
