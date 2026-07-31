const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot, becomeBase } = require('../src/rules/actions');
const { resolveAttack } = require('../src/rules/combat');
const { getAP, getKeywords, getRemainingHP } = require('../src/rules/management');

test('Jegan GD05-027 is vanilla (Lv.2/cost1/2AP/2HP), matching the vanilla-group banlist entry', () => {
  const def = lookupCard('GD05-027');
  assert.equal(def.level, 2);
  assert.equal(def.cost, 1);
  assert.equal(def.ap, 2);
  assert.equal(def.hp, 2);
  assert.deepEqual(def.effects, undefined);
});

test("Kayra's Re-GZ GD05-029 buries a non-Unit/Base top card, but leaves a Unit/Base on top", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const command = createInstance({ number: 'C', type: 'command' }, 0);
  const unit = createInstance({ number: 'U', type: 'unit' }, 0);
  player.deck.push(command, unit);

  deployUnit(state, player, lookupCard('GD05-029'));

  assert.equal(player.deck[0], unit, 'the command got buried, moving the unit to the top');
  assert.equal(player.deck[1], command);
});

test('Re-GZ GD05-019 reveals a (Londo Bell) Unit from the top 3 on Destroyed, burying the rest', () => {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 10, hp: 10 }, 0);
  attackingPlayer.battleArea.push(attacker);

  const target = deployUnit(state, defendingPlayer, lookupCard('GD05-019'));
  target.hp = 1;
  const londoBellUnit = createInstance({ number: 'L', type: 'unit', traits: ['Londo Bell'] }, 1);
  defendingPlayer.deck.push(londoBellUnit, { def: { type: 'command' } }, { def: { type: 'command' } });

  resolveAttack(state, 0, attacker, { type: 'unit', instance: target });

  assert.ok(defendingPlayer.hand.includes(londoBellUnit));
  assert.equal(defendingPlayer.deck.length, 2, 'the other 2 top cards get buried');
});

test('Gundam AGE-2 Normal (SP Ver.) GD05-024 fetches a green Earth Federation Pilot from trash, then discards a card', () => {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 10, hp: 10 }, 0);
  attackingPlayer.battleArea.push(attacker);

  const target = deployUnit(state, defendingPlayer, lookupCard('GD05-024'));
  target.hp = 1;
  const pilot = createInstance({ number: 'P', type: 'pilot', color: 'green', traits: ['Earth Federation'] }, 1);
  defendingPlayer.trash.push(pilot);
  const filler = createInstance({ number: 'F', type: 'unit', cost: 1 }, 1);
  defendingPlayer.hand.push(filler);

  resolveAttack(state, 0, attacker, { type: 'unit', instance: target });

  assert.equal(defendingPlayer.trash.includes(pilot), false);
  assert.equal(defendingPlayer.hand.length, 1, 'gained the pilot but discarded one card back out');
});

test('Nu Gundam GD05-020 only gains <Breach> while paired, and places an EX Resource on Deploy with 2+ Londo Bell in trash', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.trash.push(
    createInstance({ number: 'X1', type: 'unit', traits: ['Londo Bell'] }, 0),
    createInstance({ number: 'X2', type: 'unit', traits: ['Londo Bell'] }, 0)
  );

  const nuGundam = deployUnit(state, player, lookupCard('GD05-020'));
  assert.equal(getKeywords(nuGundam).breach, undefined, 'no Breach while unpaired');
  assert.equal(player.resourceArea.length, 1, 'EX Resource placed since 2 Londo Bell cards were already in trash');

  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  pairPilot(state, player, nuGundam, pilot);
  assert.equal(getKeywords(nuGundam).breach, 3, 'Breach 3 gained once paired');
});

