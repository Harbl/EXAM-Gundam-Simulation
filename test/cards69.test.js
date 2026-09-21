const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getRemainingHP } = require('../src/rules/management');
const { collectActivateCandidates, collectActivateActionCandidates, ATTACKER_ACTION_RESOLVERS } = require('../src/ai/activations');
const { collectAttackCandidates } = require('../src/ai/heuristic');
const registry = require('../src/effects/registry');
const { lookupCard } = require('../src/cards/index');

// ST13 "Silent Barrage" -- covers the Bit/Funnel token's "can't attack" restriction (a new permanent
// def-level flag, collectAttackCandidates), the allyPaired-triggered token deploy, and a spot-check
// of the rest of the set's more ordinary effects.

test("Qubeley ST13-001: deploys 2 Bit/Funnel tokens (once per turn) when you pair a Pilot during your own turn, and they can't attack", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const qubeley = deployUnit(state, player, lookupCard('ST13-001'));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 2 });

  pairPilot(state, player, unit, createInstance({ number: 'P', type: 'pilot' }, 0));
  assert.equal(player.battleArea.filter((u) => u.def.number === 'TOKEN-BIT-FUNNEL').length, 2);
  assert.equal(collectAttackCandidates(state, 0).some((c) => c.attacker.def.number === 'TOKEN-BIT-FUNNEL'), false, "tokens can't attack");

  const unit2 = deployUnit(state, player, { number: 'U2', type: 'unit', ap: 2, hp: 2 });
  pairPilot(state, player, unit2, createInstance({ number: 'P2', type: 'pilot' }, 0));
  assert.equal(player.battleArea.filter((u) => u.def.number === 'TOKEN-BIT-FUNNEL').length, 2, 'once per turn -- no more from a second pairing');
});

test('Qubeley ST13-001 Activate·Main: begins a damage-step-only battle between a Unit token and an enemy Unit, paying (1)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const qubeley = deployUnit(state, player, lookupCard('ST13-001'));
  const token = deployUnit(state, player, { number: 'TOKEN-BIT-FUNNEL', type: 'unit', ap: 2, hp: 2 });
  player.resourceArea.push(createInstance({ number: 'R', type: 'resource' }, 0));
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 5 });

  let candidates = collectActivateCandidates(state, 0);
  const candidate = candidates.find((c) => c.source === qubeley);
  assert.ok(candidate, 'offered with an active Resource and a Unit token in play');
  candidate.handler(state, player, qubeley, candidate.args);

  assert.equal(player.resourceArea[0].rested, true);
  assert.equal(enemy.damage, 2, "took the token's AP as damage");
  assert.equal(token.damage, 3, "the token took the enemy's AP as return damage");
});

test('GX-Bit ST13-004 Deploy: keeps a Unit/Base on top, buries anything else', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.deck.push(createInstance({ number: 'C', type: 'command' }, 0), createInstance({ number: 'U', type: 'unit' }, 0));

  registry.gxBitST13004Deploy(state, player);
  assert.equal(player.deck[player.deck.length - 1].def.number, 'C', 'the non-Unit/Base card is buried');
  assert.equal(player.deck[0].def.number, 'U');
});

test('Gundam Pharact ST13-009 Attack: the opponent exiles their 2 cheapest trashed Units, not the priciest', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const cheap = createInstance({ number: 'C', type: 'unit', cost: 1 }, 1);
  const mid = createInstance({ number: 'M', type: 'unit', cost: 2 }, 1);
  const pricey = createInstance({ number: 'P', type: 'unit', cost: 4 }, 1);
  opponent.trash.push(pricey, cheap, mid);

  registry.gundamPharactST13009Attack(state, player);
  assert.equal(opponent.trash.includes(cheap), false);
  assert.equal(opponent.trash.includes(pricey), true);
});

test('Red Gundam (0079) ST13-010: Activate·Main destroys a friendly Unit token to gain Breach 3, once per turn', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const redGundam = deployUnit(state, player, lookupCard('ST13-010'));
  const token = deployUnit(state, player, { number: 'TOKEN-BIT-FUNNEL', type: 'unit', isToken: true, ap: 2, hp: 2 });

  const candidates = collectActivateCandidates(state, 0);
  const candidate = candidates.find((c) => c.source === redGundam);
  assert.ok(candidate);
  candidate.handler(state, player, redGundam, candidate.args);

  assert.equal(player.battleArea.includes(token), false);
  assert.equal(redGundam.buffs.some((b) => b.breach === 3), true);
});

