const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot, becomeBase } = require('../src/rules/actions');
const { resolveAttack } = require('../src/rules/combat');
const { getAP, getHP, getRemainingHP } = require('../src/rules/management');
const { runStartPhase, runEndPhase } = require('../src/rules/phases');

const JAKES_DECK_NUMBERS = [
  'ST01-005',
  'GD01-008',
  'ST03-008',
  'GD01-026',
  'ST03-006',
  'ST03-011',
  'GD01-030',
  'GD01-018',
  'ST01-010',
  'ST01-001',
  'GD01-100',
  'GD01-006',
  'GD04-122',
  'GD04-017'
];

test('every card in the corrected decklist resolves in the card database', () => {
  for (const number of JAKES_DECK_NUMBERS) {
    const def = lookupCard(number);
    assert.ok(def, `missing card data for ${number}`);
  }
});

test('GM ST01-005 is vanilla and matches the banlist description (Lv.2/cost1/2AP/2HP)', () => {
  const def = lookupCard('ST01-005');
  assert.equal(def.level, 2);
  assert.equal(def.cost, 1);
  assert.equal(def.ap, 2);
  assert.equal(def.hp, 2);
  assert.deepEqual(def.effects, undefined);
});

test('Guntank deals 1 damage to a rested enemy Unit on Deploy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const restedEnemy = createInstance({ number: 'X', type: 'unit', hp: 2 }, 1);
  restedEnemy.rested = true;
  opponent.battleArea.push(restedEnemy);

  deployUnit(state, player, lookupCard('GD01-008'));

  assert.equal(restedEnemy.damage, 1);
});

test("Zaku II ST03-008 gets AP+2 only after it attacks, for that turn", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.activePlayerIdx = 0;
  const zaku = deployUnit(state, player, lookupCard('ST03-008'));
  zaku.rested = false;
  assert.equal(getAP(zaku), 1);
  resolveAttack(state, 0, zaku, { type: 'player' });
  assert.equal(getAP(zaku), 3);
});

test("Char's Zaku II (GD01-026) deploys a rested token only if it was paired when destroyed", () => {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 10, hp: 10 }, 0);
  attackingPlayer.battleArea.push(attacker);

  const unpaired = deployUnit(state, defendingPlayer, lookupCard('GD01-026'));
  unpaired.hp = 1;
  resolveAttack(state, 0, attacker, { type: 'unit', instance: unpaired });
  assert.equal(defendingPlayer.battleArea.some((u) => u.def.number === 'TOKEN-CHARS-ZAKU'), false);

  attacker.rested = false;
  const paired = deployUnit(state, defendingPlayer, lookupCard('GD01-026'));
  const pilot = createInstance({ number: 'P', name: 'Some Pilot', type: 'pilot' }, 1);
  pairPilot(state, defendingPlayer, paired, pilot);
  resolveAttack(state, 0, attacker, { type: 'unit', instance: paired });
  const token = defendingPlayer.battleArea.find((u) => u.def.number === 'TOKEN-CHARS-ZAKU');
  assert.ok(token, 'token should be deployed since it was paired when destroyed');
  assert.equal(token.rested, true);
});

test("Char's Zaku II (ST03-006) adds a Zeon/Neo Zeon Unit from the top 3 of the deck when destroyed", () => {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 10, hp: 10 }, 0);
  attackingPlayer.battleArea.push(attacker);

  const target = deployUnit(state, defendingPlayer, lookupCard('ST03-006'));
  target.hp = 1;
  const zeonCard = createInstance({ number: 'Z', type: 'unit', traits: ['Zeon'] }, 1);
  defendingPlayer.deck.push(zeonCard, { def: { type: 'command' } }, { def: { type: 'command' } });

  resolveAttack(state, 0, attacker, { type: 'unit', instance: target });

  assert.ok(defendingPlayer.hand.includes(zeonCard));
});

test('Char Aznable grants AP+1 on attack, and High-Maneuver only when the pairing is a Link Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.activePlayerIdx = 0;
  const zaku = deployUnit(state, player, lookupCard('ST03-008'));
  const pilot = createInstance(lookupCard('ST03-011'), 0);
  pairPilot(state, player, zaku, pilot); // no link condition on Zaku II, so not a Link Unit

  resolveAttack(state, 0, zaku, { type: 'player' });

  assert.equal(zaku.isLinkUnit, false);
  assert.equal(getAP(zaku), 1 + 1 /* Aznable apBonus */ + 2 /* own Attack buff */ + 1 /* Aznable Attack buff */);
});

test('Amuro Ray rests a low-HP enemy Unit When Paired, and can be Burst back to hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gundam = deployUnit(state, player, lookupCard('ST01-001'));
  const lowHpEnemy = createInstance({ number: 'E', type: 'unit', hp: 3 }, 1);
  opponent.battleArea.push(lowHpEnemy);

  const amuro = createInstance(lookupCard('ST01-010'), 0);
  pairPilot(state, player, gundam, amuro);

  assert.equal(lowHpEnemy.rested, true);
  assert.equal(getAP(gundam), 3 + 2, "Amuro's AP+2 applies while paired");

  const burstAmuro = createInstance(lookupCard('ST01-010'), 0);
  burstAmuro.def.effects.burst(state, player, burstAmuro);
  assert.ok(player.hand.includes(burstAmuro));
});

