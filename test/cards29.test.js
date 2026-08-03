const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot, playCommand } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');
const { triggerEvent } = require('../src/rules/effects');
const { resolveAttack } = require('../src/rules/combat');

function noBlockHooks() {
  return { chooseBlocker: () => null, chooseBurst: () => false };
}

test('Lafter Frankland GD02-095 Attack grants High-Maneuver for the battle only if damaged and Lv.5 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const attacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 3, hp: 5, level: 5 });
  pairPilot(state, player, attacker, createInstance(lookupCard('GD02-095'), 0));
  // Calls the ability directly rather than through resolveAttack, since resolveAttack always clears
  // scope:'battle' buffs at its own battle-end step before this could be observed -- same fix shape
  // as the Rick Dias (Red) GD02-075 test from an earlier batch.
  const { lafterFranklandAttack } = require('../src/effects/registry');

  lafterFranklandAttack(state, player, attacker);
  assert.ok(!getKeywords(attacker).highManeuver, 'not damaged yet -- no High-Maneuver');

  attacker.damage = 1;
  lafterFranklandAttack(state, player, attacker);
  assert.ok(getKeywords(attacker).highManeuver, 'damaged and Lv.5 -- gained High-Maneuver for the battle');
});

test('Desil Galette GD02-096 When Linked pays cost to deploy a cheap (Vagan) Unit from trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const tooExpensive = createInstance({ number: 'T', type: 'unit', traits: ['Vagan'], level: 1, cost: 5 }, 0);
  const tooHighLevel = createInstance({ number: 'H', type: 'unit', traits: ['Vagan'], level: 3, cost: 1 }, 0);
  const legal = createInstance({ number: 'L', type: 'unit', traits: ['Vagan'], level: 2, cost: 1 }, 0);
  player.trash.push(tooExpensive, tooHighLevel, legal);
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 0), createInstance({ number: 'R2', type: 'resource' }, 0));

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, level: 5, linkCondition: 'Vagan' });
  pairPilot(state, player, unit, createInstance(lookupCard('GD02-096'), 0));
  assert.ok(player.battleArea.some((u) => u.def === legal.def), 'deployed the affordable Lv.2-or-lower (Vagan) Unit from trash');
  assert.ok(!player.trash.includes(legal), 'removed it from trash');
  assert.equal(player.resourceArea[0].rested, true, 'paid its cost');
});

test('Kamille Bidan (R+) GD02-097 grants his paired Unit AP+2 only while a friendly white Base is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 3 });
  pairPilot(state, player, unit, createInstance(lookupCard('GD02-097'), 0));
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(unit), 2 + 1, "Kamille's own printed apBonus only -- no white Base yet");

  player.base = createInstance({ number: 'B', type: 'base', color: 'white', ap: 0, hp: 6 }, 0);
  triggerEvent(state, 'startOfTurn', {});
  assert.equal(getAP(unit), 2 + 1 + 2, 'friendly white Base in play -- extra AP+2');
});

test("Quattro Bajeena GD02-098's name is also treated as Char Aznable, and When Linked loots 1 only for an (AEUG) Unit", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  for (let i = 0; i < 5; i++) player.deck.push(createInstance({ number: 'D', type: 'unit', cost: 1 }, 0));
  for (let i = 0; i < 3; i++) player.hand.push(createInstance({ number: 'H', type: 'unit', cost: 3 }, 0));

  const greenUnit = deployUnit(state, player, { number: 'G', type: 'unit', color: 'green', ap: 1, hp: 1, level: 5, linkCondition: 'Char Aznable' });
  pairPilot(state, player, greenUnit, createInstance(lookupCard('GD02-098'), 0));
  assert.equal(greenUnit.isLinkUnit, true, "linked via the Char Aznable name alias");
  assert.equal(player.hand.length, 3, 'not an (AEUG) Unit -- no loot');

  const aeugUnit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1, level: 5, traits: ['AEUG'], linkCondition: 'Char Aznable' });
  pairPilot(state, player, aeugUnit, createInstance(lookupCard('GD02-098'), 0));
  assert.equal(player.hand.length, 3, 'drew 1 then discarded 1 -- net unchanged, but both halves fired');
  assert.equal(player.deck.length, 4, 'drew from the deck');
});

