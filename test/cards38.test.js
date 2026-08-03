const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { resolveUnitBattleDamage } = require('../src/rules/combat');
const { dealEffectDamage, restEnemyByEffect } = require('../src/rules/effects');
const registry = require('../src/effects/registry');

test("Orga's Order GD03-117: deploys a token scaled by enemy Unit count", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  registry.orgasOrderCommand(state, player);
  assert.equal(player.battleArea.length, 0, 'no enemies in play -- no token');

  for (let i = 0; i < 2; i++) deployUnit(state, opponent, { number: `E${i}`, type: 'unit', ap: 1, hp: 1 });
  registry.orgasOrderCommand(state, player);
  let token = player.battleArea.find((u) => u.def.isToken);
  assert.equal(token.def.name, 'Graze Custom', '1-4 enemies -- Graze Custom token');
  assert.equal(getAP(token), 2);

  for (let i = 2; i < 5; i++) deployUnit(state, opponent, { number: `E${i}`, type: 'unit', ap: 1, hp: 1 });
  registry.orgasOrderCommand(state, player);
  const tokens = player.battleArea.filter((u) => u.def.isToken);
  assert.equal(tokens[1].def.name, 'Gundam Barbatos 4th Form', '5+ enemies -- Barbatos 4th Form token');
});

test('Awakened Potential (R+) GD03-118: Burst to hand, Action bounces a rested Lv<=4 enemy, grants Blocker with 2+ copies in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = createInstance(lookupCard('GD03-118'), 0);
  const friendly = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  const restedEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1, level: 4 });
  restedEnemy.rested = true;

  registry.awakenedPotentialRPlusBurst(state, player, instance);
  assert.ok(player.hand.includes(instance), 'Burst -- added to hand');

  registry.awakenedPotentialRPlusCommand(state, player);
  assert.ok(opponent.hand.includes(restedEnemy), 'rested Lv<=4 enemy bounced to hand');
  assert.ok(!friendly.buffs.some((b) => b.keyword === 'blocker'), 'fewer than 2 copies in trash -- no Blocker grant');

  player.trash.push({ def: { name: 'Awakened Potential (R+)' } }, { def: { name: 'Awakened Potential (R+)' } });
  const restedEnemy2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1, level: 4 });
  restedEnemy2.rested = true;
  registry.awakenedPotentialRPlusCommand(state, player);
  assert.ok(friendly.buffs.some((b) => b.keyword === 'blocker'), '2+ copies in trash -- Blocker granted');
});

test('Awkward Approach GD03-119: sets a rested friendly Base active and debuffs all enemy Units AP-1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 1 });

  registry.awkwardApproachCommand(state, player);
  assert.equal(getAP(enemy), 3, 'no friendly Base -- no effect');

  const base = deployBase(state, player, { number: 'B', type: 'base', ap: 0, hp: 5 });
  registry.awkwardApproachCommand(state, player);
  assert.equal(getAP(enemy), 3, 'Base is active, not rested -- no effect');

  base.rested = true;
  registry.awkwardApproachCommand(state, player);
  assert.equal(base.rested, false, 'rested friendly Base set active');
  assert.equal(getAP(enemy), 2, 'all enemy Units get AP-1');
});

test('Immortal Colasour GD03-120: after a friendly (Superpower Bloc)/(UN) Unit destroys an enemy with battle damage, sets a rested matching-trait friendly Unit active and unable to attack', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 5, hp: 5, traits: ['Superpower Bloc'] });
  const restedAlly = deployUnit(state, player, { number: 'B', type: 'unit', ap: 1, hp: 1, traits: ['UN'] });
  restedAlly.rested = true;
  const defender = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 0, hp: 1 });

  registry.immortalColasourCommand(state, player);
  resolveUnitBattleDamage(state, player, opponent, attacker, defender, {});

  assert.equal(restedAlly.rested, false, 'rested (UN) Unit set active');
  assert.ok(restedAlly.buffs.some((b) => b.cannotAttack), "it can't attack during this turn");
});

test('Unheralded Attack GD03-121: rests a friendly active Base and an enemy Unit with 3 or less HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 3 });

  registry.unheraldedAttackCommand(state, player);
  assert.equal(enemy.rested, false, 'no friendly Base -- neither target rests');

  const base = deployBase(state, player, { number: 'B', type: 'base', ap: 0, hp: 5 });
  registry.unheraldedAttackCommand(state, player);
  assert.equal(base.rested, true, 'friendly Base rested');
  assert.equal(enemy.rested, true, 'enemy Unit HP<=3 rested');
});