test('Haman Karn ST13-011 When Paired: reveals a Pilot at or below the paired Unit\'s level from the top 5', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', level: 6, ap: 2, hp: 2 });
  const tooHigh = createInstance({ number: 'P1', type: 'pilot', level: 7 }, 0);
  const eligible = createInstance({ number: 'P2', type: 'pilot', level: 4 }, 0);
  for (let i = 0; i < 3; i++) player.deck.push(createInstance({ number: 'F' + i, type: 'unit' }, 0));
  player.deck.push(tooHigh, eligible);

  registry.hamanKarnST13011WhenPaired(state, player, unit);
  assert.equal(player.hand.includes(eligible), true);
  assert.equal(player.hand.includes(tooHigh), false);
  assert.equal(player.deck.length, 4, '4 of the 5 dug cards return to the deck');
});

test("Suletta Mercury ST13-012: draws once per turn the first time the paired Unit destroys an enemy", () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const unit = deployUnit(state, player, { number: 'U', type: 'unit', ap: 2, hp: 2 });
  player.deck.push(createInstance({ number: 'D1', type: 'unit' }, 0), createInstance({ number: 'D2', type: 'unit' }, 0));

  registry.sulettaMercuryST13012DestroysEnemy(state, player, unit);
  assert.equal(player.hand.length, 1);
  registry.sulettaMercuryST13012DestroysEnemy(state, player, unit);
  assert.equal(player.hand.length, 1, 'once per turn');
});

test('Final Duty ST13-014: sacrifices the weakest friendly Unit, then may deploy a Lv.4-or-lower Unit from the top 4', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  const weak = deployUnit(state, player, { number: 'W', type: 'unit', ap: 1, hp: 1 });
  const strong = deployUnit(state, player, { number: 'S', type: 'unit', ap: 5, hp: 5 });
  const tooHigh = createInstance({ number: 'H', type: 'unit', level: 5 }, 0);
  const eligible = createInstance({ number: 'E', type: 'unit', level: 4, ap: 3, hp: 3 }, 0);
  player.deck.push(tooHigh, eligible, createInstance({ number: 'F1', type: 'unit' }, 0), createInstance({ number: 'F2', type: 'unit' }, 0));

  registry.finalDutyST13014Command(state, player);
  assert.equal(player.battleArea.includes(weak), false, 'the weakest Unit was sacrificed');
  assert.equal(player.battleArea.includes(strong), true);
  assert.equal(player.battleArea.some((u) => u.def === eligible.def), true, 'the eligible dug card was deployed');
});

test('Operation to Intercept Solomon ST13-015: exiles 3 trashed Units and deals 3 damage to the biggest enemy Unit, but only with 3 available', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const enemy = deployUnit(state, opponent, { number: 'E', type: 'unit', ap: 3, hp: 5 });
  player.trash.push(createInstance({ number: 'T1', type: 'unit' }, 0), createInstance({ number: 'T2', type: 'unit' }, 0));

  registry.operationToInterceptSolomonST13015Command(state, player);
  assert.equal(enemy.damage, 0, 'not enough trashed Units yet');

  player.trash.push(createInstance({ number: 'T3', type: 'unit' }, 0));
  registry.operationToInterceptSolomonST13015Command(state, player);
  assert.equal(player.trash.length, 0);
  assert.equal(enemy.damage, 3);
});

test('Sodon ST13-016 Deploy: adds a Shield to hand and deploys a Bit/Funnel token', () => {
  const player = createPlayer(0);
  const state = createGame(player, createPlayer(1));
  player.shields.push(createInstance({ number: 'S1', type: 'unit' }, 0));

  registry.sodonST13016Deploy(state, player);
  assert.equal(player.hand.length, 1);
  assert.equal(player.battleArea.some((u) => u.def.number === 'TOKEN-BIT-FUNNEL'), true);
});
