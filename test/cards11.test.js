const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP } = require('../src/rules/management');
const { runAttacks, chooseAttackTarget } = require('../src/ai/heuristic');

test('Aegis Gundam Attack only fires its Lv.5+ 3-damage snipe once its own AP reaches 5', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const bigEnemy = createInstance({ number: 'E', type: 'unit', level: 5, ap: 1, hp: 10 }, 1);
  opponent.battleArea.push(bigEnemy);

  const unit = deployUnit(state, player, lookupCard('ST04-006'));
  lookupCard('ST04-006').effects.attack(state, player, unit, {});
  assert.equal(bigEnemy.damage, 0, 'base AP4 is below the threshold');

  unit.pilot = createInstance(lookupCard('ST04-011'), 0);
  assert.equal(getAP(unit), 5);
  lookupCard('ST04-006').effects.attack(state, player, unit, {});
  assert.equal(bigEnemy.damage, 3);
});

test('GFreD Activate*Main pays 1 resource + exiles a trashed Pilot to deal 1 to every enemy Unit, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 0));
  const pilotCard = createInstance({ number: 'P', type: 'pilot' }, 0);
  player.trash.push(pilotCard);
  const enemy1 = createInstance({ number: 'E1', type: 'unit', ap: 1, hp: 5 }, 1);
  const enemy2 = createInstance({ number: 'E2', type: 'unit', ap: 1, hp: 5 }, 1);
  opponent.battleArea.push(enemy1, enemy2);

  const gfred = createInstance(lookupCard('GD03-035'), 0);
  const ok = lookupCard('GD03-035').effects.activateMain(state, player, gfred, { exilePilot: pilotCard });
  assert.equal(ok, true);
  assert.equal(enemy1.damage, 1);
  assert.equal(enemy2.damage, 1);
  assert.equal(player.trash.includes(pilotCard), false, 'Pilot card is exiled, not just trashed again');
  assert.equal(player.resourceArea[0].rested, true);

  const again = lookupCard('GD03-035').effects.activateMain(state, player, gfred, { exilePilot: pilotCard });
  assert.equal(again, false, 'once per turn');
});

test('GFreD When Linked lets it target an active enemy with AP <= its own, but not a stronger active enemy', () => {
  const opponent = createPlayer(1);
  const gfred = createInstance(lookupCard('GD03-035'), 0);
  const weakActive = createInstance({ number: 'W', type: 'unit', ap: 4, hp: 2 }, 1);
  const strongActive = createInstance({ number: 'S', type: 'unit', ap: 6, hp: 2 }, 1);
  opponent.battleArea.push(weakActive, strongActive);

  assert.equal(chooseAttackTarget(opponent, gfred, true), null, 'not Linked yet, active enemies are illegal targets');

  gfred.buffs.push({ activeTargetAPCap: true, scope: 'turn' });
  const result = chooseAttackTarget(opponent, gfred, true);
  assert.equal(result.instance, weakActive, 'AP4 enemy <= GFreD (AP4) is now a legal active target, unlike the AP6 one');
});

test('Justice Gundam deploys a Fatum-00 Blocker token, and its During-Pair Attack lets one attack the turn it deploys', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  opponent.battleArea.push(createInstance({ number: 'E', type: 'unit', ap: 1, hp: 5 }, 1));

  const justice = deployUnit(state, player, lookupCard('GD01-066'));
  const token = player.battleArea.find((u) => u.def.number === 'TOKEN-FATUM00');
  assert.ok(token, 'Fatum-00 token deployed');
  assert.equal(getAP(token), 2);
  assert.equal(token.turnDeployed, state.turnNumber);

  lookupCard('GD01-066').effects.attack(state, player, justice, {});
  assert.equal(token.buffs.some((b) => b.canAttackOnDeployTurn), false, 'unpaired -- During Pair text is inert');

  justice.pilot = createInstance({ number: 'X', type: 'pilot' }, 0);
  lookupCard('GD01-066').effects.attack(state, player, justice, {});
  assert.ok(token.buffs.some((b) => b.canAttackOnDeployTurn));

  justice.rested = true;
  runAttacks(state, 0, {});
  assert.equal(token.rested, true, 'the freshly-deployed token actually attacked');
});

test('GQuuuuuuX (Omega Psycommu) Deploy deals 3 damage to a chosen enemy Unit, active or rested', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const activeEnemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 10 }, 1);
  opponent.battleArea.push(activeEnemy);

  lookupCard('GD03-034').effects.deploy(state, player, createInstance(lookupCard('GD03-034'), 0), {});
  assert.equal(activeEnemy.damage, 3);
});

test('Athrun Zala When Linked lets its Unit attack an active Lv.5-or-lower enemy this turn only', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 5, hp: 5, linkCondition: 'Athrun Zala' });
  unit.turnDeployed = -1;
  const target = createInstance({ number: 'T', type: 'unit', level: 5, ap: 1, hp: 4 }, 1);
  opponent.battleArea.push(target);

  const athrun = createInstance(lookupCard('ST04-011'), 0);
  pairPilot(state, player, unit, athrun);
  assert.equal(unit.isLinkUnit, true);
  const result = chooseAttackTarget(opponent, unit, true);
  assert.equal(result.instance, target, 'active Lv.5 enemy is a legal target this turn via the When Linked grant');
});

test("Nyaan When Linked mills the deck's top card and only deals 1 damage if it was Zeon/Clan", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 1, hp: 5 }, 1);
  opponent.battleArea.push(enemy);
  player.deck.push(createInstance({ number: 'D', type: 'unit', traits: ['Earth Federation'], ap: 1, hp: 1 }, 0));

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 3, hp: 3 });
  lookupCard('GD03-092').effects.whenLinked(state, player, unit, {});
  assert.equal(player.trash.length, 1, 'top card milled to trash');
  assert.equal(enemy.damage, 0, 'not a Zeon/Clan card, no damage');

  player.deck.push(createInstance({ number: 'D2', type: 'unit', traits: ['Zeon'], ap: 1, hp: 1 }, 0));
  lookupCard('GD03-092').effects.whenLinked(state, player, unit, {});
  assert.equal(enemy.damage, 1);
});

test('Chang Wufei Burst adds itself to hand (not the Reinforce Jr. become-a-Base pattern it was miswired to)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const instance = createInstance(lookupCard('GD01-091'), 0);

  lookupCard('GD01-091').effects.burst(state, player, instance);
  assert.equal(player.hand.includes(instance), true);
  assert.equal(player.base, null);
});
