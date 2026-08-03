const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, becomeBase } = require('../src/rules/actions');
const {
  getLegalActions,
  applyAction,
  runSearch,
  uct,
  selectChild,
  clampedScore,
  MCTSNode
} = require('../src/ai/mcts');

function resource(player, n = 1) {
  for (let i = 0; i < n; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, player.id));
}

test('getLegalActions always includes pass, plus one entry per legal command/deploy/pair/attack candidate', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  resource(player, 3);

  player.hand.push(
    createInstance({ number: 'CMD', type: 'command', cost: 1 }, 0),
    createInstance({ number: 'DEP', type: 'unit', cost: 1, ap: 1, hp: 1 }, 0),
    createInstance({ number: 'PIL', type: 'pilot', cost: 1, apBonus: 1, hpBonus: 1 }, 0)
  );
  const activeUnit = deployUnit(state, player, { number: 'ACT', type: 'unit', ap: 1, hp: 1 });
  activeUnit.turnDeployed = state.turnNumber - 1; // not deploy-turn-restricted

  const actions = getLegalActions(state, 0);
  const types = actions.map((a) => a.type).sort();
  assert.deepEqual(types, ['attack', 'command', 'deploy', 'pair', 'pass']);
});

test('getLegalActions returns just [pass] once hand/board offer nothing legal', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  const actions = getLegalActions(state, 0);
  assert.deepEqual(actions, [{ type: 'pass' }]);
});

test('applyAction: deploy moves the card from hand to battleArea and spends its cost', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  resource(player, 2);
  const card = createInstance({ number: 'U1', type: 'unit', cost: 2, ap: 1, hp: 1 }, 0);
  player.hand.push(card);

  applyAction(state, 0, { type: 'deploy', cardId: card.id });

  assert.equal(player.hand.length, 0);
  assert.equal(player.battleArea.length, 1);
  assert.equal(player.battleArea[0].def.number, 'U1');
  assert.equal(player.resourceArea.filter((r) => r.rested).length, 2);
});

test('applyAction: pair attaches the pilot to a matching-link Unit already in play', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  resource(player, 1);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, linkCondition: 'Ace' });
  const pilot = createInstance({ number: 'P1', type: 'pilot', cost: 1, name: 'Ace', apBonus: 3, hpBonus: 3 }, 0);
  player.hand.push(pilot);

  applyAction(state, 0, { type: 'pair', cardId: pilot.id });

  assert.equal(unit.pilot, pilot);
  assert.equal(player.hand.length, 0);
});

test('applyAction: attack resolves against the opponent face and rests the attacker', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  opponent.shields.push(createInstance({ number: 'S1', type: 'unit' }, 1));
  const attacker = deployUnit(state, player, { number: 'A1', type: 'unit', ap: 3, hp: 3 });
  attacker.turnDeployed = state.turnNumber - 1;

  applyAction(state, 0, { type: 'attack', attackerId: attacker.id });

  assert.equal(attacker.rested, true);
  assert.equal(opponent.shields.length, 0);
});

test('applyAction: an action that is no longer legal (already applied elsewhere) is a harmless no-op', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  resource(player, 1);
  const card = createInstance({ number: 'U1', type: 'unit', cost: 1, ap: 1, hp: 1 }, 0);
  player.hand.push(card);

  applyAction(state, 0, { type: 'deploy', cardId: card.id });
  assert.equal(player.battleArea.length, 1);

  // Same action again -- card.id is no longer in hand, must not throw or double-deploy.
  applyAction(state, 0, { type: 'deploy', cardId: card.id });
  assert.equal(player.battleArea.length, 1);
});

test('getLegalActions includes an activate action for a currently-usable Activate-Main source (Ra Cailum)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const base = becomeBase(state, player, createInstance(lookupCard('GD05-125'), 0));
  player.battleArea.push(createInstance({ number: 'A', type: 'unit', ap: 3, traits: ['Londo Bell'] }, 0));

  const actions = getLegalActions(state, 0);
  assert.ok(actions.some((a) => a.type === 'activate' && a.sourceId === base.id));
});

test('getLegalActions omits an activate action once the source can no longer produce it (no qualifying target)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  becomeBase(state, player, createInstance(lookupCard('GD05-125'), 0));
  // No (Londo Bell) Unit on the field -- Ra Cailum's resolver has nothing to target.

  const actions = getLegalActions(state, 0);
  assert.ok(!actions.some((a) => a.type === 'activate'));
});

