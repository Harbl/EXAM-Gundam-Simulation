const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, hasBetterLinkTargetInDeck, comboSearchOdds } = require('../src/rules/actions');
const { runPairings, chooseDiscards, runCommandsLookahead } = require('../src/ai/heuristic');
const { getLegalActions } = require('../src/ai/mcts');
const { enforceHandLimit } = require('../src/rules/management');
const { drawCard } = require('../src/rules/phases');

// Regression coverage for a real bug report: the AI used to pair a Pilot onto whatever unpaired Unit
// was on board immediately, even when a much better Link-condition target for that exact Pilot was
// still sitting undrawn in its own deck (e.g. Char Aznable pairing onto a plain Char's Zaku II the
// instant he's playable, instead of waiting for Zeong) -- including when a lesser but still-valid
// match (the Zaku) was already in play. A real player knows their own decklist and holds a Pilot for
// its real, best target -- see hasBetterLinkTargetInDeck/bestLinkMatch's doc comments (actions.js).

function charAznable() {
  return createInstance(lookupCard('ST03-011'), 0);
}

// Char Aznable is Lv.3/cost 1 -- 3 resource cards satisfies both the level gate (total count) and
// the cost gate (active count), so canAfford never confounds these tests with an unrelated "can't
// even play him yet" result.
function giveResources(player, n = 3) {
  for (let i = 0; i < n; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, player.id));
}

test('hasBetterLinkTargetInDeck is true while a matching Unit is still undrawn, false once none remain', () => {
  const player = createPlayer(0);
  player.deck.push(createInstance(lookupCard('GD04-017'), 0)); // Zeong -- links to Char Aznable
  const pilot = charAznable();
  assert.equal(hasBetterLinkTargetInDeck(player, pilot), true);

  player.deck.length = 0;
  assert.equal(hasBetterLinkTargetInDeck(player, pilot), false);
});

test('runPairings holds a Pilot rather than pairing it onto a non-matching Unit while its real target is still in the deck', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gm = deployUnit(state, player, lookupCard('ST01-005')); // GM -- no linkCondition at all, would never be more than a flat stat pairing
  player.deck.push(createInstance(lookupCard('GD04-017'), 0)); // Zeong still undrawn -- Char Aznable's real Link target
  player.hand.push(charAznable());
  giveResources(player);

  runPairings(state, player);

  assert.equal(gm.pilot, null, 'Char Aznable is held, not wasted on the GM, while Zeong is still coming');
  assert.equal(player.hand.length, 1, 'the Pilot stays in hand');
});

// Jake's original concrete example, now covered: a real, valid Link match (Char's Zaku II, Lv.3)
// already in play does NOT stop the AI from holding for a strictly better one (Zeong, Lv.6) still
// undrawn in the deck -- hasBetterLinkTargetInDeck/bestLinkMatch (actions.js) compare by level, not
// just "is there a match at all."

test('runPairings holds a Pilot for a strictly better Link target even when a lesser, valid match is already in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zaku = deployUnit(state, player, lookupCard('ST03-006')); // Char's Zaku II, Lv.3 -- a real, valid Link match, but not the best one
  player.deck.push(createInstance(lookupCard('GD04-017'), 0)); // Zeong, Lv.6 -- strictly better, still undrawn
  player.hand.push(charAznable());
  giveResources(player);

  runPairings(state, player);

  assert.equal(zaku.pilot, null, 'Char Aznable holds out for Zeong instead of settling for the Zaku');
  assert.equal(player.hand.length, 1);
});

test('runPairings pairs onto the in-play match once its only better deck target is gone', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zaku = deployUnit(state, player, lookupCard('ST03-006'));
  // No Zeong anywhere in the deck this time -- the Zaku is genuinely the best available target.
  player.hand.push(charAznable());
  giveResources(player);

  runPairings(state, player);

  assert.ok(zaku.pilot, 'nothing better is left in the deck -- pair onto the Zaku now rather than holding forever');
  assert.equal(player.hand.length, 0);
});

test('runPairings pairs the Pilot onto whatever is available once no better target remains in the deck', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const gm = deployUnit(state, player, lookupCard('ST01-005')); // no Link match, and no Zeong anywhere in the deck this time
  player.hand.push(charAznable());
  giveResources(player);

  runPairings(state, player);

  assert.ok(gm.pilot, 'nothing better is coming -- pair Char Aznable onto the GM rather than holding forever');
  assert.equal(player.hand.length, 0);
});

