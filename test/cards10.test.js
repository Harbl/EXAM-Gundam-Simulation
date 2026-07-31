const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP, getKeywords, dealDamage } = require('../src/rules/management');
const { resolveAttack, resolveUnitBattleDamage } = require('../src/rules/combat');
const { runAttacks } = require('../src/ai/heuristic');

test('Rouei deals 1 damage to a chosen friendly Unit and grants it AP+1 this turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', ap: 2, hp: 5 });

  lookupCard('GD03-067').effects.deploy(state, player, createInstance(lookupCard('GD03-067'), 0), {});
  assert.equal(ally.damage, 1);
  assert.equal(getAP(ally), 3, 'AP+1 during this turn');
});

test('Gundam Flauros (Ryusei-Go) destroys a Lv.2-or-lower enemy outright regardless of remaining HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weakEnemy = createInstance({ number: 'E', type: 'unit', level: 2, ap: 1, hp: 10 }, 1);
  const bigEnemy = createInstance({ number: 'E2', type: 'unit', level: 8, ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(weakEnemy, bigEnemy);

  lookupCard('GD05-060').effects.deploy(state, player, createInstance(lookupCard('GD05-060'), 0), {});
  assert.equal(opponent.battleArea.includes(weakEnemy), false, 'destroyed despite 10 HP remaining');
  assert.equal(opponent.battleArea.includes(bigEnemy), true, 'Lv.8 enemy is above the cap');
});

test("Akihiro Altland returns a (Tekkadan) Lv.2-or-lower Unit card from trash to hand, only while its Unit is Linked", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.trash.push(createInstance({ number: 'T', type: 'unit', level: 2, traits: ['Tekkadan'], ap: 1, hp: 1 }, 0));

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 2 });
  unit.pilot = createInstance(lookupCard('ST05-011'), 0);
  lookupCard('ST05-011').effects.destroysEnemy(state, player, unit, {});
  assert.equal(player.hand.length, 0, 'not a Link Unit yet');

  unit.isLinkUnit = true;
  lookupCard('ST05-011').effects.destroysEnemy(state, player, unit, {});
  assert.equal(player.hand.length, 1);
});

test('Shenlong Gundam Attack destroys a Blocker enemy that is Lv.3 or lower, ignoring higher-level Blockers', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const bigBlocker = createInstance({ number: 'B1', type: 'unit', level: 5, ap: 1, hp: 10, keywords: { blocker: true } }, 1);
  const smallBlocker = createInstance({ number: 'B2', type: 'unit', level: 2, ap: 1, hp: 10, keywords: { blocker: true } }, 1);
  opponent.battleArea.push(bigBlocker, smallBlocker);

  lookupCard('GD01-029').effects.attack(state, player, createInstance(lookupCard('GD01-029'), 0), {});
  assert.equal(opponent.battleArea.includes(smallBlocker), false);
  assert.equal(opponent.battleArea.includes(bigBlocker), true);
});

test('Altron Gundam Attack deals 5 damage to a Blocker enemy of any level', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const blocker = createInstance({ number: 'B', type: 'unit', level: 8, ap: 1, hp: 10, keywords: { blocker: true } }, 1);
  opponent.battleArea.push(blocker);

  lookupCard('GD03-018').effects.attack(state, player, createInstance(lookupCard('GD03-018'), 0), {});
  assert.equal(blocker.damage, 5);
});

test("Chang Wufei: while its Unit has Breach, it takes no return battle damage from a 3-or-less-AP defender, but still takes it from a stronger one", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 5, hp: 5, keywords: { breach: 2 } });
  unit.pilot = createInstance(lookupCard('GD01-091'), 0);

  const weakDefender = createInstance({ number: 'D1', type: 'unit', ap: 3, hp: 100 }, 1);
  resolveUnitBattleDamage(state, player, opponent, unit, weakDefender, {});
  assert.equal(unit.damage, 0, 'immune to 3-AP return damage while it has Breach');

  const strongDefender = createInstance({ number: 'D2', type: 'unit', ap: 4, hp: 100 }, 1);
  resolveUnitBattleDamage(state, player, opponent, unit, strongDefender, {});
  assert.equal(unit.damage, 4, 'not immune to return damage above the AP cap');
});

test('Gundam Deathscythe Hell (EW) can attack a rested enemy Unit the turn it deploys, but never the player', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  const deathscythe = deployUnit(state, player, lookupCard('GD05-078'));
  const rested = createInstance({ number: 'R', type: 'unit', ap: 1, hp: 5 }, 1);
  rested.rested = true;
  opponent.battleArea.push(rested);

  runAttacks(state, 0, {});
  assert.equal(deathscythe.rested, true, 'it attacked despite deploying this turn');
  assert.equal(rested.damage, 5);
});

test('Gundam Deathscythe Hell (EW) does not attack at all on its deploy turn if no enemy Unit is rested', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  const deathscythe = deployUnit(state, player, lookupCard('GD05-078'));
  // A favorable trade in every respect except that it's active, not rested.
  const active = createInstance({ number: 'ACT', type: 'unit', ap: 1, hp: 3 }, 1);
  opponent.battleArea.push(active);

  runAttacks(state, 0, {});
  assert.equal(deathscythe.rested, false, "can't swing at the player on its deploy turn");
});

