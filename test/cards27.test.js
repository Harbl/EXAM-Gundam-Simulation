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

function fillTrash(player, count, def = { number: 'X', type: 'unit' }) {
  for (let i = 0; i < count; i++) player.trash.push(createInstance(def, player.id));
}

test('Gundam Leopard GD02-064 ignores enemy Command effect damage during its controller\'s own turn with 7+ trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const leopard = deployUnit(state, player, lookupCard('GD02-064'));
  const pingCommand = { number: 'C', type: 'command', effects: { command: (s, p) => {
    const { dealEffectDamage } = require('../src/rules/effects');
    dealEffectDamage(s, p, player, leopard, 2);
  } } };

  playCommand(state, opponent, pingCommand);
  assert.equal(leopard.damage, 2, 'under 7 trash -- no immunity yet');

  fillTrash(player, 7);
  playCommand(state, opponent, pingCommand);
  assert.equal(leopard.damage, 2, '7+ trash on its own turn -- enemy Command damage ignored');

  state.activePlayerIdx = 1;
  playCommand(state, opponent, pingCommand);
  assert.equal(leopard.damage, 4, "opponent's turn now -- immunity does not apply");
});

test('Gouf Vijayanta EB01-014 is immune to enemy Unit (not Command) effect damage from a Lv.5-or-lower source, only on the opponent\'s turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { dealEffectDamage, fireCardEffect } = require('../src/rules/effects');

  const gouf = deployUnit(state, player, lookupCard('EB01-014'));
  const lowLevelSource = deployUnit(state, opponent, { number: 'S1', type: 'unit', level: 5, ap: 1, hp: 1,
    effects: { attack: (s, p) => dealEffectDamage(s, p, player, gouf, 1) } });
  const highLevelSource = deployUnit(state, opponent, { number: 'S2', type: 'unit', level: 6, ap: 1, hp: 1,
    effects: { attack: (s, p) => dealEffectDamage(s, p, player, gouf, 1) } });

  state.activePlayerIdx = 1; // opponent's turn, relative to Gouf's controller
  fireCardEffect(state, opponent, lowLevelSource, 'attack', {});
  assert.equal(gouf.damage, 0, 'Lv.5 enemy Unit source, opponent\'s turn -- immune');

  fireCardEffect(state, opponent, highLevelSource, 'attack', {});
  assert.equal(gouf.damage, 1, 'Lv.6 enemy Unit source -- too high Level, not immune');

  state.activePlayerIdx = 0; // now Gouf controller's own turn
  fireCardEffect(state, opponent, lowLevelSource, 'attack', {});
  assert.equal(gouf.damage, 2, 'same Lv.5 source, but not the opponent\'s turn anymore -- immunity does not apply');
});

test('Gouf Vijayanta EB01-014\'s immunity does not apply to enemy Command effect damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { dealEffectDamage } = require('../src/rules/effects');

  const gouf = deployUnit(state, player, lookupCard('EB01-014'));
  const pingCommand = { number: 'C', type: 'command', effects: { command: (s, p) => dealEffectDamage(s, p, player, gouf, 1) } };

  state.activePlayerIdx = 1;
  playCommand(state, opponent, pingCommand);
  assert.equal(gouf.damage, 1, 'a Command, not a Unit -- Gouf\'s immunity is specifically "from enemy Units"');
});

test('Gundam Barbatos 3rd Form GD02-068 Deploy deals 2 damage to itself', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const barbatos = deployUnit(state, player, lookupCard('GD02-068'));
  assert.equal(barbatos.damage, 2);
});

test('Zeta Gundam (LR+) GD02-069 Activate*Main rests an active friendly Base to set itself active, restricted to Once per Turn and During Link, and forbids attacking the player that turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const zeta = deployUnit(state, player, lookupCard('GD02-069'));
  const { zetaGundamLRPlusActivateMain } = require('../src/effects/registry');

  assert.equal(zetaGundamLRPlusActivateMain(state, player, zeta), false, 'not linked yet -- no Base to boot');

  pairPilot(state, player, zeta, createInstance({ number: 'P', name: 'Kamille Bidan', type: 'pilot' }, 0));
  assert.equal(zetaGundamLRPlusActivateMain(state, player, zeta), false, 'linked but no friendly Base in play');

  player.base = createInstance({ number: 'B', type: 'base', color: 'white', ap: 0, hp: 6 }, 0);
  zeta.rested = true;
  assert.equal(zetaGundamLRPlusActivateMain(state, player, zeta), true);
  assert.ok(player.base.rested, 'rested the Base as the cost');
  assert.equal(zeta.rested, false, 'set itself active');
  assert.ok(zeta.buffs.some((b) => b.cannotAttackPlayer), "can't attack the player this turn");

  assert.equal(zetaGundamLRPlusActivateMain(state, player, zeta), false, 'Once per Turn -- already used');
});