test('Gaelio Bauduin GD02-099 When Paired debuffs an enemy AP-2, but only with 4+ (Gjallarhorn) cards in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 5 });
  const unit1 = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1, level: 5 });
  pairPilot(state, player, unit1, createInstance(lookupCard('GD02-099'), 0));
  assert.equal(getAP(enemy), 3, 'under 4 (Gjallarhorn) trash -- no debuff');

  for (let i = 0; i < 4; i++) player.trash.push(createInstance({ number: 'G', type: 'unit', traits: ['Gjallarhorn'] }, 0));
  const unit2 = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 1, hp: 1, level: 5 });
  pairPilot(state, player, unit2, createInstance(lookupCard('GD02-099'), 0));
  assert.equal(getAP(enemy), 1, '4+ (Gjallarhorn) cards in trash -- AP-2 applied');
});

test('Dramatic Turnabout (R+) GD02-100 Main recovers 2 HP on a damaged friendly Unit then draws, Burst draws 1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 5 });
  unit.damage = 3;
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));

  const { dramaticTurnaboutBurst } = require('../src/effects/registry');
  dramaticTurnaboutBurst(state, player);
  assert.equal(player.hand.length, 1, 'Burst drew 1');

  playCommand(state, player, lookupCard('GD02-100'));
  assert.equal(unit.damage, 1, 'recovered 2 HP');
  assert.equal(player.hand.length, 2, 'Main drew another card on top of the Burst draw');
});

test('Beneath the Mask GD02-101 rests 1 to 2 Lv.2-or-lower enemy Units', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const low1 = deployUnit(state, opponent, { number: 'L1', type: 'unit', ap: 1, hp: 1, level: 2 });
  const low2 = deployUnit(state, opponent, { number: 'L2', type: 'unit', ap: 2, hp: 1, level: 1 });
  const high = deployUnit(state, opponent, { number: 'H', type: 'unit', ap: 1, hp: 1, level: 3 });

  playCommand(state, player, lookupCard('GD02-101'));
  assert.equal(low1.rested, true);
  assert.equal(low2.rested, true);
  assert.equal(high.rested, false, 'too high a Lv. to be a legal target');
});

test("Mouar's Determination GD02-102 buffs a friendly (Titans) Unit AP+2 for the turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const titansUnit = deployUnit(state, player, { number: 'T', type: 'unit', ap: 2, hp: 2, traits: ['Titans'] });
  playCommand(state, player, lookupCard('GD02-102'));
  assert.equal(getAP(titansUnit), 4);
});

test('AGE Device (R+) GD02-103 Burst retrieves an (Asuno Family) Pilot from trash, Main places EX Resource only with an (AGE System) Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const asunoPilot = createInstance({ number: 'P', type: 'pilot', traits: ['Asuno Family'] }, 0);
  player.trash.push(asunoPilot);
  const { ageDeviceRPlusBurst } = require('../src/effects/registry');
  ageDeviceRPlusBurst(state, player, null, {});
  assert.ok(player.hand.includes(asunoPilot), 'retrieved the (Asuno Family) Pilot from trash');

  playCommand(state, player, lookupCard('GD02-103'));
  assert.equal(player.resourceArea.length, 0, 'no (AGE System) Unit in play -- no EX Resource');

  deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1, traits: ['AGE System'] });
  playCommand(state, player, lookupCard('GD02-103'));
  assert.equal(player.resourceArea.length, 1, '(AGE System) Unit in play -- placed 1 EX Resource');
});

