const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit } = require('../src/rules/actions');
const { resolveAttack } = require('../src/rules/combat');
const { dealDamage } = require('../src/rules/management');
const { chooseAttackTarget } = require('../src/ai/heuristic');
const registry = require('../src/effects/registry');

test('Character Requests EB01-073: Burst draws 1; Main draws 2 only at 6+ rested Units in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  registry.characterRequestsBurst(state, player);
  assert.equal(player.hand.length, 1);

  for (let i = 0; i < 3; i++) deployUnit(state, player, { number: 'U' + i, type: 'unit', ap: 1, hp: 1 }).rested = true;
  registry.characterRequestsCommand(state, player);
  assert.equal(player.hand.length, 1, 'only 3 rested: no draw');

  for (let i = 0; i < 3; i++) deployUnit(state, opponent, { number: 'E' + i, type: 'unit', ap: 1, hp: 1 }).rested = true;
  player.deck.push(createInstance({ number: 'D2', type: 'unit' }, 0), createInstance({ number: 'D3', type: 'unit' }, 0));
  registry.characterRequestsCommand(state, player);
  assert.equal(player.hand.length, 3, '6 rested across both fields: drew 2');
});

test('Eternal Road EB01-074: Burst rests a 3-or-less-HP enemy; Command rests an active friendly (G Generation) Unit and then an active enemy', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const burstTarget = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 3 });
  registry.eternalRoadBurst(state, player);
  assert.equal(burstTarget.rested, true);

  const friendly = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 3, traits: ['G Generation'] });
  const enemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 1 });
  registry.eternalRoadCommand(state, player);
  assert.equal(friendly.rested, true);
  assert.equal(enemy.rested, true);
});

test('Fierce Enemy Assault EB01-075: Command rests up to 2 enemy Units with 2 or less HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const a = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 2 });
  const b = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 2, hp: 1 });
  const c = deployUnit(state, opponent, { number: 'E3', type: 'unit', ap: 1, hp: 5 });
  registry.fierceEnemyAssaultCommand(state, player);
  assert.equal(a.rested, true);
  assert.equal(b.rested, true);
  assert.equal(c.rested, false, '5 HP is out of range');
});

test('Gerbera Straight EB01-076: Command heals the most-damaged friendly (G Generation) Unit 3', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 5, traits: ['G Generation'] });
  dealDamage(target, 4);
  registry.gerberaStraightCommand(state, player);
  assert.equal(target.damage, 1);
});

test('Master League Begins EB01-077: Command redirects a battling target to a rested friendly (G Generation) Unit', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const redirect = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2, traits: ['G Generation'] });
  redirect.rested = true;
  const battleTarget = { type: 'player' };
  registry.masterLeagueBeginsCommand(state, player, null, { battleTarget });
  assert.equal(battleTarget.type, 'unit');
  assert.equal(battleTarget.instance, redirect);
});

test('Premium Unit Assembly EB01-078: Command lets both players take a Unit card off the top of their deck', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0));
  opponent.deck.push(createInstance({ number: 'D2', type: 'command' }, 1));
  registry.premiumUnitAssemblyCommand(state, player);
  assert.equal(player.hand.some((c) => c.def.number === 'D1'), true);
  assert.equal(opponent.hand.length, 0, 'top card is a Command: stays on the deck');
});

test('Modification EB01-079: Command grants a friendly (G Generation) Unit immunity to Lv.3- enemy battle damage for the turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const defender = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 3, hp: 5, traits: ['G Generation'] });
  const attacker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 3, hp: 3, level: 3 });

  resolveAttack(state, 1, attacker, { type: 'unit', instance: defender }, {});
  assert.equal(defender.damage, 3, 'no immunity yet: normal damage');

  defender.damage = 0;
  attacker.rested = false;
  registry.modificationCommand(state, player, null, {});
  resolveAttack(state, 1, attacker, { type: 'unit', instance: defender }, {});
  assert.equal(defender.damage, 0, 'immune to this Lv.3 attacker');
});

test('Sturm Faust EB01-080: Command lets a (G Generation) Unit target any active enemy this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 5, hp: 5, traits: ['G Generation'] });
  const activeHighLevel = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 9 });

  assert.equal(chooseAttackTarget(opponent, attacker, true), null, 'no grant yet');
  registry.sturmFaustCommand(state, player, null, {});
  const result = chooseAttackTarget(opponent, attacker, true);
  assert.equal(result.instance, activeHighLevel);
});

test('MAP Weapon EB01-081: Command bounces up to 2 enemy Units with 2 or less HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const a = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 2 });
  const b = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5 });
  registry.mapWeaponCommand(state, player);
  assert.equal(opponent.battleArea.includes(a), false);
  assert.equal(opponent.battleArea.includes(b), true);
});

test('Warship Cruise EB01-082: Burst aliases the Action, bouncing a Lv.3- enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 1, level: 3 });
  registry.warshipCruiseBurst(state, player, null, {});
  assert.equal(opponent.battleArea.includes(target), false);
  assert.equal(opponent.hand.includes(target), true);
});

test("SP Conversion Chips EB01-083: Command gives AP+3 for the turn only during the opponent's turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const target = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 2, hp: 2 });

  state.activePlayerIdx = 0;
  registry.spConversionChipsCommand(state, player, null, { target });
  assert.equal(target.buffs.length, 0);

  state.activePlayerIdx = 1;
  registry.spConversionChipsCommand(state, player, null, { target });
  assert.equal(target.buffs.some((b) => b.ap === 3), true);
});

test("30cm Cannon (APFSDS Round) EB01-084: Command sets a Blocker Unit (either side) active and locks it from attacking this turn", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemyBlocker = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 2, hp: 3, keywords: { blocker: true } });
  enemyBlocker.rested = true;
  registry.cm30CannonAPFSDSRoundCommand(state, player, null, {});
  assert.equal(enemyBlocker.rested, false);
  assert.equal(enemyBlocker.buffs.some((b) => b.cannotAttack), true);
});
