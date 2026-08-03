const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, deployBase, pairPilot, playCommand } = require('../src/rules/actions');
const { getAP, getKeywords, getRemainingHP, effectivePilotDef } = require('../src/rules/management');
const { canAfford, payCost } = require('../src/rules/cost');
const { runPairings } = require('../src/ai/heuristic');

function resource() {
  return createInstance({ number: 'RESOURCE', name: 'Resource', type: 'resource' }, 0);
}

test('Deep Devotion GD01-101 can be paired directly onto a Unit as if it were Lucrezia Noin (Pilot Command dual mode)', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const aries = deployUnit(state, player, lookupCard('GD01-007')); // linkCondition: Lucrezia Noin
  const deepDevotion = createInstance(lookupCard('GD01-101'), 0);
  player.hand.push(deepDevotion);

  const effDef = effectivePilotDef(deepDevotion);
  assert.equal(effDef.name, 'Lucrezia Noin');
  assert.equal(effDef.apBonus, 1);

  pairPilot(state, player, aries, deepDevotion);
  assert.equal(aries.isLinkUnit, true, 'matches Aries\' link condition via pilotMode name, not the Command\'s own name');
  assert.equal(getAP(aries), aries.def.ap + 1, 'AP bonus comes from pilotMode, not the (absent) top-level apBonus');
  assert.equal(player.hand.includes(deepDevotion), false);
});

test("runPairings' AI heuristic will pick a Pilot Command as a pairing candidate when one is in hand", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const aries = deployUnit(state, player, lookupCard('GD01-007'));
  player.resourceArea.push(resource(), resource()); // Lv.2 needs 2 Resources in play, cost 1 needs 1 active
  const deepDevotion = createInstance(lookupCard('GD01-101'), 0);
  player.hand.push(deepDevotion);

  runPairings(state, player);
  assert.equal(aries.pilot, deepDevotion);
  assert.equal(aries.isLinkUnit, true);
});

test('Deep Devotion GD01-101 played as a Command instead: heals the most-damaged friendly Link Unit for 3', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const linked = deployUnit(state, player, { number: 'L', type: 'unit', hp: 5 });
  linked.isLinkUnit = true;
  linked.damage = 4;
  const unlinked = deployUnit(state, player, { number: 'U', type: 'unit', hp: 5 });
  unlinked.damage = 4;

  playCommand(state, player, lookupCard('GD01-101'));
  assert.equal(getRemainingHP(linked), 4, '5 - 4 + 3 recovered, capped by no overheal needed here');
  assert.equal(getRemainingHP(unlinked), 1, 'not a Link Unit -- untouched');
});

test('Intercept Orders GD01-099: Burst rests 1 enemy Unit with <=5 HP; Main rests up to 2 enemies with <=3 HP', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const a = createInstance({ number: 'A', type: 'unit', hp: 3 }, 1);
  const b = createInstance({ number: 'B', type: 'unit', hp: 3 }, 1);
  const c = createInstance({ number: 'C', type: 'unit', hp: 5 }, 1);
  opponent.battleArea.push(a, b, c);
  const card = lookupCard('GD01-099');

  card.effects.command(state, player, null, {});
  assert.equal(a.rested, true);
  assert.equal(b.rested, true);
  assert.equal(c.rested, false, '5 HP is too high for the Main mode (<=3)');
});

test('Fortress Defense GD01-106 deploys 2 [Zaku] AP1/HP1 tokens', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  playCommand(state, player, lookupCard('GD01-106'));
  const zakus = player.battleArea.filter((u) => u.def.number === 'TOKEN-ZAKU');
  assert.equal(zakus.length, 2);
  assert.equal(getAP(zakus[0]), 1);
});

test('First Contact GD01-107: Burst places 1 active EX Resource; Main places 1 rested Resource', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const card = lookupCard('GD01-107');
  card.effects.burst(state, player, null);
  assert.equal(player.resourceArea.length, 1);
  assert.equal(player.resourceArea[0].rested, false);

  player.resourceDeck.push(resource());
  card.effects.command(state, player, null, {});
  assert.equal(player.resourceArea.length, 2);
  assert.equal(player.resourceArea[1].rested, true);
});

test('Strategic Arms GD01-108 deals 2 to every Blocker on the field, both sides', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const myBlocker = deployUnit(state, player, { number: 'MB', type: 'unit', hp: 5, keywords: { blocker: true } });
  const theirBlocker = deployUnit(state, opponent, { number: 'TB', type: 'unit', hp: 5, keywords: { blocker: true } });
  const theirNonBlocker = deployUnit(state, opponent, { number: 'TN', type: 'unit', hp: 5 });

  playCommand(state, player, lookupCard('GD01-108'));
  assert.equal(myBlocker.damage, 2);
  assert.equal(theirBlocker.damage, 2);
  assert.equal(theirNonBlocker.damage, 0);
});