test('runPairings still takes the in-play Link match immediately when nothing in the deck beats it', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const zeong = deployUnit(state, player, lookupCard('GD04-017')); // Lv.6 -- already the best possible target
  player.deck.push(createInstance(lookupCard('ST03-006'), 0)); // a lesser Zaku (Lv.3) sitting in deck is irrelevant -- it's worse, not better
  player.hand.push(charAznable());
  giveResources(player);

  runPairings(state, player);

  assert.ok(zeong.pilot, 'an in-play Link match at least as good as anything in the deck is always taken immediately');
});

test("MCTS's legal actions exclude pairing onto a lesser in-play match when a strictly better one is still in the deck", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('ST03-006')); // Zaku, Lv.3
  player.deck.push(createInstance(lookupCard('GD04-017'), 0)); // Zeong, Lv.6, still undrawn
  const pilot = charAznable();
  player.hand.push(pilot);
  giveResources(player);

  const actions = getLegalActions(state, 0);
  assert.equal(
    actions.some((a) => a.type === 'pair' && a.cardId === pilot.id),
    false,
    'holding out for Zeong -- pairing onto the Zaku is not offered'
  );
});

test("MCTS's legal actions exclude pairing a Pilot onto a non-matching Unit while its real target is still in the deck", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('ST01-005')); // GM -- no linkCondition
  player.deck.push(createInstance(lookupCard('GD04-017'), 0));
  const pilot = charAznable();
  player.hand.push(pilot);
  giveResources(player);

  const actions = getLegalActions(state, 0);
  assert.equal(
    actions.some((a) => a.type === 'pair' && a.cardId === pilot.id),
    false,
    'pairing this Pilot onto the non-matching GM is not even offered as a legal action'
  );
});

test("MCTS's legal actions include pairing once no better target remains in the deck", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  deployUnit(state, player, lookupCard('ST01-005'));
  const pilot = charAznable();
  player.hand.push(pilot);
  giveResources(player);

  const actions = getLegalActions(state, 0);
  assert.equal(
    actions.some((a) => a.type === 'pair' && a.cardId === pilot.id),
    true,
    'nothing better is coming, so pairing is offered as a real option'
  );
});

// Second testbed for the same "the AI should know what it's holding a card for" principle: the
// end-of-turn hand-limit discard (7-6-3) is a completely separate code path from pairing, and used to
// have NO real heuristic at all (hooks.chooseDiscards was always undefined, so enforceHandLimit's
// naive "discard the first N cards in raw hand order" default ran every game) -- meaning a Pilot the
// AI just deliberately held for a combo could get thrown away moments later regardless.

function filler(number, cost) {
  return createInstance({ number, type: 'unit', cost, ap: 1, hp: 1 }, 0);
}

test('chooseDiscards protects a Pilot being held for a real Link target still in the deck, even when it would otherwise be first to go', () => {
  const player = createPlayer(0);
  player.deck.push(createInstance(lookupCard('GD04-017'), 0)); // Zeong, still undrawn -- the real target
  const pilot = charAznable(); // held: no in-play match at all yet
  player.hand.push(pilot, filler('F1', 1), filler('F2', 2));

  const discards = chooseDiscards(player, 1);

  assert.equal(discards.includes(pilot), false, 'the held Pilot is not the one discarded');
  assert.deepEqual(discards, [player.hand[1]], 'the cheapest filler card goes instead, even though the Pilot was first in hand');
});

test('chooseDiscards no longer protects the Pilot once nothing better is left in the deck -- ranks it by cost like anything else', () => {
  const player = createPlayer(0);
  const pilot = charAznable(); // cost 1, no better target anywhere
  player.hand.push(pilot, filler('F1', 3));

  const discards = chooseDiscards(player, 1);

  assert.deepEqual(discards, [pilot], 'nothing is protecting it anymore -- it is just the cheapest card in hand');
});

test('enforceHandLimit + chooseDiscards together keep a held combo Pilot out of the trash on a real hand overflow', () => {
  const player = createPlayer(0);
  player.deck.push(createInstance(lookupCard('GD04-017'), 0));
  const pilot = charAznable();
  player.hand.push(pilot);
  for (let i = 0; i < 10; i++) player.hand.push(filler(`F${i}`, 1));
  assert.equal(player.hand.length, 11);

  enforceHandLimit(player, chooseDiscards);

  assert.equal(player.hand.length, 10);
  assert.ok(player.hand.includes(pilot), 'the held Pilot survives the discard down to the hand limit');
});