test('Veteran Tactics GD03-122: returns a Lv.3-or-lower enemy Unit to its owner\'s hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooHigh = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 4 });
  const eligible = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 3, hp: 1, level: 3 });

  registry.veteranTacticsCommand(state, player);
  assert.ok(opponent.battleArea.includes(tooHigh), 'Lv.4 enemy untouched');
  assert.ok(opponent.hand.includes(eligible), 'Lv.3 enemy bounced to hand');
});

test('Jupitris GD03-123: Burst deploys this card as the Base and adds a Shield to hand; rests a Lv<=3 enemy only with a friendly (Jupitris) Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1, level: 3 });
  const instance = createInstance(lookupCard('GD03-123'), 0);

  registry.jupitrisBurst(state, player, instance);
  assert.equal(player.base, instance, 'Burst deploys this card as the Base');
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');
  assert.equal(enemy.rested, false, 'no friendly (Jupitris) Unit in play -- no rest');

  const player2 = createPlayer(0);
  const opponent2 = createPlayer(1);
  const state2 = createGame(player2, opponent2);
  player2.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  deployUnit(state2, player2, { number: 'U', type: 'unit', ap: 1, hp: 1, traits: ['Jupitris'] });
  const enemy2 = deployUnit(state2, opponent2, { number: 'E', type: 'unit', ap: 1, hp: 1, level: 3 });
  const instance2 = createInstance(lookupCard('GD03-123'), 0);
  registry.jupitrisBurst(state2, player2, instance2);
  assert.equal(enemy2.rested, true, 'friendly (Jupitris) Unit in play -- Lv<=3 enemy rested');
});

test('Ribo Colony GD03-124: Deploy adds a Shield to hand; Once per Turn rests an enemy HP<=3 when a Lv<=3 Pilot is paired', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  const instance = createInstance(lookupCard('GD03-124'), 0);
  registry.riboColonyBurst(state, player, instance);
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');

  const highLvUnit = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  const enemy1 = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 3 });
  registry.riboColonyAllyPaired(state, player, instance, {
    pairedUnit: highLvUnit,
    pilot: createInstance({ number: 'P1', type: 'pilot', level: 5 }, 0)
  });
  assert.equal(enemy1.rested, false, 'Lv>3 Pilot pairing -- no reaction');

  const lowLvUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  registry.riboColonyAllyPaired(state, player, instance, {
    pairedUnit: lowLvUnit,
    pilot: createInstance({ number: 'P2', type: 'pilot', level: 2 }, 0)
  });
  assert.equal(enemy1.rested, true, 'Lv<=3 Pilot pairing -- enemy HP<=3 rested');

  enemy1.rested = false;
  const enemy2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 3 });
  registry.riboColonyAllyPaired(state, player, instance, {
    pairedUnit: lowLvUnit,
    pilot: createInstance({ number: 'P3', type: 'pilot', level: 1 }, 0)
  });
  assert.equal(enemy2.rested, false, 'Once per Turn already used -- second pairing this turn does nothing');
});

test('Cyclops Team GD03-126: friendly Unit tokens get AP+1 only during the opponent\'s turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  const instance = createInstance(lookupCard('GD03-126'), 0);
  registry.cyclopsTeamBurst(state, player, instance);
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');
  const token = deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 1, isToken: true });

  state.activePlayerIdx = 0;
  registry.cyclopsTeamStartOfTurn(state, player, instance);
  assert.equal(getAP(token), 1, "player's own turn -- no bonus");

  state.activePlayerIdx = 1;
  registry.cyclopsTeamStartOfTurn(state, player, instance);
  assert.equal(getAP(token), 2, "opponent's turn -- token gets AP+1");
});

test('Jachin Due GD03-127: Burst adds a Shield to hand and grants a friendly (ZAFT) Unit AP+3 this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  const zaft = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, traits: ['ZAFT'] });
  const instance = createInstance(lookupCard('GD03-127'), 0);

  registry.jachinDueBurst(state, player, instance);
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');
  assert.equal(getAP(zaft), 4, '(ZAFT) Unit -- AP+3');
});

