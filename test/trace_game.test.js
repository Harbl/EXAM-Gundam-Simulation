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

  // baseSetup (5-17-3: both players start with an EX Base already in play) follows, one per player,
  // still before gameStart.
  const baseSetupEvents = events.slice(4, 6);
  assert.deepEqual(baseSetupEvents.map((e) => e.type), ['baseSetup', 'baseSetup']);
  assert.ok(baseSetupEvents.every((e) => e.base && e.base.number === 'EX-BASE'));

  // resourceSetup (6-2-4: only the second player starts with an EX Resource) follows -- exactly one
  // event, not one per player, still before gameStart.
  const resourceSetupEvents = events.filter((e) => e.type === 'resourceSetup');
  assert.equal(resourceSetupEvents.length, 1, 'only the second player starts with an EX Resource');
  assert.equal(resourceSetupEvents[0].resource.number, 'EX-RESOURCE');
  assert.equal(events[6].type, 'resourceSetup');

  const gameStart = events[7];
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
// 'restedIds'/'removedIds' (payResources) carry raw instance ids in an array rather than nested
// under an 'id' key the way instanceRef's {id, name, number} shape does -- same run-to-run-varying
// problem as every other id (nextInstanceId, src/rules/state.js, is a module-level counter that never
// resets between traceGame() calls in the same process), just needing its own stripped key names.
function stripIds(events) {
  const idKeys = new Set(['id', 'restedIds', 'removedIds']);
  return JSON.parse(JSON.stringify(events, (key, value) => (idKeys.has(key) ? undefined : value)));
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

test('resource events carry the real placed instance', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const resourceEvents = events.filter((e) => e.type === 'resource');
  for (const e of resourceEvents) assert.equal(e.resource.number, 'RESOURCE');
  // Every placement is a genuinely distinct instance, not the same object logged repeatedly.
  const ids = resourceEvents.map((e) => e.resource.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('payResources events name real Resource instances that were actually placed (resourceSetup or resource)', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 999);
  const placedIds = new Set(
    events.filter((e) => e.type === 'resourceSetup' || e.type === 'resource').map((e) => e.resource.id)
  );
  const payEvents = events.filter((e) => e.type === 'payResources');
  assert.ok(payEvents.length > 0, 'a full game reliably pays for at least one deploy/command/pairing');
  for (const e of payEvents) {
    assert.ok(e.restedIds.length > 0 || e.removedIds.length > 0, 'never an empty no-op event');
    for (const id of [...e.restedIds, ...e.removedIds]) assert.ok(placedIds.has(id), `id ${id} was actually placed`);
  }
});

test('a real Burst reveal (Jaburo, seed 2) logs the shield card and whether it activated', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 2);
  // Filtered by card, not just "the first burst in the log" -- which specific shield gets hit first is
  // an AI-decision outcome (sensitive to card-data/search changes like the GD01-006/GD01-026/ST01-001/
  // ST03-006 linkCondition fixes), not a rules fact this test is meant to pin down. What's meant to be
  // pinned down is Jaburo's specific Burst behavior.
  const burst = events.find((e) => e.type === 'burst' && e.card.number === 'GD04-122');
  assert.ok(burst, 'expected a Jaburo Burst reveal in this seeded game');
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

test('burst.endedUpInHand is true for a "add this Shield to your hand" effect (Amuro Ray ST01-010, seed 2)', () => {
  const deck = buildJakesDeck();
  const events = traceGame(deck, deck, 2);
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

// Regression test for a third, related gap: Gundam Exia Repair's own "[Destroyed] Place the top 2
// cards of your deck into your trash" (GD05-050) went through registry.js's own inline
// deck.splice/trash.push, same as Overflowing Affection's discard above -- so the mill genuinely
// happened in game state (jake's report: "GD05-050 doesn't seem to be sending cards to the trash when
// it's destroyed"), but never emitted a trace event, making it look like nothing happened. Fixed the
// same way: routed through management.js's new millToTrash, patched here identically to
// discardFromHand. A fragile (hp:1) 50-copy deck reliably dies in combat organically, same synthetic-
// deck technique as the discard/blocker decks above.
function exiaRepairDeck() {
  const unitDef = lookupCard('GD05-050');
  const resourceDef = { number: 'X-RES', name: 'Test Resource', type: 'resource', color: 'purple', cost: 0, level: 0 };
  return { main: Array.from({ length: 50 }, () => unitDef), resource: Array.from({ length: 10 }, () => resourceDef) };
}

test("Gundam Exia Repair's own [Destroyed] mill (GD05-050) emits mill events, not just the destroy event", () => {
  const deck = exiaRepairDeck();
  const events = traceGame(deck, deck, 1);
  const destroyEvents = events.filter((e) => e.type === 'destroy' && e.unit.number === 'GD05-050');
  assert.ok(destroyEvents.length > 0, 'a fragile (hp:1) 50-copy deck should die in combat organically');
  const millEvents = events.filter((e) => e.type === 'mill');
  assert.ok(millEvents.length > 0, 'each destruction should mill 2 cards from deck into trash, and it must be traced');
  assert.equal(millEvents.length, destroyEvents.length * 2, 'exactly 2 milled cards traced per destruction');
});

// Broader regression test, prompted by "do a sweep for any other hidden traces like that": the same
// splice-zones-directly pattern GD05-050 had turned out to be pervasive (Base cards' "[Deploy] Add 1
// of your Shields to your hand" alone is ~20 cards). Fixed the same way -- management.js's new
// shieldToHand, patched here identically to millToTrash/discardFromHand -- but the first version of
// this patch was itself silently broken: it (and 7 sibling patches added in the same pass) were
// placed AFTER this file's own `require('../cards/index')` line, which is what causes registry.js to
// destructure these functions off management.js -- so registry.js captured the *unpatched* originals
// regardless of what ran afterward, the exact hazard this file's own header comment warns about. This
// test (and the one below) exist specifically to catch that class of regression happening again, not
// just to prove the feature works once.
function jaburoDeck() {
  const baseDef = lookupCard('GD04-122');
  const resourceDef = { number: 'X-RES', name: 'Test Resource', type: 'resource', color: 'blue', cost: 0, level: 0 };
  return { main: Array.from({ length: 50 }, () => baseDef), resource: Array.from({ length: 10 }, () => resourceDef) };
}

test("Jaburo's own [Deploy] (\"Add 1 of your Shields to your hand\") emits a shieldToHand event", () => {
  const deck = jaburoDeck();
  const events = traceGame(deck, deck, 1);
  const deployBaseEvents = events.filter((e) => e.type === 'deployBase' && e.card.number === 'GD04-122');
  assert.ok(deployBaseEvents.length > 0, 'a 50-copy Base deck should deploy Jaburo organically');
  const shieldToHandEvents = events.filter((e) => e.type === 'shieldToHand');
  assert.equal(shieldToHandEvents.length, deployBaseEvents.length, 'one shieldToHand event per Jaburo deploy (6 Shields never run out in a game this short)');
});

// Same regression-guard reasoning as shieldToHand above, for the single highest-volume new helper
// (returnUnitToHand, ~30 registry.js call sites -- "return this enemy Unit to its owner's hand" is
// the single most common bounce text in the whole card pool). A synthetic 1-HP unit is mixed in as
// bounce fodder alongside the real bouncer card so Perfect Strike Gundam's exact-1-HP condition is
// reliably satisfiable without needing several turns of combat damage first.
function perfectStrikeBounceDeck() {
  const bouncer = lookupCard('GD01-068');
  const fodder = { number: 'FODDER-1HP', name: 'Fodder', type: 'unit', color: 'white', level: 1, cost: 1, ap: 0, hp: 1 };
  const resourceDef = { number: 'X-RES', name: 'Test Resource', type: 'resource', color: 'white', cost: 0, level: 0 };
  return {
    main: [...Array(25).fill(bouncer), ...Array(25).fill(fodder)],
    resource: Array.from({ length: 10 }, () => resourceDef)
  };
}

test("Perfect Strike Gundam's own [Deploy] (\"Return 1 enemy Unit with 1 HP to hand\") emits a returnToHand event", () => {
  const deck = perfectStrikeBounceDeck();
  const events = traceGame(deck, deck, 1);
  const bounceEvents = events.filter((e) => e.type === 'returnToHand');
  assert.ok(bounceEvents.length > 0, 'a deck full of 1-HP fodder should give Perfect Strike Gundam a legal target organically');
  for (const e of bounceEvents) {
    assert.ok(e.unit && e.unit.number, 'the bounced Unit must be identified, not just a bare count');
  }
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

// Eliminate Target GD03-110 ("[Main] Destroy 1 enemy Pilot") was the one explicitly-accepted gap left
// over from the sweep above: the Pilot's badge cleared correctly (via the pre-existing 'unpair' event)
// but its arrival in trash was never traced, so the replay's trash count silently undercounted by one.
// Fixed with a new destroyPilot primitive (management.js) rather than special-casing this one card,
// since Jake noted the "destroy a paired Pilot alone, Unit stays" shape is likely to recur. Synthetic
// pilot+unit fodder (no trait requirements) mixed in with the real card so pairing -- a prerequisite
// for this effect to have a legal target -- happens organically and reliably.
function eliminateTargetDeck() {
  const commandDef = lookupCard('GD03-110');
  const pilotDef = { number: 'FODDER-PILOT', name: 'Fodder Pilot', type: 'pilot', color: 'red', level: 1, cost: 1, apBonus: 1, hpBonus: 1 };
  const unitDef = { number: 'FODDER-UNIT', name: 'Fodder Unit', type: 'unit', color: 'red', level: 1, cost: 1, ap: 1, hp: 2 };
  const resourceDef = { number: 'X-RES', name: 'Test Resource', type: 'resource', color: 'red', cost: 0, level: 0 };
  return {
    main: [...Array(20).fill(commandDef), ...Array(15).fill(pilotDef), ...Array(15).fill(unitDef)],
    resource: Array.from({ length: 10 }, () => resourceDef)
  };
}

test("Eliminate Target's own [Main] (\"Destroy 1 enemy Pilot\") emits a destroyPilot event", () => {
  const deck = eliminateTargetDeck();
  const events = traceGame(deck, deck, 1);
  const destroyPilotEvents = events.filter((e) => e.type === 'destroyPilot');
  assert.ok(destroyPilotEvents.length > 0, 'a deck full of pairable fodder should give Eliminate Target a legal target organically');
  for (const e of destroyPilotEvents) {
    assert.ok(e.unit && e.unit.number, 'the unpaired Unit must be identified');
    assert.ok(e.pilot && e.pilot.number, 'the destroyed Pilot must be identified, not just a bare count');
  }
});

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
