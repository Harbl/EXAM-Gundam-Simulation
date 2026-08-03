const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { resolveAttack } = require('../src/rules/combat');
const {
  getRemainingHP,
  enforceHandLimit,
  enforceBattleAreaLimit,
  checkDefeat,
  destroyCard,
  removeFromField,
  sendToZone
} = require('../src/rules/management');
const { applyRepairAtEndOfTurn, activateSupport, clearTurnBuffs } = require('../src/rules/effects');
const { runDrawPhase } = require('../src/rules/phases');
const { initializeGame } = require('../src/rules/setup');

function unitDef(overrides = {}) {
  return Object.assign(
    { number: 'T-UNIT', name: 'Test Unit', type: 'unit', color: 'blue', level: 1, cost: 1, ap: 2, hp: 2, keywords: {} },
    overrides
  );
}

function makeMatch({ attackerDef, defenderDef, shields = 0, base = null } = {}) {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const attacker = createInstance(attackerDef || unitDef(), 0);
  attackingPlayer.battleArea.push(attacker);

  let defender = null;
  if (defenderDef) {
    defender = createInstance(defenderDef, 1);
    defendingPlayer.battleArea.push(defender);
  }
  for (let i = 0; i < shields; i++) {
    defendingPlayer.shields.push(createInstance({ number: `SH-${i}`, name: 'Shield', type: 'unit' }, 1));
  }
  if (base) defendingPlayer.base = createInstance(base, 1);

  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;
  return { state, attackingPlayer, defendingPlayer, attacker, defender };
}

test('simultaneous mutual destruction: both units die in a straight trade', () => {
  const { state, attackingPlayer, defendingPlayer, attacker, defender } = makeMatch({
    attackerDef: unitDef({ ap: 2, hp: 2 }),
    defenderDef: unitDef({ ap: 2, hp: 2 })
  });
  resolveAttack(state, 0, attacker, { type: 'unit', instance: defender });
  assert.equal(attackingPlayer.battleArea.length, 0);
  assert.equal(defendingPlayer.battleArea.length, 0);
  assert.ok(attackingPlayer.trash.includes(attacker));
  assert.ok(defendingPlayer.trash.includes(defender));
});

test('First Strike: a killed defender deals no return damage', () => {
  const { state, attackingPlayer, attacker, defender } = makeMatch({
    attackerDef: unitDef({ ap: 3, hp: 1, keywords: { firstStrike: true } }),
    defenderDef: unitDef({ ap: 2, hp: 2 })
  });
  resolveAttack(state, 0, attacker, { type: 'unit', instance: defender });
  assert.equal(attackingPlayer.battleArea.length, 1, 'attacker should survive untouched');
  assert.equal(getRemainingHP(attacker), 1);
});

test('First Strike that fails to kill still takes the return hit', () => {
  const { state, attackingPlayer, attacker, defender } = makeMatch({
    attackerDef: unitDef({ ap: 1, hp: 1, keywords: { firstStrike: true } }),
    defenderDef: unitDef({ ap: 2, hp: 5 })
  });
  resolveAttack(state, 0, attacker, { type: 'unit', instance: defender });
  assert.equal(attackingPlayer.battleArea.length, 0, 'attacker should die to the return hit');
  assert.equal(getRemainingHP(defender), 4);
});

test('Blocker redirects the attack to the declared blocker', () => {
  const { state, defendingPlayer, attacker } = makeMatch({ attackerDef: unitDef({ ap: 5 }), shields: 3 });
  const blocker = createInstance(unitDef({ hp: 10, keywords: { blocker: true } }), 1);
  defendingPlayer.battleArea.push(blocker);

  resolveAttack(state, 0, attacker, { type: 'player' }, { chooseBlocker: () => blocker });

  assert.equal(defendingPlayer.shields.length, 3, 'shields should be untouched, damage went to the blocker');
  assert.equal(getRemainingHP(blocker), 5);
  assert.equal(blocker.rested, true);
});

test('the original attack target cannot activate its own Blocker', () => {
  const { state, defender, attacker } = makeMatch({
    attackerDef: unitDef({ ap: 1 }),
    defenderDef: unitDef({ hp: 5, keywords: { blocker: true } })
  });
  assert.throws(() => {
    resolveAttack(state, 0, attacker, { type: 'unit', instance: defender }, { chooseBlocker: () => defender });
  });
});

test('High-Maneuver prevents the defender from activating Blocker', () => {
  const { state, defendingPlayer, attacker } = makeMatch({
    attackerDef: unitDef({ ap: 5, keywords: { highManeuver: true } }),
    shields: 2
  });
  const blocker = createInstance(unitDef({ hp: 10, keywords: { blocker: true } }), 1);
  defendingPlayer.battleArea.push(blocker);
  let blockerCalled = false;

  resolveAttack(state, 0, attacker, { type: 'player' }, { chooseBlocker: () => (blockerCalled = true) && blocker });

  assert.equal(blockerCalled, false, 'chooseBlocker hook should not even be consulted');
  assert.equal(defendingPlayer.shields.length, 1);
});

