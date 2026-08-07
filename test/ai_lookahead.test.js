const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { dealDamage } = require('../src/rules/management');
const { cloneState } = require('../src/rules/clone');
const { scoreState, trashSynergyValue, damagedSynergyValue, reactiveReserveValue, DEFAULT_WEIGHTS } = require('../src/ai/score');
const {
  runMainPhase,
  runMainPhaseSimple,
  runAttacksLookahead,
  runDeploysLookahead,
  runCommandsLookahead,
  chooseBlocker,
  chooseBlockerLookahead,
  defaultHooks,
  lookaheadHooks
} = require('../src/ai/heuristic');

test('cloneState deep-isolates the clone from the original across every field category', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3 });
  const pilot = createInstance({ number: 'P1', type: 'pilot', apBonus: 1, hpBonus: 1 }, 0);
  unit.pilot = pilot;
  unit.buffs.push({ ap: 1, scope: 'turn' });
  player.base = createInstance({ number: 'BASE', type: 'base', ap: 0, hp: 3 }, 0);
  player.specialMoveActivatedThisTurn = true;
  player.shieldDamageImmuneLevelCap = 3;

  const clone = cloneState(state);

  // Mutate the clone across every field category; the original must be untouched.
  clone.players[0].battleArea[0].rested = true;
  clone.players[0].battleArea[0].damage = 5;
  clone.players[0].battleArea[0].buffs.push({ ap: 99 });
  clone.players[0].battleArea[0].pilot = null;
  clone.players[0].base.damage = 3;
  clone.players[0].specialMoveActivatedThisTurn = false;
  clone.players[0].shieldDamageImmuneLevelCap = 99;
  clone.players[0].hand.push(createInstance({ number: 'X', type: 'unit' }, 0));

  assert.equal(unit.rested, false);
  assert.equal(unit.damage, 0);
  assert.equal(unit.buffs.length, 1);
  assert.equal(unit.pilot, pilot);
  assert.equal(player.base.damage, 0);
  assert.equal(player.specialMoveActivatedThisTurn, true);
  assert.equal(player.shieldDamageImmuneLevelCap, 3);
  assert.equal(player.hand.length, 0);
});

test('cloneState keeps card defs as shared references, never clones them', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });

  const clone = cloneState(state);
  assert.equal(clone.players[0].battleArea[0].def, unit.def, 'def must be the same reference, not a copy');
});

test('cloneState preserves object identity for cross-references (aliasing), not just structure', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const shared = createInstance({ number: 'S1', type: 'unit' }, 0);
  state.aliasA = shared;
  state.aliasB = shared;
  assert.equal(state.aliasA, state.aliasB, 'sanity: same object before cloning');

  const clone = cloneState(state);
  assert.notEqual(clone.aliasA, shared, 'clone must be a distinct object from the original');
  assert.equal(clone.aliasA, clone.aliasB, 'both references must resolve to the SAME cloned object');
});

test('scoreState returns +/-Infinity for a decided game and 0 for a draw', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  state.winner = 0;
  assert.equal(scoreState(state, 0), Infinity);
  assert.equal(scoreState(state, 1), -Infinity);

  const drawState = createGame(createPlayer(0), createPlayer(1));
  drawState.draw = true;
  assert.equal(scoreState(drawState, 0), 0);
  assert.equal(scoreState(drawState, 1), 0);
});

test('scoreState is symmetric and rewards more shields/board presence', () => {
  const playerA = createPlayer(0);
  const playerB = createPlayer(1);
  const state = createGame(playerA, playerB);
  playerA.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));
  playerA.shields.push(createInstance({ number: 'S2', type: 'unit' }, 0));

  assert.equal(scoreState(state, 0), -scoreState(state, 1), 'self-vs-enemy scoring must be symmetric');
  assert.ok(scoreState(state, 0) > 0, 'the player with more shields should score higher for themselves');
});

