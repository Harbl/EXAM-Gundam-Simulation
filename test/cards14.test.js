const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { runStartPhase, runEndPhase } = require('../src/rules/phases');

test('Gundam Exia (ST07-001) When Paired mills 2 and only draws if a (CB) card was among them; End of turn untaps a Resource once 7+ (CB) cards are in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(
    createInstance({ number: 'D1', type: 'unit', traits: ['Earth Federation'] }, 0),
    createInstance({ number: 'D2', type: 'unit', traits: ['Earth Federation'] }, 0)
  );
  const exia = deployUnit(state, player, lookupCard('ST07-001'));
  pairPilot(state, player, exia, createInstance({ number: 'P', type: 'pilot' }, 0));
  assert.equal(player.hand.length, 0, 'no (CB) card milled, no draw');
  assert.equal(player.trash.length, 2);

  for (let i = 0; i < 6; i++) player.trash.push(createInstance({ number: `X${i}`, type: 'unit', traits: ['CB'] }, 0));
  assert.equal(player.trash.filter((c) => (c.def.traits || []).includes('CB')).length, 6, 'still below 7');
  const resource = createInstance({ number: 'R', type: 'resource' }, 0);
  resource.rested = true;
  player.resourceArea.push(resource);
  runEndPhase(state);
  assert.equal(resource.rested, true, 'below 7 (CB) cards in trash, no untap');

  player.trash.push(createInstance({ number: 'X6', type: 'unit', traits: ['CB'] }, 0));
  runEndPhase(state);
  assert.equal(resource.rested, false, '7+ (CB) cards in trash, untap');
});

test('Gundam Virtue (ST07-004) gains Blocker only while a (CB) Pilot is paired somewhere on the field', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const virtue = deployUnit(state, player, lookupCard('ST07-004'));
  runStartPhase(state);
  assert.equal(getKeywords(virtue).blocker, false, 'no (CB) Pilot in play yet');

  const otherUnit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, otherUnit, createInstance({ number: 'P', type: 'pilot', traits: ['CB'] }, 0));
  runStartPhase(state);
  assert.equal(getKeywords(virtue).blocker, true);
});

test('Setsuna F. Seiei (ST07-009) Attack grants AP+1 to itself normally, or AP+1 to every (CB) Unit once 7+ (CB) cards are in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', traits: ['CB'], ap: 2, hp: 2 });
  const otherCB = deployUnit(state, player, { number: 'U2', type: 'unit', traits: ['CB'], ap: 1, hp: 1 });
  pairPilot(state, player, unit, createInstance(lookupCard('ST07-009'), 0));

  lookupCard('ST07-009').effects.attack(state, player, unit);
  assert.equal(getAP(unit), 5, 'below 7 (CB) in trash: only this Unit gets AP+1 (base 2 + pilot apBonus 2 + 1)');
  assert.equal(getAP(otherCB), 1);

  for (let i = 0; i < 7; i++) player.trash.push(createInstance({ number: `X${i}`, type: 'unit', traits: ['CB'] }, 0));
  lookupCard('ST07-009').effects.attack(state, player, unit);
  assert.equal(getAP(otherCB), 2, '7+ (CB) in trash: every (CB) Unit gets AP+1 instead');
});

test('Ptolemaios (ST07-015) adds a Shield to hand on Deploy and resists Lv.3-or-lower battle damage while a rested (CB) Unit is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  deployBase(state, player, lookupCard('ST07-015'));
  assert.equal(player.hand.length, 1, 'Shield added to hand on Deploy');

  const weakAttacker = createInstance({ number: 'A1', type: 'unit', level: 3, ap: 1, hp: 4 }, 1);
  const strongAttacker = createInstance({ number: 'A2', type: 'unit', level: 4, ap: 1, hp: 4 }, 1);
  opponent.battleArea.push(weakAttacker, strongAttacker);

  resolveAttack(state, 1, weakAttacker, { type: 'player' }, {});
  assert.equal(player.base.damage, 1, 'no rested (CB) Unit yet, damage goes through normally');

  const cbUnit = deployUnit(state, player, { number: 'CB1', type: 'unit', traits: ['CB'], ap: 1, hp: 1 });
  cbUnit.rested = true;
  resolveAttack(state, 1, weakAttacker, { type: 'player' }, {});
  assert.equal(player.base.damage, 1, 'Lv.3 attacker resisted while a rested (CB) Unit is in play');

  resolveAttack(state, 1, strongAttacker, { type: 'player' }, {});
  assert.equal(player.base.damage, 2, 'Lv.4 attacker is above the cap, damage goes through');
});

test('Gundam Exia (Trans-Am) (GD03-049) destroys the lowest-HP enemy Unit on destroying a Shield, only once 10+ (CB) cards are in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.trash.push(...Array.from({ length: 9 }, (_, i) => createInstance({ number: `X${i}`, type: 'unit', traits: ['CB'] }, 0)));
  opponent.shields.push(createInstance({ number: 'S', type: 'unit' }, 1));
  const weakEnemy = createInstance({ number: 'E1', type: 'unit', ap: 1, hp: 3 }, 1);
  const toughEnemy = createInstance({ number: 'E2', type: 'unit', ap: 1, hp: 9 }, 1);
  opponent.battleArea.push(toughEnemy, weakEnemy);

  const exia = deployUnit(state, player, lookupCard('GD03-049'));
  resolveAttack(state, 0, exia, { type: 'player' }, {});
  assert.equal(opponent.battleArea.includes(weakEnemy), true, 'below 10 (CB) in trash, no bonus destroy');

  player.trash.push(createInstance({ number: 'X9', type: 'unit', traits: ['CB'] }, 0));
  opponent.shields.push(createInstance({ number: 'S2', type: 'unit' }, 1));
  resolveAttack(state, 0, exia, { type: 'player' }, {});
  assert.equal(opponent.battleArea.includes(weakEnemy), false, '10+ (CB) in trash: lowest-HP enemy Unit destroyed');
  assert.equal(opponent.battleArea.includes(toughEnemy), true);
});