test('a destroyed Shield with a Burst effect only activates if chosen', () => {
  const { state, defendingPlayer, attacker } = makeMatch({ attackerDef: unitDef({ ap: 1 }) });
  let burstRan = false;
  defendingPlayer.shields.push(
    createInstance(
      {
        number: 'SH-BURST',
        name: 'Burst Shield',
        type: 'unit',
        effects: { burst: () => { burstRan = true; } }
      },
      1
    )
  );

  resolveAttack(state, 0, attacker, { type: 'player' }, { chooseBurst: () => false });
  assert.equal(burstRan, false);

  defendingPlayer.shields.push(
    createInstance(
      { number: 'SH-BURST2', name: 'Burst Shield', type: 'unit', effects: { burst: () => { burstRan = true; } } },
      1
    )
  );
  resolveAttack(state, 0, attacker, { type: 'player' }, { chooseBurst: () => true });
  assert.equal(burstRan, true);
});

test("a Burst effect that reads context.hooks (e.g. Unforeseen Incident's Command-style target choice) doesn't crash when revealed as a shield", () => {
  const { lookupCard } = require('../src/cards/index');
  const opponentUnit = unitDef({ number: 'E', ap: 4, hp: 4 });
  const { state, defendingPlayer, attacker } = makeMatch({ attackerDef: unitDef({ ap: 1 }) });
  const enemy = createInstance(opponentUnit, 0);
  state.players[0].battleArea.push(enemy); // the shield's own controller's opponent, from the attacker's side
  defendingPlayer.shields.push(createInstance(lookupCard('ST01-014'), 1));

  resolveAttack(state, 0, attacker, { type: 'player' }, { chooseBurst: () => true });

  assert.ok(enemy.buffs.some((b) => b.ap === -3), 'the Burst still resolved its effect instead of throwing on undefined context');
});

test('<Breach> damages the shield area even though the attack targeted a Unit', () => {
  const { state, defendingPlayer, attacker, defender } = makeMatch({
    attackerDef: unitDef({ ap: 5, keywords: { breach: 1 } }),
    defenderDef: unitDef({ hp: 1 }),
    shields: 3
  });
  resolveAttack(state, 0, attacker, { type: 'unit', instance: defender });
  assert.equal(defendingPlayer.shields.length, 2, 'one shield consumed by Breach');
});

test('hand limit discards down to 10 at end phase', () => {
  const player = createPlayer(0);
  for (let i = 0; i < 12; i++) player.hand.push(createInstance(unitDef({ number: `H-${i}` }), 0));
  enforceHandLimit(player);
  assert.equal(player.hand.length, 10);
  assert.equal(player.trash.length, 2);
});

test('battle area excess management trims to 6 without a Destroyed trigger', () => {
  const player = createPlayer(0);
  for (let i = 0; i < 7; i++) player.battleArea.push(createInstance(unitDef({ number: `U-${i}` }), 0));
  enforceBattleAreaLimit(player);
  assert.equal(player.battleArea.length, 6);
  assert.equal(player.trash.length, 1);
});

test('<Repair> recovers HP at end of turn, capped at 0 damage', () => {
  const player = createPlayer(0);
  const unit = createInstance(unitDef({ hp: 5, keywords: { repair: 3 } }), 0);
  unit.damage = 2;
  player.battleArea.push(unit);
  applyRepairAtEndOfTurn({}, player);
  assert.equal(unit.damage, 0);
});

test('<Support> rests the supporter and buffs another friendly unit for the turn', () => {
  const supporter = createInstance(unitDef({ keywords: { support: 2 } }), 0);
  const ally = createInstance(unitDef(), 0);
  activateSupport(supporter, ally);
  assert.equal(supporter.rested, true);
  assert.deepEqual(ally.buffs, [{ ap: 2, scope: 'turn' }]);
  clearTurnBuffs({ battleArea: [ally] });
  assert.equal(ally.buffs.length, 0);
});

test('drawing your last card is itself lethal (7-3-1-1)', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  state.players[0].deck = [createInstance(unitDef(), 0)];
  runDrawPhase(state);
  assert.equal(state.players[0].hand.length, 1);
  assert.equal(state.players[0].defeated, true);
});

test('being unable to draw at all is also lethal', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  state.players[0].deck = [];
  runDrawPhase(state);
  assert.equal(state.players[0].defeated, true);
});

test('a genuine simultaneous double-defeat is a draw, not an arbitrary winner (11-2-1)', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  state.players[0].defeated = true;
  state.players[1].defeated = true;
  checkDefeat(state);
  assert.equal(state.draw, true);
  assert.equal(state.winner, null, 'no arbitrary winner is picked for a genuine double-defeat');
});

