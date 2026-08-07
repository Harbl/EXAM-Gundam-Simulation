const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, becomeBase, pairPilot } = require('../src/rules/actions');
const { runActivations, runCommands, runDeploys, chooseBlocker, collectCommandCandidates, actionStep } = require('../src/ai/heuristic');
const { resolveAttack } = require('../src/rules/combat');
const { getRemainingHP, getKeywords, getAP } = require('../src/rules/management');

test('runActivations uses Jaburo to rest a scarier enemy Unit, spending its weakest Federation Unit as cost', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 0;

  becomeBase(state, player, createInstance(lookupCard('GD04-122'), 0));
  const weakFed = createInstance({ number: 'W', type: 'unit', ap: 1, traits: ['Earth Federation'] }, 0);
  const strongFed = createInstance({ number: 'S', type: 'unit', ap: 5, traits: ['Earth Federation'] }, 0);
  player.battleArea.push(weakFed, strongFed);
  const scaryEnemy = createInstance({ number: 'E', type: 'unit', ap: 4, level: 2 }, 1);
  const weakEnemy = createInstance({ number: 'E2', type: 'unit', ap: 0, level: 2 }, 1);
  opponent.battleArea.push(scaryEnemy, weakEnemy);

  runActivations(state, 0);

  assert.equal(weakFed.rested, true, 'sacrificed the weakest Federation Unit as the cost, not the strong one');
  assert.equal(strongFed.rested, false, 'kept the strong attacker free rather than spending it as the cost');
  assert.equal(scaryEnemy.rested, true, 'rested the higher-AP enemy, not the harmless one');
  assert.equal(weakEnemy.rested, false);
});

test("runActivations uses Ra Cailum's Reduce 1 on its biggest friendly (Londo Bell) threat", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  state.activePlayerIdx = 0;

  becomeBase(state, player, createInstance(lookupCard('GD05-125'), 0));
  const smallLondoBell = createInstance({ number: 'A', type: 'unit', ap: 1, traits: ['Londo Bell'] }, 0);
  const bigLondoBell = createInstance({ number: 'B', type: 'unit', ap: 5, traits: ['Londo Bell'] }, 0);
  player.battleArea.push(smallLondoBell, bigLondoBell);

  runActivations(state, 0);

  assert.equal(player.base.rested, true);
  assert.ok(bigLondoBell.buffs.some((b) => b.damageReduction === 1), 'protects the highest-AP Londo Bell Unit');
  assert.equal(smallLondoBell.buffs.length, 0);
});

test('runCommands plays an affordable Command from hand (e.g. A Show of Resolve draws 2), not just Units/Bases', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  for (let i = 0; i < 4; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'blue' }, 0));
  for (let i = 0; i < 2; i++) player.deck.push(createInstance({ number: `D${i}`, type: 'unit' }, 0));
  player.hand.push(createInstance(lookupCard('GD01-100'), 0));

  runCommands(state, player);

  assert.equal(player.hand.length, 2, 'the Command got played (trashed) and its 2 draws are now in hand');
  assert.equal(player.trash.some((c) => c.def.number === 'GD01-100'), true);
});

test("Main-phase command legality excludes Action-only cards (Wings of Light) but keeps Main/Action ones (Siege Ploy)", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  for (let i = 0; i < 5; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'blue' }, 0));
  const wingsOfLight = createInstance(lookupCard('GD05-102'), 0); // [Action]-only
  const siegePloy = createInstance(lookupCard('ST02-014'), 0); // [Main]/[Action]
  player.hand.push(wingsOfLight, siegePloy);

  const candidates = collectCommandCandidates(state, 0);

  assert.equal(candidates.includes(wingsOfLight), false, 'an Action-only card is never legal to play in the Main phase (13-2-2)');
  assert.equal(candidates.includes(siegePloy), true, 'a Main/Action card stays legal in the Main phase');
});

test("runCommands never plays an Action-only card, even sitting affordable in hand all game", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  for (let i = 0; i < 5; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'blue' }, 0));
  player.hand.push(createInstance(lookupCard('GD05-102'), 0));

  runCommands(state, player);

  assert.equal(player.hand.length, 1, 'Wings of Light is still sitting in hand, not played');
  assert.equal(player.trash.length, 0);
});

