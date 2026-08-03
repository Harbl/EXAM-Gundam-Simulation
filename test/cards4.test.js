const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { resolveAttack } = require('../src/rules/combat');

test('Master Gundam exiles 2 trashed Special Move Commands on Attack to hit the shield area directly for 5, independent of the declared target', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  player.trash.push(
    createInstance({ number: 'SM1', type: 'command', traits: ['Special Move'] }, 0),
    createInstance({ number: 'SM2', type: 'command', traits: ['Special Move'] }, 0)
  );
  opponent.shields.push(createInstance({ number: 'SH', type: 'unit' }, 1));

  const master = deployUnit(state, player, lookupCard('GD05-033'));
  master.turnDeployed = 0;
  const decoyEnemy = createInstance({ number: 'D', type: 'unit', ap: 0, hp: 100, rested: true }, 1);
  decoyEnemy.rested = true;
  opponent.battleArea.push(decoyEnemy);

  resolveAttack(state, 0, master, { type: 'unit', instance: decoyEnemy }, {});

  assert.equal(player.trash.length, 0, 'both Special Move cards were exiled');
  assert.equal(player.removal.length, 2);
  assert.equal(opponent.shields.length, 0, 'the shield area took 5 damage directly, on top of the declared attack');
});

test('Domon Kasshu discards a Special Move Command drawn via his own When Paired trigger and gets its Main for free', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit' });
  player.deck.push(createInstance({ number: 'SM', type: 'command', cost: 99, traits: ['Special Move'], effects: {
    command: (s, p) => { p.trash.push(createInstance({ number: 'MARK', type: 'unit' }, p.id)); }
  } }, 0));
  const domon = createInstance(lookupCard('GD05-097'), 0);

  const { pairPilot } = require('../src/rules/actions');
  pairPilot(state, player, unit, domon);

  assert.equal(player.trash.some((c) => c.def.number === 'SM'), true, 'the drawn Special Move command was the discard (highest cost)');
  assert.equal(player.trash.some((c) => c.def.number === 'MARK'), true, "its Main effect fired for free despite being in the trash");
});

test('Domon Kasshu deliberately discards a (Special Move) Command even when a costlier non-Special-Move card is also in hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit' });
  // A much pricier Unit sitting in hand -- the old highest-cost-only heuristic would discard THIS
  // instead, missing the real card's "if you discard a (Special Move) Command, activate its Main" bonus.
  const pricierUnit = createInstance({ number: 'BIG', type: 'unit', cost: 8 }, 0);
  player.hand.push(pricierUnit);
  player.deck.push(createInstance({ number: 'SM', type: 'command', cost: 1, traits: ['Special Move'], effects: {
    command: (s, p) => { p.trash.push(createInstance({ number: 'MARK', type: 'unit' }, p.id)); }
  } }, 0));
  const domon = createInstance(lookupCard('GD05-097'), 0);

  const { pairPilot } = require('../src/rules/actions');
  pairPilot(state, player, unit, domon);

  assert.equal(player.trash.some((c) => c.def.number === 'SM'), true, 'discarded the low-cost Special Move card on purpose, not the pricier Unit');
  assert.equal(player.hand.includes(pricierUnit), true, 'kept the pricier non-Special-Move card in hand');
  assert.equal(player.trash.some((c) => c.def.number === 'MARK'), true, 'its Main effect fired for free');
});

test('Gundam Barbatos Adapt damages a benefitsFromSelfDamage Unit (Gundam Barbatos 1st Form) over a tankier Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  // Tankier than Barbatos 1st Form -- the old highest-HP-only default would pick this instead.
  const tankyUnit = deployUnit(state, player, { number: 'TANK', type: 'unit', hp: 10 });
  const barbatos1stForm = deployUnit(state, player, lookupCard('GD02-054'));
  opponent.battleArea.push(createInstance({ number: 'E', type: 'unit', hp: 3 }, 1));

  const barbatosAdapt = createInstance(lookupCard('GD03-056'), 0);
  barbatosAdapt.def.effects.deploy(state, player, barbatosAdapt, {});

  assert.equal(barbatos1stForm.damage, 1, 'deliberately damaged the self-damage payoff Unit');
  assert.equal(tankyUnit.damage, 0, 'left the tankier Unit untouched');
});