test('Turning Point of History GD02-104 keeps a Unit/Base on top of a 3-card dig, draws 1 only with a (Newtype) Pilot in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const command1 = createInstance({ number: 'C1', type: 'command' }, 0);
  const unitCard = createInstance({ number: 'U1', type: 'unit' }, 0);
  const command2 = createInstance({ number: 'C2', type: 'command' }, 0);
  player.deck.push(command1, unitCard, command2);

  playCommand(state, player, lookupCard('GD02-104'));
  assert.equal(player.deck[0], unitCard, 'kept the Unit card on top');
  assert.equal(player.deck.length, 3, 'no (Newtype) Pilot in play -- no draw');

  player.deck.length = 0;
  player.deck.push(command1, unitCard, command2);
  const newtypeUnit = deployUnit(state, player, { number: 'N', type: 'unit', ap: 1, hp: 1 });
  pairPilot(state, player, newtypeUnit, createInstance({ number: 'P', type: 'pilot', traits: ['Newtype'] }, 0));
  playCommand(state, player, lookupCard('GD02-104'));
  assert.equal(player.hand.length, 1, '(Newtype) Pilot in play -- drew 1');
});

test('Valedictorian GD02-105 makes a friendly token immune to battle damage for the battle', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const token = deployUnit(state, player, { number: 'TK', type: 'unit', ap: 1, hp: 3, isToken: true });
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 5, hp: 5 });
  attacker.turnDeployed = -1;

  playCommand(state, player, lookupCard('GD02-105'));
  resolveAttack(state, 1, attacker, { type: 'unit', instance: token }, noBlockHooks());
  assert.equal(token.damage, 0, 'immune to battle damage this battle');
});

test('White Wolf GD02-106 protects the shield area from Lv.3-or-lower enemy Units for the battle', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 6; i++) player.shields.push(createInstance({ number: 'S', type: 'shield' }, 0));

  const weakAttacker = deployUnit(state, opponent, { number: 'A', type: 'unit', ap: 1, hp: 1, level: 3 });
  weakAttacker.turnDeployed = -1;

  playCommand(state, player, lookupCard('GD02-106'));
  resolveAttack(state, 1, weakAttacker, { type: 'player' }, noBlockHooks());
  assert.equal(player.shields.length, 6, "Lv.3 enemy -- shield area immune this battle");
});

test('All-Range Attack (R+) GD02-107 Main deals 1 damage to every non-Link enemy Unit, Burst deals 1 to a chosen enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const linkUnit = deployUnit(state, opponent, { number: 'L', type: 'unit', ap: 1, hp: 3 });
  linkUnit.isLinkUnit = true;
  const normalUnit = deployUnit(state, opponent, { number: 'N', type: 'unit', ap: 5, hp: 3 });

  playCommand(state, player, lookupCard('GD02-107'));
  assert.equal(linkUnit.damage, 0, 'Link Units are excluded');
  assert.equal(normalUnit.damage, 1, 'non-Link enemy Unit took 1 damage');

  const { allRangeAttackRPlusBurst } = require('../src/effects/registry');
  allRangeAttackRPlusBurst(state, player, null, {});
  assert.equal(normalUnit.damage, 2, 'Burst dealt 1 more damage to the chosen enemy');
});

test('That One Looks A Lot Stronger? GD02-108 lets a friendly (Clan) Unit target an active Lv.4-or-lower enemy this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const clanUnit = deployUnit(state, player, { number: 'C', type: 'unit', ap: 3, hp: 3, traits: ['Clan'] });
  playCommand(state, player, lookupCard('GD02-108'));
  assert.ok(clanUnit.buffs.some((b) => b.activeTargetLevelCap === 4));
});

test('Undying Persistence GD02-109 deals 1 damage to a chosen enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 3 });
  playCommand(state, player, lookupCard('GD02-109'));
  assert.equal(enemy.damage, 1);
});