test('scoreState gives extra, separate credit for still holding an unspent EX Resource token, beyond the generic resource-count credit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const normalResource = createInstance({ number: 'RESOURCE', type: 'resource' }, 0);
  const exResource = createInstance({ number: 'EX-RESOURCE', type: 'resource', isToken: true }, 0);

  player.resourceArea.push(normalResource);
  const withOnlyNormal = scoreState(state, 0);

  player.resourceArea.push(exResource);
  const withTokenAlso = scoreState(state, 0);

  // Both states have exactly 2 resources in play, so the plain `resources` count credit is the same
  // for both -- any extra gap between them is specifically the exResourceHeld premium for the token
  // still being unspent (not yet permanently lost, unlike a normal Resource that's merely rested).
  player.resourceArea.pop();
  const secondNormalInstead = createInstance({ number: 'RESOURCE', type: 'resource' }, 0);
  player.resourceArea.push(secondNormalInstead);
  const withTwoNormal = scoreState(state, 0);

  assert.ok(withTokenAlso > withOnlyNormal, 'holding the token should score higher than not having it at all');
  assert.ok(withTokenAlso > withTwoNormal, 'a token in play should score strictly higher than an equal-count all-normal resource area');
});

test('scoreState gives real, incremental credit for trash-threshold progress toward a trashSynergy-flagged card, not just a step at the threshold', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const lupus = createInstance({ number: 'LUP', type: 'unit', ap: 1, hp: 1, trashSynergy: { traits: ['Tekkadan'], threshold: 3 } }, 0);
  player.battleArea.push(lupus);

  const baseline = scoreState(state, 0);
  player.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['Tekkadan'] }, 0));
  const oneInTrash = scoreState(state, 0);
  player.trash.push(createInstance({ number: 'T2', type: 'unit', traits: ['Tekkadan'] }, 0));
  player.trash.push(createInstance({ number: 'T3', type: 'unit', traits: ['Tekkadan'] }, 0));
  const atThreshold = scoreState(state, 0);
  player.trash.push(createInstance({ number: 'T4', type: 'unit', traits: ['Tekkadan'] }, 0));
  const pastThreshold = scoreState(state, 0);

  assert.ok(oneInTrash > baseline, '1 of 3 needed cards in trash should already score higher than 0');
  assert.ok(atThreshold > oneInTrash, 'reaching the full threshold scores higher still');
  assert.equal(atThreshold, pastThreshold, 'credit is capped at the threshold -- a 4th card adds nothing further');
});

test('trashSynergyValue does not double-count across multiple copies of the same payoff card', () => {
  const synergy = { traits: ['Tekkadan'], threshold: 3 };
  const player = createPlayer(0);
  player.battleArea.push(createInstance({ number: 'LUP1', type: 'unit', ap: 1, hp: 1, trashSynergy: synergy }, 0));
  player.hand.push(createInstance({ number: 'LUP2', type: 'unit', ap: 1, hp: 1, trashSynergy: synergy }, 0));
  player.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['Tekkadan'] }, 0));

  const playerOneCopy = createPlayer(0);
  playerOneCopy.battleArea.push(createInstance({ number: 'LUP1', type: 'unit', ap: 1, hp: 1, trashSynergy: synergy }, 0));
  playerOneCopy.trash.push(createInstance({ number: 'T1', type: 'unit', traits: ['Tekkadan'] }, 0));

  assert.equal(trashSynergyValue(player), trashSynergyValue(playerOneCopy), 'a second copy of the same synergy card must not inflate the value further');
  assert.equal(trashSynergyValue(player), 1 / 3);
});

test('scoreState gives real credit for a damaged benefitsFromSelfDamage unit, not just a penalty for its lost HP', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const barbatos = createInstance({ number: 'BAR', type: 'unit', ap: 3, hp: 2, benefitsFromSelfDamage: true }, 0);
  player.battleArea.push(barbatos);

  const undamaged = scoreState(state, 0);
  dealDamage(barbatos, 1);
  const damaged = scoreState(state, 0);

  // 1 HP lost costs 1 point (boardStats weight 1); the damagedSynergy credit (weight 3) more than
  // offsets it -- confirms this isn't just "a smaller penalty," the state is scored as genuinely better.
  assert.equal(damaged - undamaged, DEFAULT_WEIGHTS.damagedSynergy - DEFAULT_WEIGHTS.boardStats);
  assert.ok(damaged > undamaged, 'a damaged benefitsFromSelfDamage unit should score higher than the same unit undamaged, not lower');
});