test('Unicorn Gundam 02 Banshee Norn (Destroy Mode): Activate*Main exiles 3 blue trash cards to set it active (and blocks it from attacking the player this turn); Attack debuffs all enemies AP-1', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unicorn = deployUnit(state, player, lookupCard('GD04-065'));
  unicorn.isLinkUnit = true;
  unicorn.rested = true;

  const tooFew = lookupCard('GD04-065').effects.activateMain(state, player, unicorn, {});
  assert.equal(tooFew, false, 'not enough blue cards in trash yet');

  for (let i = 0; i < 3; i++) player.trash.push(createInstance({ number: `BL${i}`, type: 'unit', color: 'blue' }, 0));
  const ok = lookupCard('GD04-065').effects.activateMain(state, player, unicorn, {});
  assert.equal(ok, true);
  assert.equal(unicorn.rested, false);
  assert.equal(player.trash.length, 0);

  const enemy = createInstance({ number: 'E', type: 'unit', ap: 3, hp: 3 }, 1);
  opponent.battleArea.push(enemy);
  lookupCard('GD04-065').effects.attack(state, player, unicorn, {});
  assert.equal(getAP(enemy), 2);
});

test('Riddhe Marcenas reduces effect damage its Unit receives by 2, only During Link', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 10 });
  unit.pilot = createInstance(lookupCard('GD04-098'), 0);

  dealDamage(unit, 3);
  assert.equal(unit.damage, 3, 'not linked yet, so no reduction');

  unit.isLinkUnit = true;
  dealDamage(unit, 3);
  assert.equal(unit.damage, 4, '3 effect damage reduced by 2');

  dealDamage(unit, 3, { isBattleDamage: true });
  assert.equal(unit.damage, 7, 'battle damage is unaffected by this reduction');
});

test('Presidential Office: Destroyed lets you exile it from trash to redeploy a hand copy as your new Base', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const office = deployBase(state, player, lookupCard('GD05-130'));
  const replacement = createInstance(lookupCard('GD05-130'), 0);
  player.hand.push(replacement);
  player.trash.push(office);
  player.base = null;

  lookupCard('GD05-130').effects.destroyed(state, player, office, {});
  assert.equal(player.trash.includes(office), false, 'exiled, not left in trash');
  assert.equal(player.base.def.name, 'Presidential Office');
  assert.equal(player.hand.includes(replacement), false);
});

test("Argama can't receive enemy effect damage at all, but Burst/Deploy still work normally", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit', ap: 0, hp: 1 }, 0));
  const argama = deployBase(state, player, lookupCard('GD02-129'));
  assert.equal(player.hand.length, 1, 'Deploy added a Shield to hand');

  dealDamage(argama, 100);
  assert.equal(argama.damage, 0, 'fully immune to effect damage');
});

test('Hoka Kyoten Juzetsujin grants Breach 3 (this turn) to an (MF) Unit that lacks Breach already', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const hasBreach = deployUnit(state, player, { number: 'H', type: 'unit', traits: ['MF'], ap: 1, hp: 1, keywords: { breach: 1 } });
  const noBreach = deployUnit(state, player, { number: 'N', type: 'unit', traits: ['MF'], ap: 1, hp: 1 });

  lookupCard('GD05-112').effects.command(state, player, createInstance(lookupCard('GD05-112'), 0), {});
  assert.equal(getKeywords(noBreach).breach, 3);
  assert.equal(getKeywords(hasBreach).breach, 1, 'already had Breach, so it was not a valid target');
});

test('Graviton Hammer rests a chosen enemy Unit that is Lv.4 or lower', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const tooBig = createInstance({ number: 'B', type: 'unit', level: 5, ap: 1, hp: 1 }, 1);
  const target = createInstance({ number: 'T', type: 'unit', level: 4, ap: 1, hp: 1 }, 1);
  opponent.battleArea.push(tooBig, target);

  lookupCard('GD05-122').effects.command(state, player, createInstance(lookupCard('GD05-122'), 0), {});
  assert.equal(target.rested, true);
  assert.equal(tooBig.rested, false);
});

test('Dragon Gundam deals 2 damage to a low-AP enemy once per turn when it destroys an enemy shield with damage', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;
  const dragon = deployUnit(state, player, lookupCard('GD05-035'));
  opponent.shields.push(createInstance({ number: 'S1', type: 'unit', ap: 0, hp: 1 }, 1));
  opponent.shields.push(createInstance({ number: 'S2', type: 'unit', ap: 0, hp: 1 }, 1));
  const lowAP = createInstance({ number: 'L', type: 'unit', ap: 2, hp: 5 }, 1);
  opponent.battleArea.push(lowAP);

  resolveAttack(state, 0, dragon, { type: 'player' }, {});
  assert.equal(lowAP.damage, 2);

  resolveAttack(state, 0, dragon, { type: 'player' }, {});
  assert.equal(lowAP.damage, 2, 'Once per Turn -- the second shield kill does not trigger again');
});