test('actionStep reactively plays Wings of Light to bounce a lethal attacker before it connects', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;
  for (let i = 0; i < 5; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'blue' }, 0));
  player.hand.push(createInstance(lookupCard('GD05-102'), 0));

  const weakUnit = createInstance({ number: 'W', type: 'unit', level: 1, ap: 1, hp: 1 }, 0);
  player.battleArea.push(weakUnit);
  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(attacker);

  resolveAttack(state, 1, attacker, { type: 'unit', instance: weakUnit }, { actionStep });

  assert.equal(opponent.battleArea.includes(attacker), false, 'Wings of Light bounced the attacker off the field');
  assert.equal(opponent.hand.some((c) => c.def.number === 'A' || c === attacker), true, 'the bounced attacker landed back in the attacking player\'s hand');
  assert.equal(player.battleArea.includes(weakUnit), true, 'the attack never connected -- the weak unit survives untouched');
  assert.equal(player.hand.some((c) => c.def.number === 'GD05-102'), false, 'Wings of Light was actually played, not just sitting unused');
});

test('actionStep reactively plays Master League Begins to redirect a bad-trade attack onto a rested sacrifice, via the mutable battleTarget path', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'green' }, 0));
  player.hand.push(createInstance(lookupCard('EB01-077'), 0));

  const valuableUnit = createInstance({ number: 'V', type: 'unit', level: 1, ap: 3, hp: 4 }, 0);
  const sacrifice = createInstance({ number: 'S', type: 'unit', level: 1, ap: 1, hp: 1, traits: ['G Generation'] }, 0);
  sacrifice.rested = true;
  player.battleArea.push(valuableUnit, sacrifice);
  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(attacker);

  resolveAttack(state, 1, attacker, { type: 'unit', instance: valuableUnit }, { actionStep });

  assert.equal(player.battleArea.includes(valuableUnit), true, 'the originally-declared target was saved -- the attack got redirected off it');
  assert.equal(getRemainingHP(valuableUnit), 4, 'valuableUnit took no damage at all');
  assert.equal(player.battleArea.includes(sacrifice), false, 'the redirected attack actually landed on the rested sacrifice instead, destroying it');
  assert.equal(player.hand.some((c) => c.def.number === 'EB01-077'), false, 'Master League Begins was actually played');
});

test("actionStep reactively fires Taurus (Sanc Kingdom)'s [Activate·Action] to buff a Unit facing a bad trade, turning a one-sided loss into a mutual kill", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'green' }, 0));

  const taurus = createInstance(lookupCard('EB01-033'), 0);
  const defender = createInstance({ number: 'D', type: 'unit', level: 1, ap: 4, hp: 5 }, 0);
  player.battleArea.push(taurus, defender);
  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(attacker);

  resolveAttack(state, 1, attacker, { type: 'unit', instance: defender }, { actionStep });

  assert.equal(opponent.battleArea.includes(attacker), false, 'attacker also died -- the boosted counter-attack (AP5) now matches its HP5');
  assert.equal(player.battleArea.includes(defender), false, 'defender still died (its HP5 <= the attacker\'s AP5)');
  assert.equal(player.resourceArea[0].rested, true, "Taurus's (1) cost was actually paid, not a free activation");
});

test("actionStep reactively fires Gundam Schwarzette's [Activate·Action] (self damage reduction) to survive an attack it would otherwise die to", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;
  player.trash.push(
    createInstance({ number: 'C1', type: 'command' }, 0),
    createInstance({ number: 'C2', type: 'command' }, 0)
  );

  // ap:1/hp:5 (not Schwarzette's real 5/4) so a straightforward AP5 attacker is both a bad trade
  // (opens the reactive gate) and lethal without the buff, survivable with it -- collectActivateActionCandidates
  // looks the resolver up by real card number, so the real resolved def (with effects.activateAction
  // already wired via effectRefs) has to stay attached; only ap/hp are overridden.
  const schwarzette = deployUnit(state, player, { ...lookupCard('GD05-022'), ap: 1, hp: 5 });
  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 5, hp: 10 }, 1);
  opponent.battleArea.push(attacker);

  resolveAttack(state, 1, attacker, { type: 'unit', instance: schwarzette }, { actionStep });

  assert.equal(player.battleArea.includes(schwarzette), true, 'the damage-reduction buff (2) dropped 5 damage to 3, under its 5 HP -- it survives');
  assert.equal(schwarzette.damage, 3);
  assert.equal(player.trash.filter((c) => c.def.type === 'command').length, 0, 'exiled both Commands as the cost, not just spent them');
});

