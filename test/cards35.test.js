const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { canAfford } = require('../src/rules/cost');
const registry = require('../src/effects/registry');

test('Z Gundam (Biosensor) (R+) GD03-071 Deploy: enemy Unit gets AP-1 per (AEUG) Unit card in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 4 });

  deployUnit(state, player, lookupCard('GD03-071'));
  assert.equal(getAP(enemy), 4, 'no (AEUG) Unit cards in trash -- no reaction');

  player.trash.push({ def: { type: 'unit', traits: ['AEUG'] } });
  player.trash.push({ def: { type: 'unit', traits: ['AEUG'] } });
  deployUnit(state, player, lookupCard('GD03-071'));
  assert.equal(getAP(enemy), 2, '2 (AEUG) Unit cards in trash -- AP-2');
});

test('Aile Strike Gundam GD03-072 Deploy: draws then discards 1 only if another (Triple Ship Alliance) Unit is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const expensiveFiller = { def: { type: 'unit', name: 'Expensive Filler', cost: 5 } };
  player.hand.push(expensiveFiller);
  player.deck.push({ def: { type: 'unit', name: 'Drawn Card', cost: 0 } });

  deployUnit(state, player, lookupCard('GD03-072'));
  assert.equal(player.hand.length, 1, 'no other (Triple Ship Alliance) Unit -- no reaction, hand untouched');

  deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1, traits: ['Triple Ship Alliance'] });
  const before = player.deck.length;
  deployUnit(state, player, lookupCard('GD03-072'));
  assert.equal(player.deck.length, before - 1, 'drew 1 card');
  assert.ok(!player.hand.includes(expensiveFiller), 'discarded the highest-cost card in hand, not the newly-drawn one');
  assert.equal(player.hand.length, 1, 'net hand size unchanged: drew 1, discarded 1');
});

test("Graze Ein (R+) GD03-073 Activate*Action: Once per Turn, if 6+ (Gjallarhorn) cards in trash, the enemy Unit battling it gets AP-3 this battle", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const grazeEin = deployUnit(state, player, lookupCard('GD03-073'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 4, hp: 4 });

  assert.equal(registry.grazeEinActivateAction(state, player, grazeEin, { target: enemy }), false, 'not a Link Unit yet -- fails');

  pairPilot(state, player, grazeEin, createInstance({ number: 'P', name: 'Ein Dalton', type: 'pilot' }, 0));
  assert.equal(registry.grazeEinActivateAction(state, player, grazeEin, { target: enemy }), false, 'Link Unit, but fewer than 6 (Gjallarhorn) cards in trash -- fails');

  for (let i = 0; i < 6; i++) player.trash.push({ def: { type: 'unit', traits: ['Gjallarhorn'] } });
  assert.equal(registry.grazeEinActivateAction(state, player, grazeEin, { target: enemy }), true, '6+ (Gjallarhorn) cards in trash -- succeeds');
  assert.equal(getAP(enemy), 1, 'enemy gets AP-3 for this battle');
  assert.equal(registry.grazeEinActivateAction(state, player, grazeEin, { target: enemy }), false, 'Once per Turn -- already used');
});

test('Tieren Taozi GD03-074: While paired and another (Superpower Bloc) Unit is in play, it becomes a forced attack target when rested', () => {
  const { getForcedAttackTargets } = require('../src/ai/heuristic');
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const taozi = deployUnit(state, player, lookupCard('GD03-074'));
  taozi.rested = true;

  assert.deepEqual(getForcedAttackTargets(player), [], 'no Pilot paired -- not forced yet');

  pairPilot(state, player, taozi, createInstance({ number: 'P', name: 'Some Pilot', type: 'pilot' }, 0));
  assert.deepEqual(getForcedAttackTargets(player), [], 'paired, but no other (Superpower Bloc) Unit in play -- not forced yet');

  deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1, traits: ['Superpower Bloc'] });
  assert.ok(getForcedAttackTargets(player).includes(taozi), 'paired + another (Superpower Bloc) Unit in play -- forced target');
});

