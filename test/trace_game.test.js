const test = require('node:test');
const assert = require('node:assert/strict');

// Must be required first in this file -- see the big comment at the top of src/sim/traceGame.js.
// node --test runs each test file in its own process by default, so this ordering only needs to
// hold within this one file, same precedent as test/skill_engine.test.js.
const { traceGame } = require('../src/sim/traceGame');

const { parseDecklistText } = require('../src/deck/parser');
const { validateDeck } = require('../src/deck/validator');
const { buildGameDeck } = require('../src/deck/build');
const { lookupCard } = require('../src/cards/index');
const banlist = require('../data/banlist.json');

const JAKES_DECKLIST = `
4 GM ST01-005
4 Guntank GD01-008
4 Zaku II ST03-008
4 Char's Zaku II GD01-026
4 Char's Zaku II ST03-006
4 Char Aznable ST03-011
4 Rick Dom GD01-030
4 ReZEL GD01-018
4 Amuro Ray ST01-010
4 Gundam ST01-001
4 A Show of Resolve GD01-100
2 Delta Plus GD01-006
2 Jaburo GD04-122
2 Zeong GD04-017
`;

function buildJakesDeck() {
  const parsed = parseDecklistText(JAKES_DECKLIST);
  validateDeck(parsed, lookupCard, banlist);
  return buildGameDeck({ main: parsed.main }, lookupCard);
}

test('traceGame returns a structured event log, mulligan decisions first, gameStart before real turns, gameEnd last', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);

  assert.ok(events.length > 2);
  // Mulligan decisions happen inside initializeGame's own setup, chronologically before the turn
  // loop begins -- any that appear lead the log, one per player, each other event coming after.
  const mulliganEvents = events.filter((e) => e.type === 'mulligan');
  assert.equal(mulliganEvents.length, 2, 'exactly one mulligan decision per player');
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ['mulligan', 'mulligan']);

  // openingHand follows the 2 mulligan decisions, one per player, before gameStart.
  const openingHandEvents = events.slice(2, 4);
  assert.deepEqual(openingHandEvents.map((e) => e.type), ['openingHand', 'openingHand']);

  const gameStart = events[4];
  assert.equal(gameStart.type, 'gameStart');
  assert.ok(gameStart.firstPlayer === 0 || gameStart.firstPlayer === 1);

  const last = events[events.length - 1];
  assert.equal(last.type, 'gameEnd');
  assert.ok(last.winner === 0 || last.winner === 1 || last.draw || last.timedOut);

  // Real gameplay decisions -- draws, resource placement, deploys, and attacks -- should show up.
  assert.ok(events.some((e) => e.type === 'draw'));
  assert.ok(events.some((e) => e.type === 'resource'));
  assert.ok(events.some((e) => e.type === 'deploy'));
  assert.ok(events.some((e) => e.type === 'attack'));
  // A full game between two 50-card decks reliably produces at least one destroy and one damage
  // event -- combat happens, and units die.
  assert.ok(events.some((e) => e.type === 'destroy'));
  assert.ok(events.some((e) => e.type === 'damage'));
});

// `instance.id` comes from a process-lifetime global counter (state.js's nextInstanceId), not from
// the seed -- it's a bookkeeping value that legitimately differs between two separate traceGame()
// calls in the same process, even though every seed-derived decision (deploys/attacks/targets/
// outcome) lines up exactly. Stripped out here since it isn't part of the seeded-determinism contract.
function stripIds(events) {
  return JSON.parse(JSON.stringify(events, (key, value) => (key === 'id' ? undefined : value)));
}

test('traceGame with the same seed reproduces the exact same event log', () => {
  const deck = buildJakesDeck();
  const eventsA = traceGame(deck, deck, 555);
  const eventsB = traceGame(deck, deck, 555);
  assert.deepEqual(stripIds(eventsA), stripIds(eventsB));
});

test('mulligan events carry a real player id and a boolean decision, one per player', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const mulliganEvents = events.filter((e) => e.type === 'mulligan');
  const players = mulliganEvents.map((e) => e.player).sort();
  assert.deepEqual(players, [0, 1]);
  for (const e of mulliganEvents) assert.equal(typeof e.mulliganed, 'boolean');
});

test('resource events fire for the active player only, once per turn they place one', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const resourceEvents = events.filter((e) => e.type === 'resource');
  assert.ok(resourceEvents.length > 0);
  // Each resource event's player must match the turnStart immediately preceding it (the active
  // player for that turn) -- resources are never placed for the non-active side.
  let lastTurnStart = null;
  for (const e of events) {
    if (e.type === 'turnStart') lastTurnStart = e;
    if (e.type === 'resource') assert.equal(e.player, lastTurnStart.player);
  }
});