test("actionStep also tries the ATTACKING player's own [Activate·Action] options -- Gamow grants the attacking (ZAFT) Unit <Breach 3>, which spills into a Shield once the attacked Unit dies", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;

  becomeBase(state, opponent, createInstance(lookupCard('GD01-127'), 1));
  const attacker = deployUnit(state, opponent, { number: 'A', type: 'unit', traits: ['ZAFT'], level: 1, ap: 5, hp: 5 });
  // Low-HP defender so the attack actually destroys it -- Breach's spillover damage (13-1-2) only
  // fires on a destroyed target, and the buff itself is battle-scoped (cleared once the battle ends,
  // combat.js's clearBattleBuffs), so a persistent, observable side effect is the only reliable thing
  // to assert on here, not the buff's continued presence after resolveAttack returns.
  const defender = createInstance({ number: 'D', type: 'unit', level: 1, ap: 1, hp: 3 }, 0);
  player.battleArea.push(defender);
  player.shields.push(createInstance({ number: 'SH', type: 'unit' }, 0));

  resolveAttack(state, 1, attacker, { type: 'unit', instance: defender }, { actionStep });

  assert.equal(player.battleArea.includes(defender), false, 'the defending Unit was destroyed by the attack');
  assert.equal(player.shields.length, 0, "Gamow's Breach 3 grant spilled over into the defending player's Shield once the target died");
  assert.equal(opponent.base.rested, true, "Gamow's own rest-as-cost was actually paid");
});

test("actionStep fires Moebius (Peacemaker Team)'s [Activate·Action] to destroy itself for 6 damage to the enemy Shield while attacking the player directly", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;

  const moebius = deployUnit(state, opponent, lookupCard('GD02-011'));
  player.shields.push(createInstance({ number: 'SH', type: 'unit' }, 0));

  resolveAttack(state, 1, moebius, { type: 'player' }, { actionStep });

  assert.equal(opponent.battleArea.includes(moebius), false, "Moebius destroyed itself as the ability's own cost");
  assert.equal(player.shields.length, 0, "its Activate·Action's 6 damage destroyed the defending player's Shield");
});

test('actionStep reactively plays Overcoming Hardships to redirect a bad-trade attack onto a rested (Academy) ally, via the new underAttack context field', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'green' }, 0));
  player.hand.push(createInstance(lookupCard('GD05-108'), 0));

  const valuableUnit = createInstance({ number: 'V', type: 'unit', level: 1, ap: 3, hp: 4 }, 0);
  const sacrifice = createInstance({ number: 'S', type: 'unit', level: 1, ap: 1, hp: 1, traits: ['Academy'] }, 0);
  sacrifice.rested = true;
  player.battleArea.push(valuableUnit, sacrifice);
  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(attacker);

  resolveAttack(state, 1, attacker, { type: 'unit', instance: valuableUnit }, { actionStep });

  assert.equal(player.battleArea.includes(valuableUnit), true, 'the originally-declared target was saved -- the attack got redirected off it');
  assert.equal(getRemainingHP(valuableUnit), 4, 'valuableUnit took no damage at all');
  assert.equal(player.battleArea.includes(sacrifice), false, 'the redirected attack landed on the rested Academy sacrifice instead, destroying it');
  assert.equal(player.hand.some((c) => c.def.number === 'GD05-108'), false, 'Overcoming Hardships was actually played');
});

test('actionStep reactively plays A Wind Against Fires to debuff the attacking enemy Unit AP-3, once the friendly Unit under attack is confirmed Lv.5+, via the new attackingUnit/underAttack context fields', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;
  for (let i = 0; i < 5; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'white' }, 0));
  player.hand.push(createInstance(lookupCard('GD05-119'), 0));

  const defender = createInstance({ number: 'D', type: 'unit', level: 5, ap: 4, hp: 5 }, 0);
  player.battleArea.push(defender);
  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 5, hp: 4 }, 1);
  opponent.battleArea.push(attacker);

  resolveAttack(state, 1, attacker, { type: 'unit', instance: defender }, { actionStep });

  assert.equal(opponent.battleArea.includes(attacker), false, "the attacker's AP-3 debuff (5->2) doesn't change defender's own AP4 counter-kill (HP4 attacker)");
  assert.equal(player.battleArea.includes(defender), true, 'defender survives -- the debuffed attacker only deals 2 back, under its 5 HP');
  assert.equal(player.hand.some((c) => c.def.number === 'GD05-119'), false, 'A Wind Against Fires was actually played');
});

