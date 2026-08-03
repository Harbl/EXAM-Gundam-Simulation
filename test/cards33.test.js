const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords, getHP } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { dealEffectDamage } = require('../src/rules/effects');
const { chooseAttackTarget } = require('../src/ai/heuristic');

test('Bertigo (R+) GD03-037: During Link, gains First Strike only while battling an enemy Unit with a Destroyed effect', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const bertigo = deployUnit(state, player, lookupCard('GD03-037'));
  const plainEnemy = deployUnit(state, opponent, { number: 'E1', type: 'unit', ap: 1, hp: 5 });
  const destroyedEnemy = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5, effects: { destroyed: () => {} } });

  bertigo.def.effects.attack(state, player, bertigo, { target: { type: 'unit', instance: destroyedEnemy } });
  assert.equal(getKeywords(bertigo).firstStrike, undefined, 'not a Link Unit yet -- no First Strike');

  pairPilot(state, player, bertigo, createInstance({ number: 'P', name: 'Newtype Ace', type: 'pilot', traits: ['Newtype'] }, 0));
  bertigo.def.effects.attack(state, player, bertigo, { target: { type: 'unit', instance: plainEnemy } });
  assert.equal(getKeywords(bertigo).firstStrike, undefined, 'Link Unit, but the enemy has no Destroyed effect');

  bertigo.def.effects.attack(state, player, bertigo, { target: { type: 'unit', instance: destroyedEnemy } });
  assert.equal(getKeywords(bertigo).firstStrike, true, 'Link Unit battling a Destroyed-effect enemy -- gains First Strike');
});

test('GuAIZ (Commander Type) GD03-038 ActivateMain: Support 1 AP buff plus a bonus AP+2 to a chosen (ZAFT) ally', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const guaiz = deployUnit(state, player, lookupCard('GD03-038'));
  const supportTarget = deployUnit(state, player, { number: 'S', type: 'unit', ap: 2, hp: 2 });
  const zaftAlly = deployUnit(state, player, { number: 'Z', type: 'unit', ap: 1, hp: 1, traits: ['ZAFT'] });

  const ok = guaiz.def.effects.activateMain(state, player, guaiz, {
    target: supportTarget,
    hooks: { chooseUnit: () => zaftAlly }
  });
  assert.equal(ok, true);
  assert.equal(guaiz.rested, true);
  assert.equal(getAP(supportTarget), 3, 'Support 1 granted the target AP+1');
  assert.equal(getAP(zaftAlly), 3, 'rested-by-effect bonus granted the (ZAFT) ally AP+2');
});

test('Patulia GD03-041 Deploy deals 3 damage to all Bases', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const sturdyBase = { number: 'B', name: 'Base', type: 'base', ap: 0, hp: 10 };
  player.base = createInstance(sturdyBase, player.id);
  opponent.base = createInstance(sturdyBase, opponent.id);

  deployUnit(state, player, lookupCard('GD03-041'));
  assert.equal(player.base.damage, 3);
  assert.equal(opponent.base.damage, 3);
});

test('Duel Gundam (Assault Shroud) GD03-042 may target an active enemy Unit Lv.5 or lower, but only while its own AP is 5+', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const duel = deployUnit(state, player, lookupCard('GD03-042'));
  const activeEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 3, level: 5 });
  activeEnemy.rested = false;

  assert.notEqual(chooseAttackTarget(opponent, duel).type, 'unit', 'base AP is 3 -- no grant yet');

  duel.buffs.push({ ap: 2, scope: 'turn' });
  assert.equal(getAP(duel), 5);
  const target = chooseAttackTarget(opponent, duel);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, activeEnemy);
});

test('Messer Type-F02 GD03-043 When Paired deals 1 damage to a chosen enemy Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const messer = deployUnit(state, player, lookupCard('GD03-043'));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5 });

  pairPilot(state, player, messer, createInstance({ number: 'P', name: 'Mafty Pilot', type: 'pilot', traits: ['Mafty'] }, 0));
  assert.equal(enemy.damage, 1);
});

test('Daughtress Flyer GD03-044 Deploy deploys 1 rested Daughtress token', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('GD03-044'));
  const token = player.battleArea.find((u) => u.def.name === 'Daughtress');
  assert.ok(token && token.rested && token.def.isToken);
});

test('Balient GD03-045 gets AP+1 only while a Unit token is in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { balientStartOfTurn } = require('../src/effects/registry');
  const balient = deployUnit(state, player, lookupCard('GD03-045'));

  balientStartOfTurn(state, player, balient);
  assert.equal(getAP(balient), 2, 'no token in play -- no bonus');

  const token = deployUnit(state, player, { number: 'T', type: 'unit', ap: 0, hp: 1, isToken: true });
  balientStartOfTurn(state, player, balient);
  assert.equal(getAP(balient), 3, 'a Unit token is in play -- AP+1');
});