test('damagedSynergyValue only counts benefitsFromSelfDamage units that are currently damaged, and ignores hand/undamaged copies', () => {
  const player = createPlayer(0);
  const undamagedOnBoard = createInstance({ number: 'BAR1', type: 'unit', ap: 3, hp: 2, benefitsFromSelfDamage: true }, 0);
  const damagedOnBoard = createInstance({ number: 'BAR2', type: 'unit', ap: 3, hp: 2, benefitsFromSelfDamage: true }, 0);
  const damagedButUnflagged = createInstance({ number: 'PLAIN', type: 'unit', ap: 3, hp: 2 }, 0);
  player.battleArea.push(undamagedOnBoard, damagedOnBoard, damagedButUnflagged);
  dealDamage(damagedOnBoard, 1);
  dealDamage(damagedButUnflagged, 1);
  const inHand = createInstance({ number: 'BAR3', type: 'unit', ap: 3, hp: 2, benefitsFromSelfDamage: true }, 0);
  player.hand.push(inHand);

  assert.equal(damagedSynergyValue(player), 1);
});

test('reactiveReserveValue is 0 with no [Action]-timing Command in hand to hold Resources open for', () => {
  const player = createPlayer(0);
  for (let i = 0; i < 4; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  player.hand.push(createInstance({ number: 'MAIN', type: 'command', level: 1, cost: 1 }, 0)); // no actionTiming -- Main-phase only

  assert.equal(reactiveReserveValue(player), 0);
});

test("reactiveReserveValue credits min(active Resources, held card cost) once a real [Action]-timing Command is in hand", () => {
  const player = createPlayer(0);
  for (let i = 0; i < 4; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  player.hand.push(createInstance({ number: 'ACT', type: 'command', actionTiming: 'action', level: 3, cost: 2 }, 0));

  assert.equal(reactiveReserveValue(player), 2, "all 4 Resources are active, but credit is capped at the held card's own cost");
});

test("reactiveReserveValue is capped by active Resources, not just the held card's cost, once some are already spent", () => {
  const player = createPlayer(0);
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  const rested = createInstance({ number: 'R3', type: 'resource' }, 0);
  rested.rested = true;
  player.resourceArea.push(rested); // 4 total (Level satisfied), only 3 active
  player.hand.push(createInstance({ number: 'ACT', type: 'command', actionTiming: 'action', level: 4, cost: 2 }, 0));
  player.resourceArea.forEach((r, i) => { if (i < 2) r.rested = true; }); // tap 2 of the 3 active, only 1 left

  assert.equal(reactiveReserveValue(player), 1, 'only 1 Resource is actually still payable, even though the held card costs 2 and Level is met');
});

test("reactiveReserveValue ignores an [Action]-timing Command whose Level isn't met yet", () => {
  const player = createPlayer(0);
  for (let i = 0; i < 2; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  player.hand.push(createInstance({ number: 'ACT', type: 'command', actionTiming: 'action', level: 5, cost: 1 }, 0));

  assert.equal(reactiveReserveValue(player), 0);
});

test('reactiveReserveValue also counts an actionTiming "both" Command, not just "action"', () => {
  const player = createPlayer(0);
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  player.hand.push(createInstance({ number: 'BOTH', type: 'command', actionTiming: 'both', level: 1, cost: 1 }, 0));

  assert.equal(reactiveReserveValue(player), 1);
});

test('scoreState credits a player holding Resources open for a real [Action] Command via the reactiveReserve weight, when a nonzero weight is set', () => {
  // DEFAULT_WEIGHTS.reactiveReserve is 0 (see score.js's header comment -- tested negative via SPRT,
  // n=2543, self-play win rate didn't move). This test confirms the wiring itself still works via an
  // explicit aiWeights override, independent of what the shipped default happens to be.
  const player = createPlayer(0);
  player.aiWeights = { ...DEFAULT_WEIGHTS, reactiveReserve: 4 };
  const state = createGame(player, createPlayer(1));
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  player.hand.push(createInstance({ number: 'ACT', type: 'command', actionTiming: 'action', level: 1, cost: 2 }, 0));

  const withReserve = scoreState(state, 0);
  player.resourceArea.forEach((r) => { r.rested = true; }); // spend everything -- no active Resources left
  const tappedOut = scoreState(state, 0);

  assert.equal(withReserve - tappedOut, 4 * 2, 'losing the 2-cost reserve costs exactly reactiveReserve x 2');
});

test('runDeploysLookahead prefers two mid-cost Units over one big Unit when it adds up to more total board value', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  for (let i = 0; i < 4; i++) {
    player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource', color: 'blue' }, 0));
  }
  // Exactly enough resources for either the one big card alone, or both mid-cost cards together --
  // never all three. A purely greedy "always take the highest-cost affordable card first" heuristic
  // would take Big and never look back, stranding the leftover resource; the search should notice
  // A+B (combined AP4/HP4) beats Big alone (AP2/HP2) and take those instead.
  const big = createInstance({ number: 'BIG', type: 'unit', cost: 4, level: 4, color: 'blue', ap: 2, hp: 2 }, 0);
  const cardA = createInstance({ number: 'A', type: 'unit', cost: 2, level: 2, color: 'blue', ap: 2, hp: 2 }, 0);
  const cardB = createInstance({ number: 'B', type: 'unit', cost: 2, level: 2, color: 'blue', ap: 2, hp: 2 }, 0);
  player.hand.push(big, cardA, cardB);

  runDeploysLookahead(state, 0);

  assert.equal(player.battleArea.some((u) => u.def.number === 'A'), true);
  assert.equal(player.battleArea.some((u) => u.def.number === 'B'), true);
  assert.equal(player.hand.includes(big), true, 'Big should stay in hand -- it loses out to A+B');
});

test('runAttacksLookahead holds back a Blocker-keyword Unit rather than walking into a lethal counter-swing', () => {
  const player = createPlayer(0); // 0 shields, no base: any unblocked face hit is lethal
  const opponent = createPlayer(1);
  opponent.shields.push(
    createInstance({ number: 'OS1', type: 'unit' }, 1),
    createInstance({ number: 'OS2', type: 'unit' }, 1),
    createInstance({ number: 'OS3', type: 'unit' }, 1)
  );
  opponent.deck.push(
    createInstance({ number: 'D1', type: 'unit', cost: 1 }, 1),
    createInstance({ number: 'D2', type: 'unit', cost: 1 }, 1)
  );
  // The opponent-modeling fix nests one extra ply of lookahead: the simulated opponent's own attack
  // trials each additionally simulate a hypothetical turn after themselves to score the position,
  // which passes the turn back to the acting player and draws them a card -- an empty deck there is
  // an instant deck-out loss (7-3-1-1), unrelated to the combat scenario this test is actually
  // exercising, so the acting player needs a deck too now that the search reaches this deep.
  player.deck.push(
    createInstance({ number: 'PD1', type: 'unit', cost: 1 }, 0),
    createInstance({ number: 'PD2', type: 'unit', cost: 1 }, 0)
  );

  const state = createGame(player, opponent);
  state.turnNumber = 5;
  state.activePlayerIdx = 0;

  // hp comfortably above the threat's AP: if it attacks (and ends up rested), it must NOT become a
  // one-shot-killable "good trade" target for the threat's own attack-target selection, or the
  // opponent's heuristic would just kill it in the trade lane instead of revealing the face-swing
  // this scenario is actually testing.
  const blocker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 10, keywords: { blocker: true } });
  blocker.turnDeployed = 1; // deployed a prior turn, so it's not deploy-turn-restricted

  const threat = deployUnit(state, opponent, { number: 'T1', type: 'unit', ap: 5, hp: 5 });
  threat.turnDeployed = 1;
  threat.rested = false;

  runAttacksLookahead(state, 0, defaultHooks());

  assert.equal(blocker.rested, false, 'the lookahead should hold the Blocker back instead of attacking face');
});

