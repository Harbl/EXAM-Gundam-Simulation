const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot, playCommand } = require('../src/rules/actions');
const { resolveAttack } = require('../src/rules/combat');
const { runCommands } = require('../src/ai/heuristic');
const { getRemainingHP, getAP } = require('../src/rules/management');

test("Master Asia's Burst goes to hand normally, but deploys as an AP3/HP3 Unit once 3+ (MF) cards sit in the trash", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const masterAsia = lookupCard('GD05-089');

  const normalBurst = createInstance(masterAsia, 0);
  masterAsia.effects.burst(state, player, normalBurst);
  assert.equal(player.hand.includes(normalBurst), true, 'with no (MF) cards in trash, it just goes to hand');

  player.trash.push(
    createInstance({ number: 'MF1', type: 'unit', traits: ['MF'] }, 0),
    createInstance({ number: 'MF2', type: 'unit', traits: ['MF'] }, 0),
    createInstance({ number: 'MF3', type: 'unit', traits: ['MF'] }, 0)
  );
  const asUnit = createInstance(masterAsia, 0);
  masterAsia.effects.burst(state, player, asUnit);
  assert.equal(player.hand.includes(asUnit), false, 'this time it is deployed instead of added to hand');
  assert.equal(player.battleArea.includes(asUnit), true);
  assert.equal(asUnit.def.type, 'unit');
  assert.equal(asUnit.def.ap, 3);
  assert.equal(asUnit.def.hp, 3);
});

test("Master Asia's During-Link Attack trigger only fires after a (Special Move) Command's Main was activated this turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, linkCondition: 'Master Asia' });
  unit.turnDeployed = 0;
  const masterAsia = createInstance(lookupCard('GD05-089'), 0);
  pairPilot(state, player, unit, masterAsia);
  assert.equal(unit.isLinkUnit, true, "Master Asia's traits satisfy its own link condition");

  const enemy = createInstance({ number: 'E', type: 'unit', ap: 0, hp: 5 }, 1);
  opponent.battleArea.push(enemy);

  // Direct trigger invocation isolates the ability itself from the AP-damage arithmetic of a full attack.
  lookupCard('GD05-089').effects.attack(state, player, unit, {});
  assert.equal(getRemainingHP(enemy), 5, 'no Special Move Command was activated this turn, so no bonus damage');

  playCommand(state, player, lookupCard('GD05-110')); // Darkness Finger, a Special Move Command
  lookupCard('GD05-089').effects.attack(state, player, unit, {});
  assert.equal(getRemainingHP(enemy), 5 - 2 - 2, "Darkness Finger's own 2 damage plus Master Asia's 2 damage both landed");
});

test('Cyclone Punch debuffs an enemy Unit, then the AI pairs the spent card from trash onto a friendly (MF) Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'white' }, 0));

  const mfUnit = deployUnit(state, player, { number: 'MF-BODY', type: 'unit', ap: 2, hp: 2, traits: ['MF'] });
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 3, hp: 3 }, 1);
  opponent.battleArea.push(enemy);
  player.hand.push(createInstance(lookupCard('GD05-121'), 0));

  runCommands(state, player);

  assert.equal(getAP(enemy), 1, "Cyclone Punch's AP-2 Main resolved against the enemy Unit");
  assert.equal(mfUnit.pilot && mfUnit.pilot.def.number, 'GD05-121', 'Cyclone Punch paired itself from the trash onto the (MF) Unit');
  assert.equal(player.trash.some((c) => c.def.number === 'GD05-121'), false, 'no longer sitting in the trash once paired');
});

test('Gundam Exia Repair force-destroys a Lv.4-or-lower enemy Unit with no paired Pilot even when its AP alone would not kill it', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  const exia = deployUnit(state, player, lookupCard('GD05-050'));
  exia.turnDeployed = 0;
  const survivor = createInstance({ number: 'SURV', type: 'unit', level: 3, ap: 0, hp: 10 }, 1);
  opponent.battleArea.push(survivor);

  resolveAttack(state, 0, exia, { type: 'unit', instance: survivor }, {});
  assert.equal(opponent.battleArea.includes(survivor), false, 'destroyed outright despite only 2 AP vs 10 HP');
});

test('Gundam Barbatos 1st Form only draws on Attack if it is already carrying damage', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));

  const barbatos = deployUnit(state, player, lookupCard('GD02-054'));
  barbatos.turnDeployed = 0;
  barbatos.def.effects.attack(state, player, barbatos, {});
  assert.equal(player.hand.length, 0, 'undamaged, so no draw');

  barbatos.damage = 1;
  barbatos.def.effects.attack(state, player, barbatos, {});
  assert.equal(player.hand.length, 1, 'damaged, so it drew a card');
});
