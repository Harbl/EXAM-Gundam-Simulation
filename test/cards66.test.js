const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const registry = require('../src/effects/registry');

function ggenTrash(player, count) {
  for (let i = 0; i < count; i++) player.trash.push(createInstance({ number: 'T' + i, type: 'unit', traits: ['G Generation'] }, 0));
}

test('Zeta Gundam (EX) ST10-001: destroysShield sets itself active and grants cannotAttackPlayer for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 5 });
  instance.rested = true;
  registry.zetaGundamEXST10001DestroysShield(state, player, instance);
  assert.equal(instance.rested, false);
  assert.equal(instance.buffs.some((b) => b.cannotAttackPlayer), true);
});

test('Zeta Gundam ST10-002: Deploy Development 2 exiles 2 (G Generation) trash cards to rest a 4-or-less-HP enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 4 });
  ggenTrash(player, 1);
  registry.zetaGundamST10002Deploy(state, player);
  assert.equal(target.rested, false, 'only 1 exilable card: not enough');

  ggenTrash(player, 1);
  registry.zetaGundamST10002Deploy(state, player);
  assert.equal(target.rested, true);
  assert.equal(player.trash.length, 0, 'both exiled');
});

test('Phoenix Gundam (Power Unleashed) (EX) ST10-006: During Pair, destroysEnemy bounces a 3-or-less-HP enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 4, hp: 4 });
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });

  registry.phoenixGundamPowerUnleashedEXDestroysEnemy(state, player, instance);
  assert.equal(opponent.battleArea.includes(target), true, 'not paired: no trigger');

  instance.pilot = createInstance({ number: 'P1', type: 'pilot', apBonus: 0, hpBonus: 0 }, 0);
  registry.phoenixGundamPowerUnleashedEXDestroysEnemy(state, player, instance);
  assert.equal(opponent.battleArea.includes(target), false);
  assert.equal(opponent.hand.includes(target), true);
});

test('Gundam Barbatos 4th Form ST10-007: whenLinked Development 2 exiles 2 to grab a Lv.4-or-lower Command from trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const cmd = createInstance({ number: 'C1', type: 'command', level: 4, cost: 1 }, 0);
  const tooHighCmd = createInstance({ number: 'C2', type: 'command', level: 5, cost: 1 }, 0);
  player.trash.push(cmd, tooHighCmd);
  ggenTrash(player, 2);
  registry.gundamBarbatos4thFormST10007WhenLinked(state, player);
  assert.equal(player.hand.includes(cmd), true);
  assert.equal(player.trash.includes(tooHighCmd), true, 'Lv.5 is out of range: stays in trash');
});

test('Gundam Barbatos 1st Form ST10-008: Deploy Development 2 exiles 2 to draw 1 then discard 1', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit', cost: 5 }, 0));
  player.hand.push(createInstance({ number: 'H1', type: 'unit', cost: 1 }, 0));
  ggenTrash(player, 2);
  registry.gundamBarbatos1stFormST10008Deploy(state, player);
  assert.equal(player.hand.length, 1);
  assert.equal(player.hand[0].def.number, 'H1');
  assert.equal(player.trash.some((c) => c.def.number === 'D1'), true);
});

test('Kamille Bidan ST10-011: whenLinked rests an at-or-below-level enemy Unit only with 2+ rested Units in play board-wide', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3, level: 4 });
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 4 });
  const tooHigh = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 5 });

  registry.kamilleBidanWhenLinked(state, player, unit);
  assert.equal(target.rested, false, 'fewer than 2 rested Units in play');

  target.rested = false;
  unit.rested = true;
  const padding = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  padding.rested = true;
  registry.kamilleBidanWhenLinked(state, player, unit);
  assert.equal(target.rested, true);
  assert.equal(tooHigh.rested, false, 'Lv.5 exceeds this Unit\'s own Lv.4');
});

test('Mark Guilder ST10-012: whenPaired gives a Lv.5-or-lower enemy AP-2', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 5 });
  registry.markGuilderWhenPaired(state, player);
  assert.equal(target.buffs.some((b) => b.ap === -2), true);
});

test('Tactical Training ST10-013: Burst adds to hand; Command heals+buffs a Lv.5+ (G Generation) Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const instance = createInstance({ number: 'C1', type: 'command' }, 0);
  registry.tacticalTrainingBurst(state, player, instance);
  assert.equal(player.hand.includes(instance), true);

  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 6, traits: ['G Generation'], level: 5 });
  target.damage = 3;
  registry.tacticalTrainingCommand(state, player, null, {});
  assert.equal(target.damage, 1);
  assert.equal(target.buffs.some((b) => b.ap === 2), true);
});

test('Unlocking the Development Diagram ST10-014: Command draws 2', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  registry.unlockingTheDevelopmentDiagramCommand(state, player);
  assert.equal(player.hand.length, 2);
});

test('Diffuse Beam Cannon ST10-015: Command gives an enemy AP-3 for the battle, gated on a friendly (G Generation) Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 4, hp: 4 });
  registry.diffuseBeamCannonCommand(state, player);
  assert.equal(target.buffs.some((b) => b.ap === -3), false, 'no G Generation Unit in play yet');

  deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['G Generation'] });
  registry.diffuseBeamCannonCommand(state, player);
  assert.equal(target.buffs.some((b) => b.ap === -3 && b.scope === 'battle'), true);
});

test('Luna Mana & Carry Base ST10-016: Deploy adds a shield to hand and heals all friendly (G Generation) Units 1', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));
  const ggenUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 3, traits: ['G Generation'] });
  ggenUnit.damage = 2;
  const nonGgenUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 3 });
  nonGgenUnit.damage = 2;
  registry.lunaManaCarryBaseDeploy(state, player);
  assert.equal(player.hand.length, 1);
  assert.equal(ggenUnit.damage, 1);
  assert.equal(nonGgenUnit.damage, 2, 'non-(G Generation) Unit not healed');
});