test("Gundam's During Pair buffs the whole team AP+1, only on its owner's turn", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.activePlayerIdx = 0;
  const gundam = deployUnit(state, player, lookupCard('ST01-001'));
  const ally = deployUnit(state, player, { number: 'ALLY', type: 'unit', ap: 1, hp: 1 });
  const pilot = createInstance(lookupCard('ST01-010'), 0);
  pairPilot(state, player, gundam, pilot);

  runStartPhase(state);
  assert.equal(getAP(ally), 2, 'ally gets AP+1 during the Gundam owner\'s turn');

  state.activePlayerIdx = 1;
  ally.buffs = [];
  runStartPhase(state);
  assert.equal(getAP(ally), 1, "no buff on the opponent's turn");
});

test('A Show of Resolve draws 2 cards', () => {
  const player = createPlayer(0);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));
  lookupCard('GD01-100').effects.command({ players: [player] }, player);
  assert.equal(player.hand.length, 2);
});

test('Delta Plus gets HP+1 only while it is a Link Unit, and Repairs 1 at end of turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const deltaPlus = deployUnit(state, player, lookupCard('GD01-006'));
  assert.equal(getHP(deltaPlus), 3);
  deltaPlus.isLinkUnit = true;
  assert.equal(getHP(deltaPlus), 4);

  deltaPlus.damage = 2;
  runEndPhase(state);
  assert.equal(getRemainingHP(deltaPlus), 3, 'Repair 1 removed one damage counter');
});

test('Jaburo: Burst deploys it as a Base and its Deploy effect adds a Shield to hand', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.shields.push(createInstance({ number: 'SH', type: 'unit' }, 0));
  const jaburoInstance = createInstance(lookupCard('GD04-122'), 0);

  jaburoInstance.def.effects.burst(state, player, jaburoInstance);

  assert.equal(player.base, jaburoInstance);
  assert.equal(player.hand.length, 1);
});

test('Jaburo: Activate-Main rests a Federation Unit to rest a low-level enemy, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const jaburo = becomeBase(state, player, createInstance(lookupCard('GD04-122'), 0));
  const restUnit = createInstance({ number: 'FED', type: 'unit', traits: ['Earth Federation'] }, 0);
  player.battleArea.push(restUnit);
  const enemy = createInstance({ number: 'EN', type: 'unit', level: 2 }, 1);
  opponent.battleArea.push(enemy);

  const ok = jaburo.def.effects.activateMain(state, player, jaburo, { restUnit, target: enemy });
  assert.equal(ok, true);
  assert.equal(restUnit.rested, true);
  assert.equal(enemy.rested, true);

  const restUnit2 = createInstance({ number: 'FED2', type: 'unit', traits: ['Earth Federation'] }, 0);
  player.battleArea.push(restUnit2);
  const enemy2 = createInstance({ number: 'EN2', type: 'unit', level: 1 }, 1);
  opponent.battleArea.push(enemy2);
  const blocked = jaburo.def.effects.activateMain(state, player, jaburo, { restUnit: restUnit2, target: enemy2 });
  assert.equal(blocked, false, 'Once per Turn should block a second activation');
});

test('Zeong deploys 2 Wire-Guided Arm tokens only When Paired with a Newtype Pilot, and a Head token when destroyed', () => {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;

  const zeong = deployUnit(state, defendingPlayer, lookupCard('GD04-017'));
  const nonNewtype = createInstance({ number: 'P1', name: 'Non-Newtype', type: 'pilot', traits: [] }, 1);
  pairPilot(state, defendingPlayer, zeong, nonNewtype);
  assert.equal(defendingPlayer.battleArea.filter((u) => u.def.number === 'TOKEN-WIRE-ARM').length, 0);

  zeong.pilot = null;
  const newtypePilot = createInstance(lookupCard('ST03-011'), 1); // Char Aznable: (Zeon)(Newtype)
  pairPilot(state, defendingPlayer, zeong, newtypePilot);
  assert.equal(defendingPlayer.battleArea.filter((u) => u.def.number === 'TOKEN-WIRE-ARM').length, 2);
  assert.equal(zeong.isLinkUnit, true, "Char Aznable also satisfies Zeong's own Link Condition");

  const attacker = createInstance({ number: 'A', type: 'unit', ap: 100, hp: 10 }, 0);
  attackingPlayer.battleArea.push(attacker);
  resolveAttack(state, 0, attacker, { type: 'unit', instance: zeong });
  const head = defendingPlayer.battleArea.find((u) => u.def.number === 'TOKEN-ZEONG-HEAD');
  assert.ok(head);
  assert.equal(head.rested, true);
});