test('applyAction: activate fires the real effect (Ra Cailum rests itself and buffs its biggest Londo Bell Unit)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const base = becomeBase(state, player, createInstance(lookupCard('GD05-125'), 0));
  const bigUnit = createInstance({ number: 'A', type: 'unit', ap: 5, traits: ['Londo Bell'] }, 0);
  player.battleArea.push(createInstance({ number: 'B', type: 'unit', ap: 1, traits: ['Londo Bell'] }, 0), bigUnit);

  applyAction(state, 0, { type: 'activate', sourceId: base.id });

  assert.equal(base.rested, true);
  assert.ok(bigUnit.buffs.some((b) => b.damageReduction === 1));
});

test('applyAction: activate re-fired after already used this turn is a harmless no-op, not a double-application', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  resource(player, 1);
  const source = deployUnit(state, player, lookupCard('GD04-073')); // Turn A Gundam: (1): AP+2 during this turn, once/turn
  source.turnDeployed = state.turnNumber - 1;

  applyAction(state, 0, { type: 'activate', sourceId: source.id });
  assert.equal(source.buffs.filter((b) => b.ap === 2).length, 1);

  // Same action again -- activationsUsed.apBoost is already set, must not stack a second buff.
  applyAction(state, 0, { type: 'activate', sourceId: source.id });
  assert.equal(source.buffs.filter((b) => b.ap === 2).length, 1);
});

test('uct prioritizes an unvisited child with Infinity, otherwise balances value against exploration', () => {
  const parent = new MCTSNode(null, null, null);
  parent.visits = 10;
  const unvisited = new MCTSNode(null, { type: 'pass' }, parent);
  const visited = new MCTSNode(null, { type: 'pass' }, parent);
  visited.visits = 5;
  visited.totalValue = 25; // avg 5

  assert.equal(uct(unvisited, parent.visits), Infinity);
  assert.ok(Number.isFinite(uct(visited, parent.visits)));
  assert.ok(uct(visited, parent.visits) > 5, 'exploration term must add positively on top of the average value');
});

test('selectChild picks the unvisited child over any already-visited one', () => {
  const parent = new MCTSNode(null, null, null);
  parent.visits = 3;
  const strongButVisited = new MCTSNode(null, { type: 'pass' }, parent);
  strongButVisited.visits = 3;
  strongButVisited.totalValue = 300;
  const unvisited = new MCTSNode(null, { type: 'command', cardId: 1 }, parent);
  parent.children.push(strongButVisited, unvisited);

  assert.equal(selectChild(parent), unvisited);
});

test('clampedScore turns a definite win/loss into a large finite number instead of propagating Infinity', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  state.winner = 0;
  assert.equal(clampedScore(state, 0), 1e6);
  assert.equal(clampedScore(state, 1), -1e6);
  assert.ok(Number.isFinite(clampedScore(state, 0)));
});

test('clampedScore returns a finite, correctly-signed value for an ordinary (non-terminal) scoreState (scaled by REWARD_SCALE, not raw)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));
  const score = clampedScore(state, 0);
  assert.ok(Number.isFinite(score) && score > 0);
});

test('runSearch finds a joint deploy+pair combo that scores strictly better than the single-best deploy alone -- something the old fixed deploy-then-pair pipeline can lock itself out of by committing all resources to the single best-looking deploy first', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  resource(player, 3);

  // Deployed alone, A (3 cost, AP2/HP2) clearly outscores B (2 cost, AP1/HP1) on an immediate
  // post-deploy scoreState -- a search that only ever evaluates "deploy subset in isolation" (like
  // the old runDeploysLookahead) has no reason to prefer B. But B is the only Unit Pilot P's link
  // condition matches; deploying B (2) then pairing P (1) uses the same 3 resources for a combined
  // AP(1+5)/HP(1+5) board far stronger than A alone -- only visible to a search that can jointly
  // consider deploy+pair together, which is exactly what the interleaved MCTS action space does.
  const cardA = createInstance({ number: 'A', type: 'unit', cost: 3, ap: 2, hp: 2 }, 0);
  const cardB = createInstance({ number: 'B', type: 'unit', cost: 2, ap: 1, hp: 1, linkCondition: 'Ace' }, 0);
  const pilot = createInstance({ number: 'P', type: 'pilot', cost: 1, name: 'Ace', apBonus: 5, hpBonus: 5 }, 0);
  player.hand.push(cardA, cardB, pilot);

  const root = runSearch(state, 0, { playoutBudget: 200, rolloutTurns: 0, rolloutPolicy: 'cheap' });

  // The best root-level move should be deploying B, not A -- A can never lead anywhere better than
  // itself (nothing left to jointly combine it with), while B unlocks the much stronger paired board.
  let best = null;
  let bestVisits = -1;
  for (const child of root.children) {
    if (child.visits > bestVisits) {
      bestVisits = child.visits;
      best = child;
    }
  }
  assert.equal(best.action.type, 'deploy');
  assert.equal(best.action.cardId, cardB.id, 'search should prefer deploying B (unlocks the pair synergy) over the immediately-stronger-looking A');
});
