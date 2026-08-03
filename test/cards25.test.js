const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');

function noBlockHooks() {
  return { chooseBlocker: () => null, chooseBurst: () => false };
}

function fillResources(player, count) {
  for (let i = 0; i < count; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, player.id));
}

test('Gundam AGE-1 Titus GD02-031 AP+2 turns on and off as player Lv crosses 7, re-evaluated via the resourcePhase trigger', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { triggerEvent } = require('../src/rules/effects');

  const titus = deployUnit(state, player, lookupCard('GD02-031'));
  fillResources(player, 7);
  triggerEvent(state, 'resourcePhase', {});
  assert.equal(getAP(titus), 4, 'Lv.7 -- 2 base + 2');

  player.resourceArea = [];
  triggerEvent(state, 'resourcePhase', {});
  assert.equal(getAP(titus), 2, 'dropped back below Lv.7 -- no bonus');
});

test('Kikeroga (MA Mode) (GQ) GD02-033 gains Breach 5 only while another friendly (Zeon) Link Unit is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { triggerEvent } = require('../src/rules/effects');

  const kikeroga = deployUnit(state, player, lookupCard('GD02-033'));
  triggerEvent(state, 'startOfTurn', {});
  assert.ok(!getKeywords(kikeroga).breach, 'no other Zeon Link Unit yet');

  const zakuLink = deployUnit(state, player, { number: 'Z', type: 'unit', traits: ['Zeon'], ap: 1, hp: 1 });
  zakuLink.isLinkUnit = true;
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getKeywords(kikeroga).breach, 5);
});

test('GQuuuuuuX GD02-034 gets AP+2 only while paired with a red Pilot', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const gquux = deployUnit(state, player, lookupCard('GD02-034'));
  assert.equal(getAP(gquux), 0);

  pairPilot(state, player, gquux, createInstance({ number: 'P', type: 'pilot', color: 'green' }, 0));
  assert.equal(getAP(gquux), 0, 'paired but not a red Pilot');

  const redPilot = createInstance({ number: 'RP', type: 'pilot', color: 'red' }, 0);
  gquux.pilot = redPilot;
  assert.equal(getAP(gquux), 2);
});

test('Qubeley (LR+) GD02-036: When Linked gains Suppression during the turn; During Pair with a (Neo Zeon) Pilot, Attack deals 2 to a damaged enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const qubeley = deployUnit(state, player, lookupCard('GD02-036'));
  const neoZeonPilot = createInstance({ number: 'P', type: 'pilot', name: 'Haman Karn', traits: ['Neo Zeon'] }, 0);
  pairPilot(state, player, qubeley, neoZeonPilot);
  assert.ok(qubeley.isLinkUnit, 'Haman Karn satisfies this Unit\'s Link Condition');
  assert.ok(getKeywords(qubeley).suppression, 'When Linked granted Suppression this turn');

  const damaged = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  const undamaged = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5 });
  damaged.damage = 1;
  qubeley.turnDeployed = -1;
  resolveAttack(state, 0, qubeley, { type: 'unit', instance: undamaged }, noBlockHooks());

  assert.equal(damaged.damage, 3, '1 pre-existing + 2 from the Attack trigger');
});

test("Gundam Virsago (LR+) GD02-037: Breach 1, and Deploy deals 2 to a low-AP enemy Unit only while the opponent has 3 or fewer Shields", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const lowAP = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 5 });
  opponent.shields = opponent.shields.slice(0, 3);
  deployUnit(state, player, lookupCard('GD02-037'));
  assert.equal(lowAP.damage, 2);

  opponent.shields.push(createInstance({ number: 'S', type: 'shield' }, 1));
  const lowAP2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 4, hp: 5 });
  deployUnit(state, player, lookupCard('GD02-037'));
  assert.equal(lowAP2.damage, 0, '4 Shields now -- Deploy did not fire');
});

test("Haman Karn's Gaza C GD02-039: When Paired deals 1 damage to a Lv.3 or lower enemy Unit", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const lowLevel = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 3, ap: 1, hp: 3 });
  const gazaC = deployUnit(state, player, lookupCard('GD02-039'));
  pairPilot(state, player, gazaC, createInstance({ number: 'P', type: 'pilot' }, 0));

  assert.equal(lowLevel.damage, 1);
});

test("Gundam Ashtaron (R+) GD02-040: Support 2 (data), and Deploy grants a friendly (New UNE) Unit immunity to battle damage from 2-HP-or-lower enemies this turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const protectedUnit = deployUnit(state, player, { number: 'U', type: 'unit', traits: ['New UNE'], ap: 3, hp: 5 });
  deployUnit(state, player, lookupCard('GD02-040'));
  assert.equal(lookupCard('GD02-040').keywords.support, 2);

  const weakEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 2 });
  protectedUnit.turnDeployed = -1;
  resolveAttack(state, 0, protectedUnit, { type: 'unit', instance: weakEnemy }, noBlockHooks());
  assert.equal(protectedUnit.damage, 0, 'immune to the weak enemy\'s return damage');
  assert.equal(weakEnemy.damage, 3, 'still dealt its own battle damage out normally');
});

test("Sugai's Gelgoog (GQ) (R+) GD02-041: Deploy deals 2 damage to a Lv.5 or higher enemy Unit", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const highLevel = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 5, ap: 1, hp: 5 });
  deployUnit(state, player, lookupCard('GD02-041'));

  assert.equal(highLevel.damage, 2);
});

test('Gundam Ashtaron (MA Mode) GD02-042: Deploy grants a friendly (New UNE) Unit High-Maneuver during the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const other = deployUnit(state, player, { number: 'U', type: 'unit', traits: ['New UNE'], ap: 9, hp: 2 });
  deployUnit(state, player, lookupCard('GD02-042'));

  assert.ok(getKeywords(other).highManeuver, 'the heuristic picks the highest-AP (New UNE) Unit, including possibly itself, but here that\'s the other Unit');
});

test('Daughtress Weapon GD02-043 Deploy and Daughtress Command GD02-044 Destroyed each deploy a rested Daughtress token, but only with another friendly (New UNE) Unit already in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  deployUnit(state, player, lookupCard('GD02-043'));
  assert.equal(player.battleArea.filter((u) => u.def.name === 'Daughtress').length, 0, 'no other (New UNE) Unit yet');

  deployUnit(state, player, { number: 'U', type: 'unit', traits: ['New UNE'], ap: 1, hp: 1 });
  deployUnit(state, player, lookupCard('GD02-043'));
  const token = player.battleArea.find((u) => u.def.name === 'Daughtress');
  assert.ok(token, 'Daughtress Weapon deployed a token this time');
  assert.ok(token.rested, 'deployed rested');

  const command = deployUnit(state, player, lookupCard('GD02-044'));
  const { destroyAndFireEffect } = require('../src/rules/combat');
  command.damage = 999;
  destroyAndFireEffect(state, player, command);
  assert.equal(player.battleArea.filter((u) => u.def.name === 'Daughtress').length, 2, 'Command Destroyed deployed a second token');
});

test('GINN Long-Range Reconnaissance Type GD02-045 draws 1 only when attacking an enemy Unit with 5+ AP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const ginn = deployUnit(state, player, lookupCard('GD02-045'));
  ginn.turnDeployed = -1;
  ginn.buffs.push({ ap: 4 });
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5 });
  player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));

  resolveAttack(state, 0, ginn, { type: 'unit', instance: enemy }, noBlockHooks());
  assert.equal(player.hand.length, 1, 'drew 1 -- 5 AP and attacking a Unit');
});