test('Super Gundam GD03-075 During Link Attack: enemy Unit with no paired Pilot gets AP-2 this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const superGundam = deployUnit(state, player, lookupCard('GD03-075'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 3 });

  superGundam.def.effects.attack(state, player, superGundam, {});
  assert.equal(getAP(enemy), 3, 'not a Link Unit -- no reaction');

  pairPilot(state, player, superGundam, createInstance({ number: 'P', name: 'Some AEUG Pilot', type: 'pilot' }, 0));
  superGundam.def.effects.attack(state, player, superGundam, {});
  assert.equal(getAP(enemy), 1, 'Link Unit -- unpaired enemy gets AP-2');
});

test("Freedom Gundam (Meteor) GD03-076: Once per Turn, when your (Triple Ship Alliance) Unit deals battle damage to an enemy, returns it to owner's hand", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('GD03-076'));
  const tsaAttacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 3, hp: 5, traits: ['Triple Ship Alliance'] });
  const nonTsaAttacker = deployUnit(state, player, { number: 'B', type: 'unit', ap: 3, hp: 5 });
  const enemy1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  enemy1.rested = true;
  const enemy2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5 });
  enemy2.rested = true;

  resolveAttack(state, 0, nonTsaAttacker, { type: 'unit', instance: enemy2 });
  assert.ok(opponent.battleArea.includes(enemy2), 'non-(Triple Ship Alliance) attacker -- no reaction');

  resolveAttack(state, 0, tsaAttacker, { type: 'unit', instance: enemy1 });
  assert.ok(!opponent.battleArea.includes(enemy1), '(Triple Ship Alliance) attacker deals battle damage -- returned to hand');
  assert.ok(opponent.hand.includes(enemy1));
});

test('Justice Gundam (METEOR) GD03-077 When Linked: return 1 to 3 enemy Units with 3 or less HP to their hands', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const justice = deployUnit(state, player, lookupCard('GD03-077'));
  const weak1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  const weak2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 2 });
  const tough = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 4 });

  pairPilot(state, player, justice, createInstance({ number: 'P', name: 'Athrun Zala', type: 'pilot' }, 0));
  assert.ok(!opponent.battleArea.includes(weak1) && !opponent.battleArea.includes(weak2), 'both 3-or-less-HP enemies returned to hand');
  assert.ok(opponent.battleArea.includes(tough), '4 HP enemy is not a legal target -- stays');
});

test("Tieren High Mobility Type GD03-078: During Link Destroyed, returns its paired Pilot to hand", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 5, hp: 5 });
  const tieren1 = deployUnit(state, player, lookupCard('GD03-078'));
  pairPilot(state, player, tieren1, createInstance({ number: 'P1', name: 'Random Pilot', type: 'pilot' }, 0));
  resolveAttack(state, 1, attacker, { type: 'unit', instance: tieren1 });
  assert.ok(!player.hand.some((c) => c.def.name === 'Random Pilot'), 'not a Link Unit -- Pilot stays in trash');

  const tieren2 = deployUnit(state, player, lookupCard('GD03-078'));
  pairPilot(state, player, tieren2, createInstance({ number: 'P2', name: 'Sergei Smirnov', type: 'pilot' }, 0));
  attacker.rested = false;
  resolveAttack(state, 1, attacker, { type: 'unit', instance: tieren2 });
  assert.ok(player.hand.some((c) => c.def.name === 'Sergei Smirnov'), 'Link Unit destroyed -- paired Pilot returned to hand');
});

test('G-Defenser GD03-079: redirects a Base-resting effect onto itself instead', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.base = createInstance({ number: 'B', type: 'base', ap: 0, hp: 5 }, 0);
  const rickDias = deployUnit(state, player, { number: 'R', type: 'unit', ap: 5, hp: 4, level: 5, effects: {
    attack: registry.rickDiasRedAttack
  } });
  deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5, level: 4 });

  rickDias.def.effects.attack(state, player, rickDias, {});
  assert.equal(player.base.rested, true, 'no G-Defenser in play -- Base itself gets rested');

  player.base.rested = false;
  const gDefenser = deployUnit(state, player, lookupCard('GD03-079'));
  const rickDias2 = deployUnit(state, player, { number: 'R2', type: 'unit', ap: 5, hp: 4, level: 5, effects: {
    attack: registry.rickDiasRedAttack
  } });
  rickDias2.def.effects.attack(state, player, rickDias2, {});
  assert.equal(player.base.rested, false, 'G-Defenser in play -- Base stays active');
  assert.equal(gDefenser.rested, true, 'G-Defenser is rested instead');
});

