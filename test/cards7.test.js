const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getRemainingHP, getAP, getKeywords } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { runStartPhase } = require('../src/rules/phases');

test('Gundam NT-1 deals 1 to a chosen rested enemy on pairing, and draws a card if that kills it', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const nt1 = deployUnit(state, player, lookupCard('GD03-001'));
  const fodder = createInstance({ number: 'F', type: 'unit', level: 1, ap: 1, hp: 1 }, 1);
  fodder.rested = true;
  opponent.battleArea.push(fodder);
  player.deck.push(createInstance({ number: 'D', type: 'unit', ap: 1, hp: 1 }, 0));
  const handSizeBefore = player.hand.length;

  pairPilot(state, player, nt1, createInstance({ number: 'P', name: 'Amuro Ray', type: 'pilot', traits: [] }, 0));

  assert.equal(opponent.battleArea.includes(fodder), false, 'the 1-HP fodder unit died to the 1 damage');
  assert.equal(player.hand.length, handSizeBefore + 1, 'the kill drew a card');
});

test("Penelope (Flight Form)'s AP+1 aura only applies on its controller's own turn, and its Deploy grants a one-turn rest-on-kill trigger", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  const penelope = deployUnit(state, player, lookupCard('GD04-002'));
  const trooper = deployUnit(state, player, { number: 'T', type: 'unit', level: 1, ap: 3, hp: 3, traits: ['Earth Federation'] });
  runStartPhase(state);
  assert.equal(getAP(trooper), 4, 'AP+1 aura applied on the controller\'s own start phase');

  const weakEnemy = createInstance({ number: 'E', type: 'unit', level: 1, ap: 1, hp: 1 }, 1);
  const otherEnemy = createInstance({ number: 'E2', type: 'unit', level: 1, ap: 1, hp: 3 }, 1);
  opponent.battleArea.push(weakEnemy, otherEnemy);

  trooper.rested = false;
  resolveAttack(state, 0, trooper, { type: 'unit', instance: weakEnemy }, {});

  assert.equal(opponent.battleArea.includes(weakEnemy), false, 'the weak enemy died to battle damage');
  assert.equal(otherEnemy.rested, true, 'Penelope\'s Deploy trigger rested the one other enemy with <=5 HP');
});

test('Sazabi only sacrifices a friendly Unit on Attack when the trade is actually favorable', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const sazabi = deployUnit(state, player, lookupCard('GD05-049'));
  const chaff = deployUnit(state, player, { number: 'C', type: 'unit', level: 1, ap: 1, hp: 1 });
  const bigThreat = createInstance({ number: 'BT', type: 'unit', level: 8, ap: 6, hp: 6 }, 1);
  opponent.battleArea.push(bigThreat);

  lookupCard('GD05-049').effects.attack(state, player, sazabi, { target: { type: 'player' } });

  assert.equal(player.battleArea.includes(chaff), false, 'the weak chaff Unit was sacrificed');
  assert.equal(opponent.battleArea.includes(bigThreat), false, 'the opponent\'s big threat was destroyed in exchange');
});

test('Char Aznable, When Linked, may deploy a (Neo Zeon) Base card straight from the trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const zeongUnit = deployUnit(state, player, { number: 'Z', type: 'unit', level: 5, ap: 4, hp: 4, linkCondition: 'Char Aznable', traits: ['Neo Zeon'] });
  const neoZeonBase = createInstance({ number: 'NB', type: 'base', ap: 0, hp: 5, traits: ['Neo Zeon'] }, 0);
  player.trash.push(neoZeonBase);

  pairPilot(state, player, zeongUnit, createInstance(lookupCard('GD05-093'), 0));

  assert.equal(player.base, neoZeonBase, 'the trashed Neo Zeon Base was deployed via When Linked');
  assert.equal(player.trash.includes(neoZeonBase), false);
});

test('Unicorn Gundam 02 Banshee (Destroy Mode) recycles 12 trash cards into the deck and untaps with First Strike, but only with a full trash and Link active', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const banshee = deployUnit(state, player, lookupCard('GD01-003'));
  banshee.rested = true;
  banshee.isLinkUnit = false;
  for (let i = 0; i < 11; i++) player.trash.push(createInstance({ number: `X${i}`, type: 'unit', ap: 1, hp: 1 }, 0));

  lookupCard('GD01-003').effects.attack(state, player, banshee, {});
  assert.equal(banshee.rested, true, 'not a Link Unit yet, so nothing happens');

  banshee.isLinkUnit = true;
  lookupCard('GD01-003').effects.attack(state, player, banshee, {});
  assert.equal(banshee.rested, true, 'only 11 cards in trash -- short of the required 12');

  player.trash.push(createInstance({ number: 'X11', type: 'unit', ap: 1, hp: 1 }, 0));
  lookupCard('GD01-003').effects.attack(state, player, banshee, {});
  assert.equal(banshee.rested, false, 'now active again after recycling 12 trash cards');
  assert.equal(getKeywords(banshee).firstStrike, true);
  assert.equal(player.trash.length, 0);
  assert.equal(player.deck.length, 12);
});

test('Gundam Barbatos Lupus exiles 3 (Tekkadan)/(Teiwaz) trash Units to deal 2 damage, only once it has enough fuel', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const barbatosLupus = deployUnit(state, player, lookupCard('GD03-050'));
  const enemy = createInstance({ number: 'E', type: 'unit', level: 1, ap: 1, hp: 4 }, 1);
  opponent.battleArea.push(enemy);
  player.trash.push(
    createInstance({ number: 'T1', type: 'unit', traits: ['Tekkadan'] }, 0),
    createInstance({ number: 'T2', type: 'unit', traits: ['Teiwaz'] }, 0)
  );

  let activated = lookupCard('GD03-050').effects.activateMain(state, player, barbatosLupus, {});
  assert.equal(activated, false, 'only 2 qualifying trash Units so far -- not enough fuel');

  player.trash.push(createInstance({ number: 'T3', type: 'unit', traits: ['Tekkadan'] }, 0));
  activated = lookupCard('GD03-050').effects.activateMain(state, player, barbatosLupus, {});
  assert.equal(activated, true);
  assert.equal(getRemainingHP(enemy), 2);
  assert.equal(player.trash.length, 0);
  assert.equal(player.removal.length, 3);
});