test('GFreD GD03-048 Burst deploys a rested GFreD token only if the enemy has 3 or fewer Shields', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const { gfreDBurst } = require('../src/effects/registry');
  opponent.shields = [1, 2, 3, 4].map((n) => createInstance({ number: 'SH' + n, type: 'shield' }, 1));

  gfreDBurst(state, player, {});
  assert.equal(player.battleArea.length, 0, '4 enemy Shields -- too many, no token');

  opponent.shields.pop();
  gfreDBurst(state, player, {});
  const token = player.battleArea.find((u) => u.def.name === 'GFreD');
  assert.ok(token && token.rested);
});

test('Gundam X Divider GD03-051 When Linked may pay-and-deploy a Lv.4-or-lower Unit from trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const divider = deployUnit(state, player, lookupCard('GD03-051'));
  const cheapUnit = createInstance({ number: 'C', type: 'unit', level: 3, cost: 0, ap: 1, hp: 1 }, 0);
  player.trash.push(cheapUnit);
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));

  pairPilot(state, player, divider, createInstance({ number: 'P', name: 'Garrod Ran', type: 'pilot' }, 0));
  assert.ok(player.battleArea.some((u) => u.def === cheapUnit.def), 'a new instance of the trashed card was deployed');
  assert.ok(!player.trash.includes(cheapUnit), 'the trash copy was consumed');
});

test('Gundam Virtue (R+) GD03-052: battle damage to a Lv.5-or-lower enemy destroys it outright, but only with a (CB) Pilot in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const virtue = deployUnit(state, player, lookupCard('GD03-052'));
  const lowLvEnemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 10, level: 5 });
  lowLvEnemy.rested = true;

  resolveAttack(state, 0, virtue, { type: 'unit', instance: lowLvEnemy });
  assert.notEqual(lowLvEnemy.damage, getHP(lowLvEnemy), 'no (CB) Pilot in play yet -- no outright destroy');

  const cbAlly = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1 });
  cbAlly.pilot = createInstance({ number: 'P', name: 'Tieria Erde', type: 'pilot', traits: ['CB'] }, 0);
  const lowLvEnemy2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 10, level: 5 });
  lowLvEnemy2.rested = true;
  resolveAttack(state, 0, virtue, { type: 'unit', instance: lowLvEnemy2 });
  assert.equal(lowLvEnemy2.damage, getHP(lowLvEnemy2), '(CB) Pilot in play -- destroyed outright');
});

test('chooseAttackTarget sends Gundam Virtue (R+) after a big rested enemy only once a (CB) Pilot is in play, matching its conditional force-destroy text', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const virtue = deployUnit(state, player, lookupCard('GD03-052'));
  const bigUnit = createInstance({ number: 'BIG', type: 'unit', level: 5, ap: 8, hp: 10 }, 1);
  bigUnit.rested = true;
  opponent.battleArea.push(bigUnit);

  assert.equal(chooseAttackTarget(opponent, virtue, false, player).type, 'player', 'no (CB) Pilot in play yet -- not worth attacking into an 8 AP unit on raw stats');

  const cbAlly = deployUnit(state, player, { number: 'A', type: 'unit', ap: 1, hp: 1 });
  cbAlly.pilot = createInstance({ number: 'P', name: 'Tieria Erde', type: 'pilot', traits: ['CB'] }, 0);
  const target = chooseAttackTarget(opponent, virtue, false, player);
  assert.equal(target.type, 'unit');
  assert.equal(target.instance, bigUnit, '(CB) Pilot now in play -- force-destroy execution target recognized');
});

test('Gundam Gusion Rebake Full City (R+) GD03-053: During Pair, Once per Turn, an allied (Tekkadan)/(Teiwaz) Unit taking effect damage lets it rest an enemy Lv.4 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gusion = deployUnit(state, player, lookupCard('GD03-053'));
  assert.equal(getKeywords(gusion).blocker, true);

  const tekkadanAlly = deployUnit(state, player, { number: 'T', type: 'unit', ap: 1, hp: 5, traits: ['Tekkadan'] });
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 1, hp: 5, level: 3 });
  enemy.rested = false;

  dealEffectDamage(state, opponent, player, tekkadanAlly, 1);
  assert.ok(!gusion.pilot, 'sanity: not yet paired');
  assert.equal(enemy.rested, false, 'not paired -- no reaction');

  pairPilot(state, player, gusion, createInstance({ number: 'P', name: 'Akihiro Altland', type: 'pilot' }, 0));
  dealEffectDamage(state, opponent, player, tekkadanAlly, 1);
  assert.equal(enemy.rested, true, 'paired -- rests the chosen low-level enemy');

  const enemy2 = deployUnit(state, opponent, { number: 'E2', type: 'unit', ap: 1, hp: 5, level: 3 });
  dealEffectDamage(state, opponent, player, tekkadanAlly, 1);
  assert.equal(enemy2.rested, false, 'Once per Turn -- already used');
});
