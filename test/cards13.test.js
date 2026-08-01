const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');

test('Impulse Gundam Activate*Main pays 2, returns itself to the deck bottom, and deploys a Lv.4+ "Impulse Gundam" card from trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 2; i++) player.resourceArea.push(createInstance({ number: `R${i}`, type: 'resource' }, 0));
  const bigCousin = createInstance(lookupCard('ST09-002'), 0); // Force Impulse Gundam, Lv.5
  player.trash.push(bigCousin);

  const impulse = deployUnit(state, player, lookupCard('ST09-001'));
  const ok = lookupCard('ST09-001').effects.activateMain(state, player, impulse, { target: bigCousin });
  assert.equal(ok, true);
  assert.equal(player.battleArea.includes(impulse), false, 'the original Impulse Gundam left the battle area');
  assert.equal(player.deck.includes(impulse), true, 'and went to the bottom of the deck');
  assert.equal(player.battleArea.some((u) => u.def.number === 'ST09-002'), true, 'Force Impulse Gundam deployed');
});

test('Sword Impulse Gundam only destroys a Lv.3-or-lower enemy on Deploy if it was deployed from trash', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const weakEnemy = createInstance({ number: 'E', type: 'unit', level: 3, ap: 1, hp: 10 }, 1);
  opponent.battleArea.push(weakEnemy);

  deployUnit(state, player, lookupCard('ST09-006'));
  assert.equal(opponent.battleArea.includes(weakEnemy), true, 'a normal deploy from hand does nothing');

  deployUnit(state, player, lookupCard('ST09-006'), undefined, { fromTrash: true });
  assert.equal(opponent.battleArea.includes(weakEnemy), false, 'deploying from trash destroys it');
});

test('Force Impulse Gundam Destroyed returns a (Minerva Squad) card from trash to hand, excluding its own name', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const anotherCopy = createInstance(lookupCard('ST09-002'), 0);
  const ally = createInstance(lookupCard('ST09-006'), 0);
  player.trash.push(anotherCopy, ally);

  lookupCard('ST09-002').effects.destroyed(state, player, createInstance(lookupCard('ST09-002'), 0), {});
  assert.equal(player.hand.includes(ally), true);
  assert.equal(player.hand.includes(anotherCopy), false, "another Force Impulse Gundam doesn't qualify");
});

test("Destiny Gundam GD04-050's During-Pair Attack pays a trashed (Minerva Squad) card's cost and deploys it, but only while paired", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 4; i++) player.resourceArea.push(createInstance({ number: `R${i}`, type: 'resource', color: 'purple' }, 0));
  const trashedAlly = createInstance(lookupCard('ST09-006'), 0);
  player.trash.push(trashedAlly);

  const destiny = deployUnit(state, player, lookupCard('GD04-050'));
  lookupCard('GD04-050').effects.attack(state, player, destiny, {});
  assert.equal(player.battleArea.includes(trashedAlly), false, 'unpaired -- During Pair text is inert');

  destiny.pilot = createInstance({ number: 'X', type: 'pilot' }, 0);
  lookupCard('GD04-050').effects.attack(state, player, destiny, {});
  assert.equal(player.battleArea.some((u) => u.def.number === 'ST09-006'), true);
  assert.equal(player.resourceArea.filter((r) => r.rested).length, 2, "paid the card's cost of 2");
});

