const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { dealEffectDamage, setActiveByEffect } = require('../src/rules/effects');
const { canAfford, payCost } = require('../src/rules/cost');
const registry = require('../src/effects/registry');

test('Christina Mackenzie GD03-085: costs 0 when paired from hand with a "Gundam NT-1" named Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const def = lookupCard('GD03-085');
  const nt1 = { def: { name: 'Gundam NT-1', type: 'unit' } };
  const other = { def: { name: 'Some Other Unit', type: 'unit' } };
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 0));
  player.resourceArea.push(createInstance({ number: 'R2', type: 'resource' }, 0));
  player.resourceArea.push(createInstance({ number: 'R3', type: 'resource' }, 0));

  assert.equal(canAfford(player, def, { pairUnit: other }), true, 'affordable at normal cost 1 regardless');
  payCost(player, def, { pairUnit: nt1 });
  assert.equal(player.resourceArea.filter((r) => r.rested).length, 0, 'paired with Gundam NT-1 -- cost 0, nothing rested');

  payCost(player, def, { pairUnit: other });
  assert.equal(player.resourceArea.filter((r) => r.rested).length, 1, 'not paired with Gundam NT-1 -- normal cost 1');
});

test('Yazan Gable GD03-086 Attack: chooses a paired-level-or-lower (Titans) Unit for AP+1 this turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 3, hp: 3, level: 4 });
  const lowerTitans = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1, level: 4, traits: ['Titans'] });
  const higherTitans = deployUnit(state, player, { number: 'B', type: 'unit', ap: 1, hp: 1, level: 5, traits: ['Titans'] });

  pairPilot(state, player, unit, createInstance(lookupCard('GD03-086'), 0));
  registry.yazanGableAttack(state, player, unit, { hooks: { chooseUnit: (c) => c.find((u) => u === lowerTitans) } });
  assert.equal(getAP(lowerTitans), 2, 'Lv.4 (Titans) Unit, equal to paired Unit Lv -- AP+1');
  assert.equal(getAP(higherTitans), 1, 'higher-Lv (Titans) Unit untouched');
});

test('Sarah Zabiarov GD03-087 When Linked: rests 1 enemy Unit Lv.3 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowLv = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 3 });
  const highLv = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 4 });
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });

  registry.sarahZabiarovWhenLinked(state, player, unit, { hooks: { chooseUnit: (c) => c[0] } });
  assert.equal(lowLv.rested, true, 'Lv.3 enemy Unit -- rested');
  assert.equal(highLv.rested, false, 'Lv.4 enemy Unit -- not a valid candidate, untouched');
});

test('Asemu Asuno (R+) GD03-088: During Link, an (AGE System) Unit gets AP+1 and Breach 1', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const ageUnit = deployUnit(state, player, {
    number: 'U', type: 'unit', ap: 2, hp: 2, linkCondition: 'Earth Federation', traits: ['AGE System']
  });
  const nonAgeUnit = deployUnit(state, player, {
    number: 'U2', type: 'unit', ap: 2, hp: 2, linkCondition: 'Earth Federation', traits: []
  });
  const pilot1 = createInstance(lookupCard('GD03-088'), 0);
  const pilot2 = createInstance(lookupCard('GD03-088'), 0);

  pairPilot(state, player, ageUnit, pilot1);
  assert.ok(ageUnit.isLinkUnit, 'sanity: Link Condition met');
  // base AP 2 + pilot's own printed apBonus 2 + the (AGE System)-conditional Link AP+1 = 5.
  assert.equal(getAP(ageUnit), 5, '(AGE System) Link Unit -- AP+1 on top of the pilot\'s printed bonus');
  assert.equal(getKeywords(ageUnit).breach, 1, '(AGE System) Link Unit -- gains Breach 1');

  pairPilot(state, player, nonAgeUnit, pilot2);
  // base AP 2 + pilot's own printed apBonus 2, no conditional +1.
  assert.equal(getAP(nonAgeUnit), 4, 'non-(AGE System) Link Unit -- pilot\'s printed bonus only');
  assert.equal(getKeywords(nonAgeUnit).breach, undefined, 'non-(AGE System) Link Unit -- no Breach');
});

