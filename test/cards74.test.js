const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot, playCommand } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { runStartPhase } = require('../src/rules/phases');
const { fireDestroysShield } = require('../src/rules/combat');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// GD06 "Stardust Trails" -- White Units (GD06-064 through GD06-079). Covers Shining Gundam's
// reuse of the existing friendlyPlaysCommand broadcast for a "when you activate a (Special Move)
// Command" trigger, plus a spot-check of the rest of this slice (Activate*Main/Action wiring,
// destroysShield reaction, skipNextUntap reuse).

test('Altron Gundam (EW) GD06-064 gets AP+3 only while an enemy Unit Lv.5+ is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const altron = deployUnit(state, player, lookupCard('GD06-064'));
  runStartPhase(state);
  assert.equal(getAP(altron), 3);

  deployUnit(state, opponent, { number: 'E', type: 'unit', level: 5, ap: 1, hp: 1 });
  runStartPhase(state);
  assert.equal(getAP(altron), 6);
});

test('SUMO Gold Type GD06-065: Activate*Main pays (4) to set all friendly Blocker (Dianna Counter)/(Militia) Units active, locking them from attacking', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const sumo = deployUnit(state, player, lookupCard('GD06-065'));
  for (let i = 0; i < 4; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  const blocker = deployUnit(state, player, { number: 'B', type: 'unit', ap: 1, hp: 1, traits: ['Dianna Counter'], keywords: { blocker: true } });
  blocker.rested = true;
  const nonBlocker = deployUnit(state, player, { number: 'N', type: 'unit', ap: 1, hp: 1, traits: ['Dianna Counter'] });
  nonBlocker.rested = true;

  const result = registry.sumoGoldTypeGD06065ActivateMain(state, player, sumo);
  assert.equal(result, true);
  assert.equal(player.resourceArea.every((r) => r.rested), true);
  assert.equal(blocker.rested, false, 'Blocker Unit set active');
  assert.equal(blocker.buffs.some((b) => b.cannotAttack), true, "but can't attack this turn");
  assert.equal(nonBlocker.rested, true, 'non-Blocker Unit untouched');
});

test("Gundam Sandrock Custom (EW) GD06-067: When Paired with a Lv.4+ Pilot, locks a rested low-HP enemy's next untap", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const sandrock = deployUnit(state, player, lookupCard('GD06-067'));
  const target = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 3 });
  target.damage = 1;
  target.rested = true;

  pairPilot(state, player, sandrock, createInstance({ number: 'P1', type: 'pilot', level: 3 }, 0));
  assert.equal(target.skipNextUntap, undefined, 'Lv.3 Pilot -- too low, no effect');

  const sandrock2 = deployUnit(state, player, lookupCard('GD06-067'));
  pairPilot(state, player, sandrock2, createInstance({ number: 'P2', type: 'pilot', level: 4 }, 0));
  assert.equal(target.skipNextUntap, true, 'Lv.4 Pilot -- locked');
});

test('Shadow Gundam GD06-066: During Link, Attack invokes the paired card\'s own Activate*Action directly -- a no-op for either real link target (Domon Kasshu/Master Asia, neither of which has one), but correct once a linkable Pilot does', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const shadowGundam = deployUnit(state, player, lookupCard('GD06-066'));

  registry.shadowGundamGD06066Attack(state, player, shadowGundam);
  assert.equal(shadowGundam.damage, 0, 'not even paired yet -- no crash, no effect');

  pairPilot(state, player, shadowGundam, createInstance(lookupCard('GD05-097'), 0)); // Domon Kasshu: Gundam Fighter trait, no activateAction
  registry.shadowGundamGD06066Attack(state, player, shadowGundam);
  assert.equal(shadowGundam.isLinkUnit, true, 'Domon Kasshu matches the Gundam Fighter link condition');

  let invoked = false;
  shadowGundam.pilot.def = { ...shadowGundam.pilot.def, effects: { activateAction: () => { invoked = true; } } };
  registry.shadowGundamGD06066Attack(state, player, shadowGundam);
  assert.equal(invoked, true, 'once the paired card actually has an Activate*Action, it fires automatically on attack');
});