test('chooseBlockerLookahead takes a free kill even when not facing lethal, unlike the plain rule-based chooseBlocker', () => {
  const defendingPlayer = createPlayer(0);
  const attackingPlayer = createPlayer(1);
  const state = createGame(defendingPlayer, attackingPlayer);
  defendingPlayer.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));

  const attacker = deployUnit(state, attackingPlayer, { number: 'ATK', type: 'unit', ap: 3, hp: 3 });
  const blocker = deployUnit(state, defendingPlayer, { number: 'BLK', type: 'unit', ap: 5, hp: 5, keywords: { blocker: true } });
  const target = { type: 'player' };

  assert.equal(
    chooseBlocker(defendingPlayer, attacker, target, attackingPlayer),
    null,
    'plain heuristic only blocks facing lethal (0 shields) or a bad Unit-target trade -- neither applies here'
  );

  const choice = chooseBlockerLookahead(state, defendingPlayer, attacker, target, attackingPlayer);
  assert.equal(choice, blocker, 'lookahead should still take the free kill instead of just eating the shield');
});

test('runCommandsLookahead picks the higher-value Command over resource-constrained hand order', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.resourceArea.push(createInstance({ number: 'R1', type: 'resource', color: 'blue' }, 0));
  player.resourceArea.push(createInstance({ number: 'R2', type: 'resource', color: 'blue' }, 0));
  deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 5 });

  // Only 2 resources total -- exactly enough for one Command, never both. Weak is deliberately
  // pushed into hand FIRST: plain runCommands (no value sorting, just hand-array order) would always
  // take it since it's playable[0], regardless of Strong being objectively better. Strong's effect
  // must resolve its target through the (possibly cloned) `s`/`p` it's given, not a closed-over
  // outer reference -- a trial that mutates the real enemy instance instead of its own clone's would
  // corrupt every subsequent trial (cloneState clones from whatever the real state looks like *now*).
  const weak = createInstance({ number: 'WEAK', type: 'command', cost: 2, level: 2, color: 'blue', effects: {} }, 0);
  const strong = createInstance(
    {
      number: 'STRONG',
      type: 'command',
      cost: 2,
      level: 2,
      color: 'blue',
      effects: { command: (s, p) => dealDamage(s.players[1 - s.players.indexOf(p)].battleArea[0], 3) }
    },
    0
  );
  player.hand.push(weak, strong);

  runCommandsLookahead(state, 0);

  assert.equal(player.trash.some((c) => c.def.number === 'STRONG'), true, 'Strong (damages the enemy Unit) should be chosen over Weak');
  assert.equal(player.hand.some((c) => c.def.number === 'WEAK'), true, 'Weak should stay in hand -- not affordable alongside Strong');
  assert.equal(opponent.battleArea[0].damage, 3);
});