test('a single defeated player still produces a normal winner, not a draw', () => {
  const state = createGame(createPlayer(0), createPlayer(1));
  state.players[0].defeated = true;
  checkDefeat(state);
  assert.equal(state.draw, false);
  assert.equal(state.winner, 1);
});

test('a destroyed token Unit is removed from the game instead of sitting in trash (5-17-2-5)', () => {
  const player = createPlayer(0);
  const token = createInstance(unitDef({ number: 'TOKEN-X', isToken: true }), 0);
  player.battleArea.push(token);
  destroyCard({}, player, token);
  assert.equal(player.battleArea.length, 0);
  assert.equal(player.trash.includes(token), false, 'a token should vanish, not sit in trash');
});

test('a destroyed token Unit\'s non-token paired Pilot still goes to trash normally', () => {
  const player = createPlayer(0);
  const pilot = createInstance({ number: 'P-1', name: 'Pilot', type: 'pilot' }, 0);
  const token = createInstance(unitDef({ number: 'TOKEN-X', isToken: true }), 0);
  token.pilot = pilot;
  player.battleArea.push(token);
  destroyCard({}, player, token);
  assert.equal(player.trash.includes(pilot), true, 'the real Pilot card still goes to trash');
  assert.equal(player.trash.includes(token), false);
});

test('removeFromField sends a bounced token to nowhere instead of into the destination zone', () => {
  const player = createPlayer(0);
  const token = createInstance(unitDef({ number: 'TOKEN-X', isToken: true }), 0);
  player.battleArea.push(token);
  removeFromField(player, token, player.hand);
  sendToZone(player.hand, token);
  assert.equal(player.hand.includes(token), false, 'a bounced token vanishes rather than entering hand');
});

test("a paired Pilot follows its Unit to the destination zone it's bounced to, not automatically trash (3-3-6)", () => {
  const player = createPlayer(0);
  const pilot = createInstance({ number: 'P-1', name: 'Pilot', type: 'pilot' }, 0);
  const unit = createInstance(unitDef(), 0);
  unit.pilot = pilot;
  player.battleArea.push(unit);
  removeFromField(player, unit, player.hand);
  assert.equal(player.hand.includes(pilot), true, 'the paired Pilot follows the Unit to hand');
  assert.equal(player.trash.includes(pilot), false);
  assert.equal(unit.pilot, null);
});

test('removeFromField still defaults an unbounded paired Pilot to trash when no destination is given', () => {
  const player = createPlayer(0);
  const pilot = createInstance({ number: 'P-1', name: 'Pilot', type: 'pilot' }, 0);
  const unit = createInstance(unitDef(), 0);
  unit.pilot = pilot;
  player.battleArea.push(unit);
  removeFromField(player, unit);
  assert.equal(player.trash.includes(pilot), true);
});

test('<Suppression> lets the defender choose the resolution order of two simultaneous Bursts (13-1-7-4)', () => {
  const { state, defendingPlayer, attacker } = makeMatch({
    attackerDef: unitDef({ ap: 5, keywords: { suppression: true } })
  });
  const order = [];
  const shieldA = createInstance(
    { number: 'SH-A', name: 'Shield A', type: 'unit', effects: { burst: () => order.push('A') } },
    1
  );
  const shieldB = createInstance(
    { number: 'SH-B', name: 'Shield B', type: 'unit', effects: { burst: () => order.push('B') } },
    1
  );
  defendingPlayer.shields.push(shieldA, shieldB);

  resolveAttack(state, 0, attacker, { type: 'player' }, {
    chooseBurst: () => true,
    chooseBurstOrder: (shields) => [...shields].reverse()
  });

  assert.deepEqual(order, ['B', 'A'], 'the defender-supplied order should be honored, not the fixed top-then-next order');
});

test('setup deals a 5-card hand, 6 shields, an EX Base each, and an EX Resource to Player Two only', () => {
  const main = Array.from({ length: 50 }, (_, i) => unitDef({ number: `M-${i}` }));
  const resource = Array.from({ length: 10 }, (_, i) => ({ number: `R-${i}`, name: 'Resource', type: 'resource', cost: 0, level: 0 }));
  const state = initializeGame(
    { main: [...main], resource: [...resource] },
    { main: [...main], resource: [...resource] },
    { decideFirstPlayerIdx: () => 0, decideMulligan: () => false }
  );
  const p1 = state.players[state.activePlayerIdx];
  const p2 = state.players[1 - state.activePlayerIdx];
  assert.equal(p1.hand.length, 5);
  assert.equal(p1.shields.length, 6);
  assert.equal(p1.deck.length, 50 - 5 - 6);
  assert.equal(p1.base.def.number, 'EX-BASE');
  assert.equal(p1.resourceArea.length, 0);
  assert.equal(p2.resourceArea.length, 1);
  assert.equal(p2.resourceArea[0].def.number, 'EX-RESOURCE');
});
