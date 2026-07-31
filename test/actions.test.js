const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, becomeBase, pairPilot } = require('../src/rules/actions');
const { resolveAttack } = require('../src/rules/combat');

function unitDef(overrides = {}) {
  return Object.assign(
    { number: 'T-UNIT', name: 'Test Unit', type: 'unit', color: 'blue', level: 1, cost: 1, ap: 2, hp: 2, keywords: {} },
    overrides
  );
}

test('deployUnit fires the Deploy effect and adds the unit to the battle area', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  let deployedInstance = null;
  const def = unitDef({ effects: { deploy: (s, p, instance) => { deployedInstance = instance; } } });

  const unit = deployUnit(state, player, def);

  assert.equal(player.battleArea.includes(unit), true);
  assert.equal(deployedInstance, unit);
});

test('deployBase replaces an existing Base untouched into the trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const oldBase = createInstance({ number: 'OLD', type: 'base', ap: 0, hp: 3 }, 0);
  player.base = oldBase;

  const newBase = deployBase(state, player, { number: 'NEW', type: 'base', ap: 0, hp: 3 });

  assert.equal(player.base, newBase);
  assert.ok(player.trash.includes(oldBase));
});

test('becomeBase reuses the same instance rather than creating a new one', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const shieldCardComingUp = createInstance({ number: 'JABURO', type: 'base', ap: 0, hp: 5 }, 0);

  const result = becomeBase(state, player, shieldCardComingUp);

  assert.equal(result, shieldCardComingUp);
  assert.equal(player.base, shieldCardComingUp);
});

test('pairPilot removes the Pilot from hand, sets pairing, and fires When Paired on both cards', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = createInstance(unitDef({ linkCondition: 'Char Aznable' }), 0);
  player.battleArea.push(unit);

  let unitSawPaired = false;
  let pilotSawPaired = false;
  const pilot = createInstance(
    {
      number: 'PILOT-1',
      name: 'Char Aznable',
      type: 'pilot',
      apBonus: 1,
      hpBonus: 1,
      effects: { whenPaired: () => { pilotSawPaired = true; } }
    },
    0
  );
  unit.def = Object.assign({}, unit.def, { effects: { whenPaired: () => { unitSawPaired = true; } } });
  player.hand.push(pilot);

  pairPilot(state, player, unit, pilot);

  assert.equal(unit.pilot, pilot);
  assert.equal(player.hand.includes(pilot), false);
  assert.equal(unitSawPaired, true);
  assert.equal(pilotSawPaired, true);
  assert.equal(unit.isLinkUnit, true, 'pilot name matches the link condition');
});

test('pairPilot only fires When Linked when the link condition is actually met', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = createInstance(unitDef({ linkCondition: 'Char Aznable' }), 0);
  player.battleArea.push(unit);
  let linkedFired = false;
  unit.def = Object.assign({}, unit.def, { effects: { whenLinked: () => { linkedFired = true; } } });

  const nonMatchingPilot = createInstance({ number: 'PILOT-2', name: 'Some Other Pilot', type: 'pilot' }, 0);
  player.hand.push(nonMatchingPilot);
  pairPilot(state, player, unit, nonMatchingPilot);

  assert.equal(unit.isLinkUnit, false);
  assert.equal(linkedFired, false);
});

test('a Destroyed effect knows whether the card was paired when it died', () => {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;

  const attacker = createInstance(unitDef({ ap: 5 }), 0);
  attackingPlayer.battleArea.push(attacker);

  let sawWasPaired = null;
  const defender = createInstance(
    unitDef({ hp: 1, effects: { destroyed: (s, p, instance, ctx) => { sawWasPaired = ctx.wasPaired; } } }),
    1
  );
  defendingPlayer.battleArea.push(defender);
  const pilot = createInstance({ number: 'PILOT-3', name: 'Some Pilot', type: 'pilot' }, 1);
  pairPilot(state, defendingPlayer, defender, pilot);

  resolveAttack(state, 0, attacker, { type: 'unit', instance: defender });

  assert.equal(sawWasPaired, true);
  assert.ok(defendingPlayer.trash.includes(pilot), 'the paired pilot moves to trash with the unit (3-3-6)');
});

test('a Burst effect that relocates the card to hand is not also dropped into the trash', () => {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;

  const attacker = createInstance(unitDef({ ap: 1 }), 0);
  attackingPlayer.battleArea.push(attacker);
  const burstShield = createInstance(
    { number: 'BURST-HAND', name: 'Amuro-style Shield', type: 'unit', effects: { burst: (s, p, instance) => p.hand.push(instance) } },
    1
  );
  defendingPlayer.shields.push(burstShield);

  resolveAttack(state, 0, attacker, { type: 'player' }, { chooseBurst: () => true });

  assert.equal(defendingPlayer.hand.includes(burstShield), true);
  assert.equal(defendingPlayer.trash.includes(burstShield), false);
});
