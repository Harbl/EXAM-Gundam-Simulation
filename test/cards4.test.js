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