test('SUMO Silver Type GD06-069: Activate*Action pays (1) to heal a damaged friendly (Dianna Counter) Unit, once per turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const sumo = deployUnit(state, player, lookupCard('GD06-069'));
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 0));
  const target = deployUnit(state, player, { number: 'D', type: 'unit', ap: 1, hp: 5, traits: ['Dianna Counter'] });
  target.damage = 3;

  const result = registry.sumoSilverTypeGD06069ActivateAction(state, player, sumo, { target });
  assert.equal(result, true);
  assert.equal(target.damage, 2);
  assert.equal(player.resourceArea[0].rested, true);
  assert.equal(registry.sumoSilverTypeGD06069ActivateAction(state, player, sumo, { target }), false, 'once per turn');
});

test('Eagail GD06-070: Deploy adds a Gozzo token, and Attack debuffs AP-5 only after paying 3+ total for effects this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('GD06-070'));
  registry.eagailGD06070Deploy(state, player);
  assert.ok(player.battleArea.some((u) => u.def.name === 'Gozzo'));

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 5, hp: 5 });
  registry.eagailGD06070Attack(state, player);
  assert.equal(getAP(enemy), 5, 'nothing paid yet -- no debuff');

  player.abilityCostsPaidThisTurn = [{ source: null, amount: 3 }];
  registry.eagailGD06070Attack(state, player);
  assert.equal(getAP(enemy), 0);
});

test('Shining Gundam (Meikyo Shisui) GD06-071: reacts once per turn to playing a (Special Move) Command', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const shining = deployUnit(state, player, lookupCard('GD06-071'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 5 });
  player.hand.push(createInstance({ number: 'SPECIAL', type: 'command', level: 1, cost: 0, traits: ['Special Move'] }, 0));
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 0));

  playCommand(state, player, player.hand[0].def);
  assert.equal(getAP(shining), 6, 'AP+2 after the (Special Move) Command resolves');
  assert.equal(getAP(enemy), 1, 'enemy AP-2');

  player.hand.push(createInstance({ number: 'SPECIAL2', type: 'command', level: 1, cost: 0, traits: ['Special Move'] }, 0));
  playCommand(state, player, player.hand[0].def);
  assert.equal(getAP(shining), 6, 'once per turn -- no stacking');
});

test('Wing Gundam Zero (EW) GD06-073: Destroyed-shield reaction rests a low-level enemy, once per turn, only while paired', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const wingZero = deployUnit(state, player, lookupCard('GD06-073'));
  const target = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 2, ap: 1, hp: 1 });

  fireDestroysShield(state, player, wingZero);
  assert.equal(target.rested, false, 'not paired yet -- no effect');

  pairPilot(state, player, wingZero, createInstance({ number: 'P', type: 'pilot' }, 0));
  fireDestroysShield(state, player, wingZero);
  assert.equal(target.rested, true);
});

test('WaD GD06-078: Activate*Main pays (3) + rests itself to Rest a Lv.4-or-lower enemy, only with another (Dianna Counter) ally', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const waD = deployUnit(state, player, lookupCard('GD06-078'));
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
  const target = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 4, ap: 1, hp: 1 });

  assert.equal(registry.waDGD06078ActivateMain(state, player, waD), false, 'no (Dianna Counter) ally yet');

  deployUnit(state, player, { number: 'ALLY', type: 'unit', ap: 1, hp: 1, traits: ['Dianna Counter'] });
  assert.equal(registry.waDGD06078ActivateMain(state, player, waD), true);
  assert.equal(target.rested, true);
  assert.equal(waD.rested, true);
  assert.equal(player.resourceArea.every((r) => r.rested), true);
});