test('Bernard Wiseman GD03-089: AP scales with unique-named (Cyclops Team) Pilot/Command cards in trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });

  registry.bernardWisemanStartOfTurn(state, player, unit);
  assert.equal(getAP(unit), 1, 'empty trash -- no bonus');

  player.trash.push({ def: { type: 'pilot', name: 'Cyclops A', traits: ['Cyclops Team'] } });
  player.trash.push({ def: { type: 'command', name: 'Cyclops B', traits: ['Cyclops Team'] } });
  player.trash.push({ def: { type: 'pilot', name: 'Cyclops A', traits: ['Cyclops Team'] } }); // duplicate name
  player.trash.push({ def: { type: 'unit', name: 'Cyclops C', traits: ['Cyclops Team'] } }); // wrong type
  registry.bernardWisemanStartOfTurn(state, player, unit);
  assert.equal(getAP(unit), 3, '2 unique-named (Cyclops Team) Pilot/Command cards -- AP+2');
});

test('Rau Le Creuset (R+) GD03-091 When Linked: fetches a (ZAFT) Base card from trash to hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  const zaftBase = { def: { type: 'base', name: 'ZAFT Base', traits: ['ZAFT'] } };
  player.trash.push({ def: { type: 'base', name: 'Other Base', traits: [] } });
  player.trash.push(zaftBase);

  registry.rauLeCreusetRPlusWhenLinked(state, player, unit, {});
  assert.ok(player.hand.includes(zaftBase), 'fetched the (ZAFT) Base card');
  assert.ok(!player.trash.includes(zaftBase), 'removed from trash');
});

test('Carris Nautilus GD03-093: AP+1 while no enemy Base is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });

  registry.carrisNautilusStartOfTurn(state, player, unit);
  assert.equal(getAP(unit), 2, 'no enemy Base -- AP+1');

  opponent.base = createInstance({ number: 'B', type: 'base', ap: 0, hp: 3 }, 1);
  registry.carrisNautilusStartOfTurn(state, player, unit);
  assert.equal(getAP(unit), 1, 'enemy Base in play -- no bonus');
});

test('Azee Gurumin GD03-095: Once per Turn, receiving effect damage debuffs 1 enemy Unit AP-1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 3 });
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 3 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD03-095'), 0));

  dealEffectDamage(state, opponent, player, unit, 1);
  assert.equal(getAP(enemy), 2, 'received effect damage -- chosen enemy gets AP-1');

  dealEffectDamage(state, opponent, player, unit, 1);
  assert.equal(getAP(enemy), 2, 'Once per Turn -- second trigger does nothing');
});

test('Jamil Neate GD03-096 During Link Attack: may discard 1 to draw 1', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, linkCondition: 'Vulture' });
  const cheap = { def: { type: 'unit', name: 'Cheap', cost: 0 } };
  const expensive = { def: { type: 'unit', name: 'Expensive', cost: 3 } };
  player.hand.push(expensive, cheap);
  player.deck.push({ def: { type: 'unit', name: 'Drawn' } });

  registry.jamilNeateAttack(state, player, unit);
  assert.equal(player.hand.length, 2, 'not a Link Unit -- no reaction');

  pairPilot(state, player, unit, createInstance(lookupCard('GD03-096'), 0));
  assert.ok(unit.isLinkUnit, 'sanity: Link Condition met');
  registry.jamilNeateAttack(state, player, unit);
  assert.ok(!player.hand.includes(cheap), 'discarded the cheapest card');
  assert.ok(player.hand.includes(expensive), 'kept the more expensive card');
  assert.equal(player.hand.length, 2, 'discarded 1, drew 1 -- net unchanged');
});