test('Gundam Kyrios (GD04-034) gets AP+2 per rested (CB) Unit on Attack, only while a Link Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const kyrios = deployUnit(state, player, lookupCard('GD04-034'));
  const restedCB1 = deployUnit(state, player, { number: 'C1', type: 'unit', traits: ['CB'], ap: 1, hp: 1 });
  const restedCB2 = deployUnit(state, player, { number: 'C2', type: 'unit', traits: ['CB'], ap: 1, hp: 1 });
  restedCB1.rested = true;
  restedCB2.rested = true;

  lookupCard('GD04-034').effects.attack(state, player, kyrios);
  assert.equal(getAP(kyrios), 1, 'not a Link Unit yet, no bonus');

  pairPilot(state, player, kyrios, createInstance({ number: 'P', type: 'pilot', name: 'Allelujah Haptism' }, 0));
  assert.equal(kyrios.isLinkUnit, true);
  lookupCard('GD04-034').effects.attack(state, player, kyrios);
  assert.equal(getAP(kyrios), 5, '2 rested (CB) Units: AP 1 base + 2*2 = 5');
});

test("Nena Trinity (GD04-089) Activate*Main is Support 2: rests the paired Unit and buffs another friendly Unit's AP by 2", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD04-089'), 0));

  const ok = lookupCard('GD04-089').effects.activateMain(state, player, unit, { target: ally });
  assert.equal(ok, true);
  assert.equal(unit.rested, true);
  assert.equal(getAP(ally), 3);
});

test('Hallelujah Haptism (GD04-090) peeks the top card on an own-turn kill, keeping it only if it\'s a (CB) card, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD04-090'), 0));
  player.deck.push(
    createInstance({ number: 'D1', type: 'unit', traits: ['Earth Federation'] }, 0),
    createInstance({ number: 'D2', type: 'unit', traits: ['CB'] }, 0)
  );

  lookupCard('GD04-090').effects.destroysEnemy(state, player, unit);
  assert.equal(player.hand.length, 0, 'top card was not a (CB) card, returned to bottom of deck');
  assert.equal(player.deck.length, 2, 'peeked card returned to the deck, net count unchanged');
  assert.equal(player.deck[player.deck.length - 1].def.number, 'D1', 'D1 sent to the bottom, D2 now on top');

  unit.activationsUsed = {};
  lookupCard('GD04-090').effects.destroysEnemy(state, player, unit);
  assert.equal(player.hand.length, 1, '(CB) card revealed to hand');
  assert.equal(player.deck.length, 1, 'D1 remains, D2 left the deck for hand');
});

test('Overwhelming Pressure (GD04-109) deals 4 damage to an enemy Unit Lv.6 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooHigh = createInstance({ number: 'E1', type: 'unit', level: 7, ap: 1, hp: 9 }, 1);
  const target = createInstance({ number: 'E2', type: 'unit', level: 6, ap: 1, hp: 9 }, 1);
  opponent.battleArea.push(tooHigh, target);

  lookupCard('GD04-109').effects.command(state, player, createInstance(lookupCard('GD04-109'), 0), {});
  assert.equal(tooHigh.damage, 0);
  assert.equal(target.damage, 4);
});

test('Gundam Throne Eins (GD05-038) gains Suppression on Deploy only as a Link Unit; Activate*Main rests 3 (CB) Units once per turn to deal 4 damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const einsUnlinked = deployUnit(state, player, lookupCard('GD05-038'));
  assert.equal(getKeywords(einsUnlinked).suppression, undefined, 'not a Link Unit, no Suppression');

  player.battleArea = [];
  player.hand.push(createInstance({ number: 'P', type: 'pilot', traits: ['Trinity'] }, 0));
  const einsLinked = deployUnit(state, player, lookupCard('GD05-038'));
  pairPilot(state, player, einsLinked, player.hand[0]);
  assert.equal(einsLinked.isLinkUnit, true);
  assert.equal(getKeywords(einsLinked).suppression, true, 'gains Suppression the moment it becomes a Link Unit');

  const enemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 9 }, 1);
  opponent.battleArea.push(enemy);
  const cb1 = deployUnit(state, player, { number: 'C1', type: 'unit', traits: ['CB'], ap: 1, hp: 1 });
  const notEnoughCB = lookupCard('GD05-038').effects.activateMain(state, player, einsLinked, { target: enemy });
  assert.equal(notEnoughCB, false, 'only einsLinked itself + 1 other un-rested (CB) Unit, needs 3');

  const cb2 = deployUnit(state, player, { number: 'C2', type: 'unit', traits: ['CB'], ap: 1, hp: 1 });

  const cb3 = deployUnit(state, player, { number: 'C3', type: 'unit', traits: ['CB'], ap: 1, hp: 1 });
  const ok = lookupCard('GD05-038').effects.activateMain(state, player, einsLinked, { target: enemy, toRest: [cb1, cb2, cb3] });
  assert.equal(ok, true);
  assert.equal(enemy.damage, 4);
  assert.equal([cb1, cb2, cb3].every((u) => u.rested), true);

  const again = lookupCard('GD05-038').effects.activateMain(state, player, einsLinked, { target: enemy });
  assert.equal(again, false, 'once per turn');
});