test('Doritea GD03-128: Once per Turn during your opponent\'s turn, deals 1 damage to an enemy Unit when one of your Units is rested by an opponent effect', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  const instance = createInstance(lookupCard('GD03-128'), 0);
  registry.doriteaBurst(state, player, instance);
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');

  const friendlyUnit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5 });

  state.activePlayerIdx = 0;
  restEnemyByEffect(state, opponent, player, friendlyUnit);
  assert.equal(enemy.damage, 0, "player's own turn -- Doritea doesn't react");

  state.activePlayerIdx = 1;
  restEnemyByEffect(state, opponent, player, friendlyUnit);
  assert.equal(enemy.damage, 1, "opponent's turn -- 1 damage dealt");

  const friendlyUnit2 = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1 });
  restEnemyByEffect(state, opponent, player, friendlyUnit2);
  assert.equal(enemy.damage, 1, 'Once per Turn already used -- no further reaction this turn');
});

test('Hotarubi GD03-129: during your turn, when a friendly (Tekkadan)/(Teiwaz) Unit receives effect damage, may rest this Base to mill 1 to trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  const instance = createInstance(lookupCard('GD03-129'), 0);
  registry.hotarubiBurst(state, player, instance);
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');

  const nonMatching = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 5 });
  state.activePlayerIdx = 0;
  dealEffectDamage(state, opponent, player, nonMatching, 1);
  assert.equal(instance.rested, false, 'no matching trait -- Base untouched');

  const tekkadanUnit = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 5, traits: ['Tekkadan'] });
  player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));
  dealEffectDamage(state, opponent, player, tekkadanUnit, 1);
  assert.equal(instance.rested, true, 'matching (Tekkadan) Unit receives effect damage on your turn -- Base rested');
  assert.equal(player.trash.length, 1, 'top card of deck milled to trash');
});

test('Downes GD03-130: Deploy adds a Shield to hand, then on your own turn may deploy a Lv<=4 (Vagan) Unit from trash by paying its cost', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  for (let i = 0; i < 5; i++) player.resourceArea.push(createInstance({ number: `R${i}`, type: 'resource' }, 0));
  const vaganUnit = { number: 'V', type: 'unit', ap: 1, hp: 1, level: 4, cost: 1, traits: ['Vagan'] };
  player.trash.push(createInstance(vaganUnit, 0));

  state.activePlayerIdx = 1;
  const instanceOpponentTurn = createInstance(lookupCard('GD03-130'), 0);
  registry.downesBurst(state, player, instanceOpponentTurn);
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');
  assert.equal(player.battleArea.length, 0, "opponent's turn -- no trash redeploy");

  player.shields.push(createInstance({ number: 'S2', type: 'unit' }, 0));
  state.activePlayerIdx = 0;
  const instanceOwnTurn = createInstance(lookupCard('GD03-130'), 0);
  registry.downesBurst(state, player, instanceOwnTurn);
  assert.ok(player.battleArea.some((u) => u.def === vaganUnit), 'own turn -- Lv<=4 (Vagan) Unit redeployed from trash');
});

test('Eternal GD03-131: Deploy adds a Shield to hand, then bounces a Lv<=4 enemy if 2+ (Triple Ship Alliance) Units are in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 1, level: 4 });

  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  const instanceOne = createInstance(lookupCard('GD03-131'), 0);
  deployUnit(state, player, { number: 'T1', type: 'unit', ap: 1, hp: 1, traits: ['Triple Ship Alliance'] });
  registry.eternalBurst(state, player, instanceOne);
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');
  assert.ok(opponent.battleArea.includes(enemy), 'fewer than 2 (Triple Ship Alliance) Units -- no bounce');

  deployUnit(state, player, { number: 'T2', type: 'unit', ap: 1, hp: 1, traits: ['Triple Ship Alliance'] });
  player.shields.push(createInstance({ number: 'S2', type: 'unit' }, 0));
  const instanceTwo = createInstance(lookupCard('GD03-131'), 0);
  registry.eternalBurst(state, player, instanceTwo);
  assert.ok(opponent.hand.includes(enemy), '2+ (Triple Ship Alliance) Units -- Lv<=4 enemy bounced to hand');
});

test('Radish GD03-132: Deploy adds a Shield to hand; Destroyed rests an enemy HP<=4 if a friendly (AEUG) Link Unit is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  const instance = createInstance(lookupCard('GD03-132'), 0);
  registry.radishBurst(state, player, instance);
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 4 });
  registry.radishDestroyed(state, player, instance);
  assert.equal(enemy.rested, false, 'no friendly (AEUG) Link Unit -- no reaction');

  const aeugLink = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, traits: ['AEUG'] });
  aeugLink.isLinkUnit = true;
  registry.radishDestroyed(state, player, instance);
  assert.equal(enemy.rested, true, 'friendly (AEUG) Link Unit in play -- enemy HP<=4 rested');
});