test('Wistario Afam GD03-097 During Link, Once per Turn, own turn: destroying an enemy scries top 2', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, linkCondition: 'Civilian' });
  pairPilot(state, player, unit, createInstance(lookupCard('GD03-097'), 0));

  const command = { def: { type: 'command', name: 'Junk' } };
  const keepUnit = { def: { type: 'unit', name: 'Keep Me' } };
  player.deck.push(command, keepUnit);

  registry.wistarioAfamDestroysEnemy(state, player, unit);
  assert.equal(player.deck[0], keepUnit, 'kept the Unit/Base card on top');
  assert.ok(player.trash.includes(command), 'placed the other card into trash');

  player.deck.push({ def: { type: 'unit' } }, { def: { type: 'unit' } });
  registry.wistarioAfamDestroysEnemy(state, player, unit);
  assert.equal(player.deck.length, 3, 'Once per Turn -- second trigger this turn does nothing');
});

test('Graham Aker (R+) GD03-098 During Link: set active by an effect returns a 3-or-less-HP enemy to hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, linkCondition: 'Superpower Bloc' });
  unit.rested = true;
  const lowHp = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  const highHp = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 4 });

  setActiveByEffect(state, player, unit);
  assert.equal(opponent.hand.length, 0, 'not a Link Unit yet -- no reaction');

  pairPilot(state, player, unit, createInstance(lookupCard('GD03-098'), 0));
  assert.ok(unit.isLinkUnit, 'sanity: Link Condition met');
  unit.rested = true;
  setActiveByEffect(state, player, unit);
  assert.equal(unit.rested, false, 'actually set active');
  assert.ok(opponent.hand.includes(lowHp), '3-or-less-HP enemy Unit returned to hand');
  assert.ok(opponent.battleArea.includes(highHp), '4-HP enemy Unit untouched');
});

test("Emma Sheen GD03-099 During Link Destroyed: requires a friendly white Base to return an enemy Unit", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, level: 3, linkCondition: 'AEUG' });
  pairPilot(state, player, unit, createInstance(lookupCard('GD03-099'), 0));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1, level: 3 });

  registry.emmaSheenDestroyed(state, player, unit);
  assert.equal(opponent.hand.length, 0, 'no friendly white Base -- no reaction');

  player.base = createInstance({ number: 'B', type: 'base', ap: 0, hp: 3, color: 'white' }, 0);
  registry.emmaSheenDestroyed(state, player, unit);
  assert.ok(opponent.hand.includes(enemy), 'friendly white Base in play -- enemy Unit returned to hand');
});

test('Soma Peries GD03-100 Destroyed: chosen enemy Unit gets AP-3 during this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 1 });

  registry.somaPeriesDestroyed(state, player);
  assert.equal(getAP(enemy), 1, 'AP-3 applied');
});

test('A Healthy Curiosity (R+) GD03-101 Main: draws 1, then rests a 4-or-less-HP enemy Unit if 2+ copies in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 4 });
  player.deck.push({ def: { type: 'unit', name: 'Drawn' } });
  const instance = createInstance(lookupCard('GD03-101'), 0);

  registry.aHealthyCuriosityRPlusCommand(state, player, instance, {});
  assert.equal(player.hand.length, 1, 'drew 1');
  assert.equal(enemy.rested, false, 'fewer than 2 copies in trash -- no rest effect');

  player.trash.push({ def: { name: 'A Healthy Curiosity (R+)' } }, { def: { name: 'A Healthy Curiosity (R+)' } });
  player.deck.push({ def: { type: 'unit', name: 'Drawn2' } });
  registry.aHealthyCuriosityRPlusCommand(state, player, instance, {});
  assert.equal(enemy.rested, true, '2+ copies in trash -- rests the 4-or-less-HP enemy Unit');
});