test('Destiny Gundam GD05-055 reduces incoming battle damage by 2, once per turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const destiny = deployUnit(state, player, lookupCard('GD05-055'));
  const attacker1 = createInstance({ number: 'A1', type: 'unit', ap: 5, hp: 5 }, 1);
  const attacker2 = createInstance({ number: 'A2', type: 'unit', ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(attacker1, attacker2);

  resolveAttack(state, 1, attacker1, { type: 'unit', instance: destiny }, {});
  assert.equal(destiny.damage, 3, 'first hit this turn is reduced by 2');

  resolveAttack(state, 1, attacker2, { type: 'unit', instance: destiny }, {});
  assert.equal(destiny.damage, 8, 'second hit the same turn is not reduced (once per turn)');
});

test('Shinn Asuka ST09-008 untaps a rested Resource on Attack, only while paired to a (Minerva Squad) Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const resource = createInstance({ number: 'R', type: 'resource' }, 0);
  resource.rested = true;
  player.resourceArea.push(resource);

  const nonMinerva = deployUnit(state, player, { number: 'U1', type: 'unit', ap: 1, hp: 1 });
  lookupCard('ST09-008').effects.attack(state, player, nonMinerva);
  assert.equal(resource.rested, true, 'not a Minerva Squad Unit, no untap');

  const minervaUnit = deployUnit(state, player, { number: 'U2', type: 'unit', traits: ['Minerva Squad'], ap: 1, hp: 1 });
  lookupCard('ST09-008').effects.attack(state, player, minervaUnit);
  assert.equal(resource.rested, false);
});

test('Zeheart Galette When Paired mills 2 and only debuffs an enemy AP-2 if a (Vagan) card was among them', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(enemy);
  player.deck.push(
    createInstance({ number: 'D1', type: 'unit', traits: ['Earth Federation'] }, 0),
    createInstance({ number: 'D2', type: 'unit', traits: ['Earth Federation'] }, 0)
  );

  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 2 });
  const zeheart = createInstance(lookupCard('GD03-094'), 0);
  pairPilot(state, player, unit, zeheart);
  assert.equal(player.trash.length, 2, 'both milled cards trashed');
  assert.equal(getAP(enemy), 5, 'no Vagan card milled, no debuff');

  player.deck.push(
    createInstance({ number: 'D3', type: 'unit', traits: ['Vagan'] }, 0),
    createInstance({ number: 'D4', type: 'unit', traits: ['Earth Federation'] }, 0)
  );
  const unit2 = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 2 });
  pairPilot(state, player, unit2, createInstance(lookupCard('GD03-094'), 0));
  assert.equal(getAP(enemy), 3, 'a Vagan card was milled this time');
});

test('Awakened Power pays a Lv.5-or-lower trashed Unit card\'s cost and deploys it', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 4; i++) player.resourceArea.push(createInstance({ number: `R${i}`, type: 'resource', color: 'purple' }, 0));
  const tooExpensive = createInstance({ number: 'X', type: 'unit', level: 3, cost: 5, color: 'purple', ap: 1, hp: 1 }, 0);
  const affordable = createInstance(lookupCard('ST09-006'), 0);
  player.trash.push(tooExpensive, affordable);

  lookupCard('GD02-110').effects.command(state, player, createInstance(lookupCard('GD02-110'), 0), {});
  assert.equal(player.battleArea.some((u) => u.def.number === 'ST09-006'), true);
  assert.equal(player.trash.includes(tooExpensive), true, "can't afford it, left in trash");
});

test('Minerva Deploy adds a Shield to hand always, but only scries the top 2 on its own turn', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  player.shields.push(createInstance({ number: 'S', type: 'unit' }, 0));
  player.deck.push(
    createInstance({ number: 'D1', type: 'command' }, 0),
    createInstance({ number: 'D2', type: 'unit' }, 0)
  );
  state.activePlayerIdx = 1; // opponent's turn

  const { deployBase } = require('../src/rules/actions');
  deployBase(state, player, lookupCard('ST09-010'));
  assert.equal(player.hand.length, 1, 'Shield still added to hand');
  assert.equal(player.deck.length, 2, "not player's turn, no scry");

  state.activePlayerIdx = 0;
  deployBase(state, player, lookupCard('ST09-010'));
  assert.equal(player.deck.length, 1, 'one card kept on top');
  assert.equal(player.deck[0].def.number, 'D2', 'the Unit card was kept over the Command');
  assert.equal(player.trash.some((c) => c.def.number === 'D1'), true);
});