test('a real Burst reveal (Jaburo, seed 1) logs the shield card and whether it activated', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 1);
  const burst = events.find((e) => e.type === 'burst');
  assert.ok(burst, 'expected at least one Burst reveal in this seeded game');
  assert.equal(burst.card.number, 'GD04-122');
  assert.equal(burst.activated, true);
  assert.ok(burst.player === 0 || burst.player === 1);
  // Jaburo's Burst converts the Shield straight into a Base (jaburoBurst -> becomeBase), never hand.
  assert.equal(burst.endedUpInHand, false);
  // becomeBase is patched separately from deployBase (see traceGame.js) -- confirms the Shield's
  // conversion into a real Base actually shows up in the log, not just that it avoided the hand.
  const becomeBaseEvent = events.find((e) => e.type === 'deployBase' && e.card.number === 'GD04-122');
  assert.ok(becomeBaseEvent, 'expected a deployBase event for Jaburo becoming a Base');
  assert.equal(typeof becomeBaseEvent.unit.id, 'number');
});

test('burst.endedUpInHand is true for a "add this Shield to your hand" effect (Amuro Ray ST01-010, seed 1)', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 1);
  const burst = events.find((e) => e.type === 'burst' && e.card.number === 'ST01-010');
  assert.ok(burst, 'expected an Amuro Ray Burst reveal in this seeded game');
  assert.equal(burst.activated, true);
  assert.equal(burst.endedUpInHand, true);
});

test('openingHand events list each player\'s real post-mulligan 5-card hand', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const openingHands = events.filter((e) => e.type === 'openingHand');
  assert.equal(openingHands.length, 2);
  const players = openingHands.map((e) => e.player).sort();
  assert.deepEqual(players, [0, 1]);
  for (const e of openingHands) {
    assert.equal(e.hand.length, 5);
    for (const card of e.hand) assert.equal(typeof card.number, 'string');
  }
});

test('deploy and deployBase events carry the created instance\'s id', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const deployEvents = events.filter((e) => e.type === 'deploy' || e.type === 'deployBase');
  assert.ok(deployEvents.length > 0);
  for (const e of deployEvents) {
    assert.equal(typeof e.unit.number, 'string');
    assert.equal(typeof e.unit.id, 'number');
    assert.equal(e.unit.number, e.card.number);
  }
});

test('destroy events name the destroyed unit and its owner', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const destroyEvents = events.filter((e) => e.type === 'destroy');
  assert.ok(destroyEvents.length > 0);
  for (const e of destroyEvents) {
    assert.ok(e.player === 0 || e.player === 1);
    assert.equal(typeof e.unit.number, 'string');
    assert.equal(typeof e.unit.id, 'number');
  }
});

test('damage events carry a positive amount and the damaged instance', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const damageEvents = events.filter((e) => e.type === 'damage');
  assert.ok(damageEvents.length > 0);
  for (const e of damageEvents) {
    assert.ok(e.player === 0 || e.player === 1);
    assert.ok(e.amount > 0);
    assert.equal(typeof e.instance.number, 'string');
    assert.equal(typeof e.instance.id, 'number');
  }
});

test('draw events carry the identity of the card actually drawn', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const drawEvents = events.filter((e) => e.type === 'draw');
  assert.ok(drawEvents.length > 0);
  for (const e of drawEvents) assert.equal(typeof e.card.number, 'string');
  // At least one should be the once-per-turn phase draw, not just effect-triggered draws.
  assert.ok(drawEvents.some((e) => e.isPhaseDraw === true));
});

// Jake's own real, curve-out deck reliably empties its hand well under the 10-card limit every
// turn (confirmed: zero discards across 30 real tournament decklists x 5 seeds each, and 400 seeds
// of Jake's own deck) -- the heuristic/MCTS AI is simply too good at dumping its hand for this to
// come up organically. A synthetic deck of one deliberately unplayable card (level/cost 99, forever
// out of reach of the resource area's 15-card cap) forces a real, deterministic hand-limit discard
// instead, same "unitDef helper with synthetic overrides" pattern already used in rules.test.js.
function unplayableUnitDef() {
  return { number: 'X-UNIT', name: 'Unplayable Test Unit', type: 'unit', color: 'blue', level: 99, cost: 99, ap: 1, hp: 1, keywords: {} };
}
function testResourceDef() {
  return { number: 'X-RES', name: 'Test Resource', type: 'resource', color: 'blue', cost: 0, level: 0 };
}