test('Gundam Kimaris Trooper (Trooper Mode) GD03-080 When Linked: fetch a (Gjallarhorn) Command card from trash to hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const kimaris = deployUnit(state, player, lookupCard('GD03-080'));

  pairPilot(state, player, kimaris, createInstance({ number: 'P1', name: 'Non-Link Pilot', type: 'pilot' }, 0));
  assert.equal(player.hand.length, 0, 'no (Gjallarhorn) Command card in trash -- no reaction');

  const command = { def: { type: 'command', name: 'Gjallarhorn Tactics', traits: ['Gjallarhorn'] } };
  player.trash.push(command);
  const kimaris2 = deployUnit(state, player, lookupCard('GD03-080'));
  pairPilot(state, player, kimaris2, createInstance({ number: 'P2', name: 'Gaelio Bauduin', type: 'pilot' }, 0));
  assert.ok(player.hand.includes(command), 'Link Unit -- fetched the (Gjallarhorn) Command card to hand');
});

test('AEU Enact Demonstration Color GD03-081: can only attack during a turn when a (Superpower Bloc)/(UN) Unit was deployed', () => {
  const { runAttacks } = require('../src/ai/heuristic');
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.turnNumber = 1;
  const enact = deployUnit(state, player, lookupCard('GD03-081'));
  enact.turnDeployed = 0;
  deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1 });

  runAttacks(state, 0, {});
  assert.equal(enact.rested, false, 'no (Superpower Bloc)/(UN) Unit deployed this turn -- cannot attack');

  const other = deployUnit(state, player, { number: 'O', type: 'unit', ap: 1, hp: 1, traits: ['Superpower Bloc'] });
  other.turnDeployed = 1;
  runAttacks(state, 0, {});
  assert.equal(enact.rested, true, 'a (Superpower Bloc) Unit was deployed this turn -- can attack');
});

test('Union Flag GD03-082: cost -1 in hand while 2+ (Superpower Bloc)/(UN) Units are in play', () => {
  const player = createPlayer(0);
  const def = lookupCard('GD03-082');
  const rested1 = createInstance({ number: 'R0', type: 'resource' }, 0);
  const rested2 = createInstance({ number: 'R1', type: 'resource' }, 0);
  rested1.rested = true;
  rested2.rested = true;
  player.resourceArea.push(rested1, rested2, createInstance({ number: 'R2', type: 'resource' }, 0));
  assert.equal(canAfford(player, def), false, 'Lv.3 satisfied (3 resources), normal cost 2 but only 1 active resource -- unaffordable');
  player.battleArea.push({ def: { traits: ['Superpower Bloc'] } });
  player.battleArea.push({ def: { traits: ['UN'] } });
  assert.equal(canAfford(player, def), true, '2 (Superpower Bloc)/(UN) Units in play -- reduced cost 1 is affordable with 1 active resource');
});

test("Paptimus Scirocco (R+) GD03-084 When Linked: grants another friendly Unit <Repair 2> this turn, drawing 1 if it's (Jupitris)", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  for (let i = 0; i < 5; i++) player.deck.push({ def: { type: 'unit', name: 'Filler', cost: 1 } });
  const paptimus = deployUnit(state, player, { number: 'U', type: 'unit', ap: 5, hp: 5, effects: {} });
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 3, hp: 3, traits: ['Jupitris'] });
  pairPilot(state, player, paptimus, createInstance(lookupCard('GD03-084'), 0));

  const before = player.deck.length;
  registry.paptimusSciroccoRPlusWhenLinked(state, player, paptimus, {});
  ally.damage = 2;
  const { applyRepairAtEndOfTurn } = require('../src/rules/effects');
  applyRepairAtEndOfTurn(state, player);
  assert.equal(getRemainingHP(ally), 3, 'gained <Repair 2> this turn, recovering from 1 to 3 (full) HP');
  assert.equal(player.deck.length, before - 1, '(Jupitris) target -- drew 1');
});