test('Gundam Kimaris (LR+) GD02-070 Deploy draws 2 and discards 2, but only with 4+ (Gjallarhorn) cards in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  for (let i = 0; i < 5; i++) player.deck.push(createInstance({ number: 'D', type: 'unit' }, 0));
  for (let i = 0; i < 3; i++) player.hand.push(createInstance({ number: 'H', type: 'unit', cost: 1 }, 0));

  deployUnit(state, player, lookupCard('GD02-070'));
  assert.equal(player.hand.length, 3, 'under 4 (Gjallarhorn) trash -- Deploy did not fire');

  fillTrash(player, 4, { number: 'G', type: 'unit', traits: ['Gjallarhorn'] });
  deployUnit(state, player, lookupCard('GD02-070'));
  assert.equal(player.hand.length, 3, '2 drawn then 2 discarded -- net unchanged, but both halves fired');
  assert.equal(player.trash.length, 4 + 2, 'the 2 discards landed in trash');
});

test('Gundam Mk-II (AEUG) GD02-071 Deploy pairs an (AEUG) Pilot from hand, but only with a friendly white Base in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const aeugPilot = createInstance({ number: 'P', type: 'pilot', traits: ['AEUG'] }, 0);
  player.hand.push(aeugPilot);

  const mkII = deployUnit(state, player, lookupCard('GD02-071'));
  assert.equal(mkII.pilot, null, 'no friendly white Base yet');

  player.base = createInstance({ number: 'B', type: 'base', color: 'white', ap: 0, hp: 6 }, 0);
  const mkII2 = deployUnit(state, player, lookupCard('GD02-071'));
  assert.equal(mkII2.pilot, aeugPilot, 'white Base in play -- paired the (AEUG) Pilot from hand');
  assert.ok(!player.hand.includes(aeugPilot), 'removed from hand');
});

test('Hyaku-Shiki (R+) GD02-072: Blocker (data), and gains Repair 1 only while a friendly white Base is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const hyakuShiki = deployUnit(state, player, lookupCard('GD02-072'));
  assert.ok(getKeywords(hyakuShiki).blocker);
  hyakuShiki.damage = 2;
  const { applyRepairAtEndOfTurn } = require('../src/rules/effects');
  applyRepairAtEndOfTurn(state, player);
  assert.equal(hyakuShiki.damage, 2, 'no white Base yet -- no Repair');

  player.base = createInstance({ number: 'B', type: 'base', color: 'white', ap: 0, hp: 6 }, 0);
  applyRepairAtEndOfTurn(state, player);
  assert.equal(hyakuShiki.damage, 1, 'white Base in play -- Repair 1 recovered 1 HP');
});

test("Carta's Graze Ritter (Ground Type) (R+) GD02-073 grants the attacking enemy Unit First Strike", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const carta = deployUnit(state, player, lookupCard('GD02-073'));
  const attacker = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 5, hp: 3 });
  attacker.turnDeployed = -1;

  resolveAttack(state, 1, attacker, { type: 'unit', instance: carta }, noBlockHooks());
  assert.equal(carta.damage, 5, 'took the enemy attacker\'s First-Strike damage');
  assert.equal(attacker.damage, 0, 'destroyed by First Strike before it could deal return damage');
});

test('Gundam Aerial Rebuild GD02-074: High-Maneuver (data), and gains Blocker During Pair only with 4+ Commands in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const aerial = deployUnit(state, player, lookupCard('GD02-074'));
  assert.ok(getKeywords(aerial).highManeuver);
  triggerEvent(state, 'startOfTurn', {});
  assert.ok(!getKeywords(aerial).blocker, 'not paired yet');

  pairPilot(state, player, aerial, createInstance({ number: 'P', type: 'pilot' }, 0));
  triggerEvent(state, 'startOfTurn', {});
  assert.ok(!getKeywords(aerial).blocker, 'paired but under 4 Commands in trash');

  fillTrash(player, 4, { number: 'CMD', type: 'command' });
  triggerEvent(state, 'startOfTurn', {});
  assert.ok(getKeywords(aerial).blocker, 'paired with 4+ Commands in trash -- gains Blocker');
});

test('Rick Dias (Red) GD02-075 Attack rests an active friendly Base to give a Lv.4 or lower enemy Unit AP-2 for the battle', () => {
  // Calls the ability directly rather than through resolveAttack, since resolveAttack always clears
  // scope:'battle' buffs at its own battle-end step -- that would wipe the debuff before it could be
  // observed here even though it's still correctly live for the actual triggering battle in real play.
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const rickDias = deployUnit(state, player, lookupCard('GD02-075'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', level: 4, ap: 3, hp: 5 });
  const { rickDiasRedAttack } = require('../src/effects/registry');

  rickDiasRedAttack(state, player, rickDias);
  assert.equal(getAP(enemy), 3, 'no friendly Base in play -- no debuff');

  player.base = createInstance({ number: 'B', type: 'base', color: 'white', ap: 0, hp: 6 }, 0);
  rickDiasRedAttack(state, player, rickDias);
  assert.ok(player.base.rested, 'rested the Base as the cost');
  assert.equal(getAP(enemy), 1, '4 base AP - 2 debuff');
});

test('Buster Gundam GD02-076 gains Blocker only while it has 5 or more AP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);

  const buster = deployUnit(state, player, lookupCard('GD02-076'));
  assert.equal(getAP(buster), 4);
  assert.ok(!getKeywords(buster).blocker, 'under 5 AP -- no Blocker');

  buster.buffs.push({ ap: 1, scope: 'turn' });
  assert.equal(getAP(buster), 5);
  assert.ok(getKeywords(buster).blocker, '5+ AP -- gains Blocker');
});