test("actionStep reactively plays SP Conversion Chips to buff the defender's own best Unit AP+3, via its new default-target fallback", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  state.activePlayerIdx = 1;
  for (let i = 0; i < 3; i++) player.resourceArea.push(createInstance({ number: 'R', type: 'resource', color: 'white' }, 0));
  player.hand.push(createInstance(lookupCard('EB01-083'), 0));

  const weak = createInstance({ number: 'W', type: 'unit', level: 1, ap: 1, hp: 1 }, 0);
  const strong = createInstance({ number: 'S', type: 'unit', level: 1, ap: 3, hp: 1 }, 0);
  player.battleArea.push(weak, strong);
  const attacker = createInstance({ number: 'A', type: 'unit', level: 1, ap: 5, hp: 5 }, 1);
  opponent.battleArea.push(attacker);

  resolveAttack(state, 1, attacker, { type: 'unit', instance: weak }, { actionStep });

  assert.equal(getAP(strong), 6, "defaulted to the controller's own highest-AP Unit (strong: 3->6), not the attacked one (weak)");
  assert.equal(player.hand.some((c) => c.def.number === 'EB01-083'), false, 'SP Conversion Chips was actually played');
});

test('Nu Gundam GD05-017 (When Paired) only burns its 3 trashed Londo Bell cards for a favorable/safe kill', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  for (let i = 0; i < 3; i++) {
    player.trash.push(createInstance({ number: `LB${i}`, type: 'unit', traits: ['Londo Bell'] }, 0));
  }
  const toughEnemy = createInstance({ number: 'E', type: 'unit', ap: 10, hp: 10 }, 1); // would trade badly
  opponent.battleArea.push(toughEnemy);

  const nuGundam = deployUnit(state, player, lookupCard('GD05-017'));
  const pilot = createInstance({ number: 'P', type: 'pilot' }, 0);
  pairPilot(state, player, nuGundam, pilot);

  assert.equal(player.trash.length, 3, 'declines the trade -- nothing gets exiled without a favorable kill');
  assert.equal(player.removal.length, 0);
  assert.equal(toughEnemy.damage, 0);
});

test("runDeploys won't redeploy a second Base while one is already in play (11-5 would just trash the first for nothing)", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.hand.push(
    createInstance({ number: 'B1', type: 'base', hp: 5 }, 0),
    createInstance({ number: 'B2', type: 'base', hp: 5 }, 0)
  );

  runDeploys(state, player);

  assert.equal(player.base.def.number, 'B1');
  assert.equal(player.hand.length, 1, 'B2 stays in hand instead of being wasted replacing B1');
  assert.equal(player.trash.length, 0);
});

test('chooseBlocker prefers a Unit that survives and kills the attacker over a cheaper chump', () => {
  const defendingPlayer = createPlayer(0);
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 4, hp: 4 }, 1);
  const chump = createInstance({ number: 'C', type: 'unit', ap: 1, hp: 1, keywords: { blocker: true } }, 0);
  const strongBlocker = createInstance({ number: 'S', type: 'unit', ap: 5, hp: 5, keywords: { blocker: true } }, 0);
  defendingPlayer.battleArea.push(chump, strongBlocker);
  // No Base/Shields left -- facing lethal, so a block is warranted at all.

  const chosen = chooseBlocker(defendingPlayer, attacker, { type: 'player' });

  assert.equal(chosen, strongBlocker, 'kills the attacker and survives, instead of just chumping with the weakest body');
});

test("chooseBlocker doesn't block at all outside facing-lethal/bad-trade, even with a Unit that would win the fight", () => {
  const defendingPlayer = createPlayer(0);
  defendingPlayer.shields.push(createInstance({ number: 'SH', type: 'unit' }, 0)); // not yet literally lethal
  const attacker = createInstance({ number: 'A', type: 'unit', ap: 1, hp: 1 }, 1);
  const strongBlocker = createInstance({ number: 'S', type: 'unit', ap: 5, hp: 5, keywords: { blocker: true } }, 0);
  defendingPlayer.battleArea.push(strongBlocker);

  const chosen = chooseBlocker(defendingPlayer, attacker, { type: 'player' });

  assert.equal(chosen, null, 'proactive blocking tested worse in practice for a racing deck -- only blocks at literal lethal/bad-trade');
});