test('discard events fire for a real end-phase hand-limit discard, naming the discarded card', () => {
  const deck = {
    main: Array.from({ length: 50 }, unplayableUnitDef),
    resource: Array.from({ length: 10 }, testResourceDef)
  };
  const events = traceGame(deck, deck, 1);
  const discardEvents = events.filter((e) => e.type === 'discard');
  assert.ok(discardEvents.length > 0, 'an unplayable deck should overflow the hand and force discards');
  for (const e of discardEvents) {
    assert.ok(e.player === 0 || e.player === 1);
    assert.equal(e.card.number, 'X-UNIT');
  }
});

// Regression test for a real gap found in play: Overflowing Affection's "Draw 2. Then, discard 1."
// went through registry.js's own inline hand.splice/trash.push, bypassing enforceHandLimit entirely
// -- so the discard genuinely happened in game state, but never emitted a trace 'discard' event, and
// looked from the replay viewer like the card only ever drew and never discarded. Fixed by routing
// every effect-driven discard through management.js's discardFromHand, patched here the same way as
// enforceHandLimit. A deck of one real copy of the card (GD01-118) mirrored against itself, same
// synthetic-deck technique as blockerDeck below, forces it to be played organically most turns.
function overflowingAffectionDeck() {
  const commandDef = lookupCard('GD01-118');
  const resourceDef = { number: 'X-RES', name: 'Test Resource', type: 'resource', color: 'white', cost: 0, level: 0 };
  return { main: Array.from({ length: 50 }, () => commandDef), resource: Array.from({ length: 10 }, () => resourceDef) };
}

test('an effect-driven discard (Overflowing Affection GD01-118) emits a discard event, not just the draws', () => {
  const deck = overflowingAffectionDeck();
  const events = traceGame(deck, deck, 1);
  const commandEvents = events.filter((e) => e.type === 'command' && e.card.number === 'GD01-118');
  assert.ok(commandEvents.length > 0, 'a 50-copy deck of this card should get played organically');
  const discardEvents = events.filter((e) => e.type === 'discard');
  assert.ok(discardEvents.length > 0, 'each play should draw 2 then discard 1, and it must be traced');
  for (const e of discardEvents) {
    assert.equal(e.card.number, 'GD01-118');
  }
});

// Regression test for a second, related gap: the 'command' event was pushed only after playCommand
// (and therefore the card's own [Main] effect) had already fully resolved, so a replay showed the
// card's own draws/discard happening BEFORE the "card played" event that caused them. Fixed by
// pushing the action's own event before delegating to the original function, same pattern applied
// to every other action patch (deploy/deployBase/becomeBase/pairPilot/pairPilotFromTrash/
// resolveAttack) in traceGame.js, not just playCommand.
test('a command event precedes the draw/discard events its own [Main] effect causes, not the other way around', () => {
  const deck = overflowingAffectionDeck();
  const events = traceGame(deck, deck, 1);
  const commandIdx = events.findIndex((e) => e.type === 'command' && e.card.number === 'GD01-118');
  assert.ok(commandIdx !== -1);
  const nextThree = events.slice(commandIdx + 1, commandIdx + 4).map((e) => e.type);
  assert.deepEqual(nextThree, ['draw', 'draw', 'discard']);
});

// Jake's own real deck produced zero organic Blocker interceptions across 60 seeds -- it simply has
// no Blocker-keyword units. Same synthetic-deck technique as the discard test above: a deck of one
// real Blocker card (EB01-011 Beginning Gundam, a genuine keyword-bearing card, not a made-up def)
// mirrored against itself forces real, frequent block decisions instead.
function blockerDeck() {
  const blockerDef = lookupCard('EB01-011');
  const resourceDef = { number: 'X-RES', name: 'Test Resource', type: 'resource', color: 'blue', cost: 0, level: 0 };
  return { main: Array.from({ length: 50 }, () => blockerDef), resource: Array.from({ length: 10 }, () => resourceDef) };
}

test('block events name the intercepting Blocker and the attacker it stopped', () => {
  const deck = blockerDeck();
  const events = traceGame(deck, deck, 1);
  const blockEvents = events.filter((e) => e.type === 'block');
  assert.ok(blockEvents.length > 0, 'an all-Blocker mirror match should produce real block decisions');
  for (const e of blockEvents) {
    assert.ok(e.player === 0 || e.player === 1);
    assert.equal(typeof e.blocker.id, 'number');
    assert.equal(typeof e.attacker.id, 'number');
    assert.notEqual(e.blocker.id, e.attacker.id);
  }
});

test('traceGame only logs real decisions, not the AI search\'s cloned-state scratch trials', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 111);
  // A real full game between two 50-card decks plays out over many turns with, at most, a modest
  // number of actual attacks -- if the search's internal scratch trials were leaking through, this
  // would be in the hundreds/thousands instead.
  const attackEvents = events.filter((e) => e.type === 'attack');
  assert.ok(attackEvents.length < 200, `expected a plausible real attack count, got ${attackEvents.length}`);
});