test('The Path to Victory or Defeat GD01-109 finds an (Operation Meteor)/(G Team) card in the top 5 and buries the rest', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const match = createInstance({ number: 'M', type: 'pilot', traits: ['G Team'] }, 0);
  player.deck.push(
    createInstance({ number: 'X1', type: 'unit', traits: [] }, 0),
    match,
    createInstance({ number: 'X2', type: 'unit', traits: [] }, 0)
  );
  playCommand(state, player, lookupCard('GD01-109'));
  assert.equal(player.hand.includes(match), true);
  assert.equal(player.deck.length, 2, 'the other 2 top-5 cards were buried');
});

test('Side 7 GD01-124 Activate·Main rests itself to heal the most-damaged friendly Unit for 1', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const base = deployBase(state, player, lookupCard('GD01-124'));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', hp: 5 });
  unit.damage = 3;

  const result = base.def.effects.activateMain(state, player, base, {});
  assert.equal(result, true);
  assert.equal(base.rested, true);
  assert.equal(getRemainingHP(unit), 3, '2 remaining + 1 recovered');
  assert.equal(base.def.effects.activateMain(state, player, base, {}), false, 'already rested -- can\'t reactivate');
});

test('Zanzibar GD01-125 Deploy cascades a free Lv.4-or-lower (Zeon) Unit deploy from hand, only on your own turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.activePlayerIdx = 1; // not this player's turn
  const zeonCard = createInstance({ number: 'ZC', type: 'unit', traits: ['Zeon'], level: 3 }, 0);
  player.hand.push(zeonCard);
  deployBase(state, player, lookupCard('GD01-125'));
  assert.equal(player.hand.includes(zeonCard), true, 'not your turn -- no cascade deploy');

  state.activePlayerIdx = 0;
  deployBase(state, player, lookupCard('GD01-125'));
  assert.equal(player.hand.includes(zeonCard), false);
  assert.equal(player.battleArea.some((u) => u.def.number === 'ZC'), true);
});

test('Gamow GD01-127 Activate·Action rests itself to grant Breach 3 for the battle to a (ZAFT) Unit with 5+ AP', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const base = deployBase(state, player, lookupCard('GD01-127'));
  const weakZaft = deployUnit(state, player, { number: 'WZ', type: 'unit', traits: ['ZAFT'], ap: 4, hp: 3 });
  const strongZaft = deployUnit(state, player, { number: 'SZ', type: 'unit', traits: ['ZAFT'], ap: 5, hp: 3 });

  const result = base.def.effects.activateAction(state, player, base, {});
  assert.equal(result, true);
  assert.equal(getKeywords(strongZaft).breach, 3);
  assert.equal(getKeywords(weakZaft).breach, undefined);
});

test('13th Tactical Testing Sector GD01-130 Activate·Main only works with a friendly (Academy) Unit in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const base = deployBase(state, player, lookupCard('GD01-130'));
  const enemy = createInstance({ number: 'E', type: 'unit', ap: 3, hp: 3 }, 1);
  opponent.battleArea.push(enemy);

  assert.equal(base.def.effects.activateMain(state, player, base, {}), false, 'no (Academy) Unit yet');
  deployUnit(state, player, { number: 'AC', type: 'unit', traits: ['Academy'], ap: 1, hp: 1 });
  assert.equal(base.def.effects.activateMain(state, player, base, {}), true);
  assert.equal(getAP(enemy), 2);
});

test('Covert Operative GD01-122 bounces a Lv.2-HP enemy normally, or a 4-HP enemy if you have a Link Unit', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const fourHp = createInstance({ number: 'F', type: 'unit', hp: 4 }, 1);
  opponent.battleArea.push(fourHp);

  playCommand(state, player, lookupCard('GD01-122'));
  assert.equal(opponent.battleArea.includes(fourHp), true, 'no Link Unit in play -- 4 HP is too high a threshold');

  const linkUnit = deployUnit(state, player, { number: 'LU', type: 'unit' });
  linkUnit.isLinkUnit = true;
  playCommand(state, player, lookupCard('GD01-122'));
  assert.equal(opponent.battleArea.includes(fourHp), false, 'now has a Link Unit -- 4 HP is a legal target');
  assert.equal(opponent.hand.includes(fourHp), true);
});

test('The Witch and the Bride GD01-121/117 Burst re-activates the card\'s own Main text', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const lowHp = createInstance({ number: 'L', type: 'unit', hp: 5 }, 1);
  opponent.battleArea.push(lowHp);
  const card = lookupCard('GD01-117');

  card.effects.burst(state, player, createInstance(card, 0), {});
  assert.equal(opponent.battleArea.includes(lowHp), false, 'Burst activated Main, which bounced the 5 HP enemy Unit');
  assert.equal(opponent.hand.includes(lowHp), true);
});