test('Nu Gundam GD05-017 (When Paired) exiles 3 Londo Bell trash cards to force a damage-only mini battle', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 3; i++) {
    player.trash.push(createInstance({ number: `LB${i}`, type: 'unit', traits: ['Londo Bell'] }, 0));
  }
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 5 }, 1);
  opponent.battleArea.push(enemy);

  const nuGundam = deployUnit(state, player, lookupCard('GD05-017'));
  assert.equal(getKeywords(nuGundam).breach, 5);
  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);

  pairPilot(state, player, nuGundam, pilot);

  assert.equal(player.trash.length, 0, 'the 3 Londo Bell cards were exiled');
  assert.equal(player.removal.length, 3);
  assert.equal(nuGundam.rested, false, "the mini battle doesn't rest the attacker");
  assert.equal(getRemainingHP(enemy), 5 - getAP(nuGundam), 'the enemy took damage from the extra battle');
});

test('Amuro Ray GD05-085 heals its paired Unit 2 HP whenever that Unit destroys an enemy in battle', () => {
  const attackingPlayer = createPlayer(0);
  const defendingPlayer = createPlayer(1);
  const state = createGame(attackingPlayer, defendingPlayer);
  state.activePlayerIdx = 0;

  const attacker = deployUnit(state, attackingPlayer, { number: 'A', type: 'unit', ap: 5, hp: 5 });
  attacker.damage = 3;
  const pilot = createInstance(lookupCard('GD05-085'), 0);
  pairPilot(state, attackingPlayer, attacker, pilot);

  const weakEnemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 1 }, 1);
  defendingPlayer.battleArea.push(weakEnemy);

  resolveAttack(state, 0, attacker, { type: 'unit', instance: weakEnemy });

  assert.equal(attacker.damage, 2, 'started at 3, took 1 more from the enemy, then recovered 2 for destroying it');
});

test('Ra Cailum GD05-125: Burst deploys it as a Base, Deploy adds a Shield to hand, Activate-Main grants a friendly Londo Bell Unit Reduce 1 for the turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.shields.push(createInstance({ number: 'SH', type: 'unit' }, 0));
  const raCailum = createInstance(lookupCard('GD05-125'), 0);

  raCailum.def.effects.burst(state, player, raCailum);
  assert.equal(player.base, raCailum);
  assert.equal(player.hand.length, 1);

  const friendly = createInstance({ number: 'F', type: 'unit', traits: ['Londo Bell'], hp: 5 }, 0);
  player.battleArea.push(friendly);
  const ok = raCailum.def.effects.activateMain(state, player, raCailum, { target: friendly });
  assert.equal(ok, true);
  assert.equal(raCailum.rested, true);

  const { dealDamage } = require('../src/rules/management');
  dealDamage(friendly, 3);
  assert.equal(friendly.damage, 2, '<Reduce 1> knocked 1 off the incoming 3 damage');
});

test('Corsica Base ST02-016 only deploys its token on the controller\'s own turn, and upgrades to 2 Leos once a copy is in trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1; // opponent's turn -- e.g. Corsica Base got Burst-deployed off a shield hit
  player.shields.push(createInstance({ number: 'SH', type: 'unit' }, 0));

  const base1 = createInstance(lookupCard('ST02-016'), 0);
  base1.def.effects.deploy(state, player, base1, {});
  assert.equal(player.battleArea.length, 0, 'no token deploys off-turn');
  assert.equal(player.hand.length, 1, 'the Shield-to-hand part still happens regardless of turn');

  state.activePlayerIdx = 0; // now it's the controller's own turn
  player.shields.push(createInstance({ number: 'SH2', type: 'unit' }, 0));
  const base2 = createInstance(lookupCard('ST02-016'), 0);
  base2.def.effects.deploy(state, player, base2, {});
  assert.equal(player.battleArea.filter((u) => u.def.number === 'TOKEN-TALLGEESE').length, 1, 'first copy deploys a Tallgeese');

  player.trash.push(base2); // simulate this copy later getting trashed
  const base3 = createInstance(lookupCard('ST02-016'), 0);
  base3.def.effects.deploy(state, player, base3, {});
  assert.equal(player.battleArea.filter((u) => u.def.number === 'TOKEN-LEO').length, 2, 'a prior Corsica Base in trash upgrades to 2 Leos');
});
