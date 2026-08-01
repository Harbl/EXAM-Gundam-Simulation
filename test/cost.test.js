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