test('runAttacksLookahead models the opponent turn with real lookahead (depth 1) instead of the cheap greedy policy, producing a more pessimistic (accurate) score', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  // Same resource-contention shape as the deploy-lookahead test above, just on the opponent's side:
  // exactly enough for either Big alone or A+B together (never all three). Greedy runDeploys always
  // takes Big first (highest cost) and never looks back; runDeploysLookahead correctly finds A+B
  // (combined AP4/HP4) beats Big alone (AP2/HP2).
  for (let i = 0; i < 4; i++) {
    opponent.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource', color: 'blue' }, 1));
  }
  const big = createInstance({ number: 'BIG', type: 'unit', cost: 4, level: 4, color: 'blue', ap: 2, hp: 2 }, 1);
  const cardA = createInstance({ number: 'A', type: 'unit', cost: 2, level: 2, color: 'blue', ap: 2, hp: 2 }, 1);
  const cardB = createInstance({ number: 'B', type: 'unit', cost: 2, level: 2, color: 'blue', ap: 2, hp: 2 }, 1);
  opponent.hand.push(big, cardA, cardB);

  const cheapClone = cloneState(state);
  runMainPhaseSimple(cheapClone, 1, defaultHooks());
  const cheapScore = scoreState(cheapClone, 0);

  const smartClone = cloneState(state);
  runMainPhase(smartClone, 1, lookaheadHooks(smartClone), 1); // depth 1: as if already the nested opponent-turn simulation
  const smartScore = scoreState(smartClone, 0);

  assert.equal(cheapClone.players[1].battleArea.some((u) => u.def.number === 'BIG'), true, 'sanity: cheap policy takes Big greedily');
  assert.equal(smartClone.players[1].battleArea.some((u) => u.def.number === 'A'), true, 'sanity: lookahead policy takes A+B instead');
  assert.equal(smartClone.players[1].battleArea.some((u) => u.def.number === 'B'), true);
  assert.ok(
    smartScore < cheapScore,
    'a lookahead-powered simulated opponent should build the higher-value board, making the acting player\'s position score worse (more accurately pessimistic) than the old cheap simulation predicted'
  );
});

test('runAttacksLookahead does not spawn another full opponent-turn search once already inside a simulated trial (depth >= 1), avoiding exponential blowup', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.turnNumber = 5;
  for (let i = 0; i < 6; i++) {
    const u = deployUnit(state, player, { number: 'U' + i, type: 'unit', ap: 2, hp: 2 });
    u.turnDeployed = 1;
  }

  const start = Date.now();
  // Called at depth 1, as if already nested inside another trial's simulated opponent turn -- must
  // stay cheap (fall back to the plain policy) rather than spawning another 64-branch search per branch.
  runAttacksLookahead(state, 0, defaultHooks(), 1);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `depth >= 1 attack search should stay cheap and terminate quickly, took ${elapsed}ms`);
});