// Third testbed for "the AI should know what it's holding a card for," and a direct implementation of
// Jake's explicit correction: this must never read which specific card a draw reveals, only real
// deck-CONTENTS facts (copies remaining / deck size) frozen before any card is drawn -- see
// comboSearchOdds's own doc comment (actions.js) and runCommandsLookahead's (heuristic.js).

test('comboSearchOdds is 0 with no unpaired Pilot in hand at all', () => {
  const player = createPlayer(0);
  player.deck.push(createInstance(lookupCard('GD04-017'), 0));

  assert.equal(comboSearchOdds(player), 0);
});

test('comboSearchOdds is 0 once a good-enough in-play Link match already exists -- no real search is open', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  deployUnit(state, player, lookupCard('GD04-017')); // Zeong, Lv.6 -- already the best possible target
  player.deck.push(createInstance(lookupCard('ST03-006'), 0)); // a lesser Zaku is irrelevant, it's worse
  player.hand.push(charAznable());

  assert.equal(comboSearchOdds(player), 0, "Char Aznable isn't holding out for anything -- Zeong is already in play");
});

test('comboSearchOdds returns copies-still-in-deck / deck-size with a genuine open need', () => {
  const player = createPlayer(0);
  player.hand.push(charAznable());
  for (let i = 0; i < 4; i++) player.deck.push(createInstance(lookupCard('GD04-017'), 0)); // 4 copies
  for (let i = 0; i < 6; i++) player.deck.push(createInstance({ number: 'F' + i, type: 'unit', ap: 1, hp: 1 }, 0)); // 6 filler

  assert.equal(comboSearchOdds(player), 4 / 10);
});

test('runCommandsLookahead prefers a draw-producing Command over a same-cost bigger-raw-stat alternative once a real combo search is open, purely from the comboSearchOdds bonus -- and reverts once the search closes', () => {
  const buildState = () => {
    const player = createPlayer(0);
    const state = createGame(player, createPlayer(1));
    for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R' + i, type: 'resource' }, 0));
    // Both cost 3 with only 3 active Resources -- the search must choose exactly one, never both.
    const drawCommand = createInstance(
      { number: 'DC', type: 'command', level: 1, cost: 3, effects: { command: (s, p) => { drawCard(s, p); drawCard(s, p); } } },
      0
    );
    // A strictly bigger immediate raw stat swing (+5 boardStats) than the draw command's flat
    // hand-count credit (+2 cards x weight 2 = +4) -- so without the new bonus, this alternative
    // always wins on scoreState alone, and the draw command can only overtake it via comboSearchOdds.
    const buffCommand = createInstance(
      {
        number: 'BC',
        type: 'command',
        level: 1,
        cost: 3,
        effects: { command: (s, p) => { p.battleArea[0].buffs.push({ ap: 5, scope: 'game' }); } }
      },
      0
    );
    player.hand.push(drawCommand, buffCommand);
    deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 3 });
    for (let i = 0; i < 6; i++) player.deck.push(createInstance({ number: 'F' + i, type: 'unit', ap: 1, hp: 1 }, 0));
    return { player, state, drawCommand, buffCommand };
  };

  // Open search: 4 of the 10 remaining deck cards are Zeong (Char Aznable's real Link target).
  // playCommand re-creates a fresh instance from card.def rather than reusing the hand instance (Command
  // instances have no persistent identity across the hand->trash move, unlike Units/Pilots), so these
  // checks match by card number, same convention as every other Command test in this suite.
  const open = buildState();
  for (let i = 0; i < 4; i++) open.player.deck.push(createInstance(lookupCard('GD04-017'), 0));
  open.player.hand.push(charAznable());
  runCommandsLookahead(open.state, 0);
  assert.equal(open.player.trash.some((c) => c.def.number === 'DC'), true, 'the draw Command was chosen once a real combo search was open');
  assert.equal(open.player.hand.some((c) => c.def.number === 'BC'), true, 'the buff Command stayed unplayed in hand');

  // No search open (no Pilot in hand at all) -- reverts to the objectively higher-scoring alternative,
  // proving the bonus (not some other coincidental effect) was what flipped the first case.
  const closed = buildState();
  runCommandsLookahead(closed.state, 0);
  assert.equal(closed.player.trash.some((c) => c.def.number === 'BC'), true, 'with no open search, the bigger raw stat swing wins on scoreState alone');
  assert.equal(closed.player.hand.some((c) => c.def.number === 'DC'), true, 'the draw Command stayed unplayed in hand');
});
