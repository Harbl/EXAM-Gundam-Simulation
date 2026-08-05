const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupCard } = require('../src/cards/index');
const { createInstance, createPlayer, createGame } = require('../src/rules/state');
const { deployUnit, pairPilot } = require('../src/rules/actions');
const { getAP, getKeywords } = require('../src/rules/management');
const { resolveAttack } = require('../src/rules/combat');
const { chooseAttackTarget } = require('../src/ai/heuristic');

test('Hy-Gogg When Linked deploys a rested Hy-Gogg token only if another (Cyclops Team) Unit is already in play', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const hygogg = deployUnit(state, player, lookupCard('GD03-024'));

  lookupCard('GD03-024').effects.whenLinked(state, player, hygogg);
  assert.equal(player.battleArea.length, 1, 'no other Cyclops Team Unit yet, no token');

  const ally = deployUnit(state, player, { number: 'A', type: 'unit', traits: ['Cyclops Team'], ap: 1, hp: 1 });
  lookupCard('GD03-024').effects.whenLinked(state, player, hygogg);
  const token = player.battleArea.find((u) => u.def.number === 'TOKEN-HYGOGG');
  assert.ok(token, 'token deployed once a second Cyclops Team Unit is present');
  assert.equal(token.rested, true);
  assert.equal(getAP(token), 2);
});

test('Kämpfer Burst returns a (Cyclops Team) Pilot card from trash to hand', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const nonMatching = createInstance({ number: 'P1', type: 'pilot', traits: ['Newtype'] }, 0);
  const matching = createInstance({ number: 'P2', type: 'pilot', traits: ['Cyclops Team'] }, 0);
  player.trash.push(nonMatching, matching);

  lookupCard('GD03-017').effects.burst(state, player, createInstance(lookupCard('GD03-017'), 0), {});
  assert.equal(player.hand.includes(matching), true);
  assert.equal(player.trash.includes(nonMatching), true, 'non-matching Pilot is left alone');
});

test('Kämpfer When Paired grants all (Cyclops Team) Units a Lv-independent 5-AP-or-less active-target window, only when paired with a (Cyclops Team) Pilot', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const kampfer = deployUnit(state, player, lookupCard('GD03-017'));
  const ally = deployUnit(state, player, { number: 'A', type: 'unit', traits: ['Cyclops Team'], ap: 5, hp: 5 });
  const target = createInstance({ number: 'T', type: 'unit', level: 9, ap: 4, hp: 3 }, 1);
  opponent.battleArea.push(target);

  const nonCyclopsPilot = createInstance({ number: 'NP', type: 'pilot', traits: ['Newtype'] }, 0);
  pairPilot(state, player, kampfer, nonCyclopsPilot);
  assert.equal(chooseAttackTarget(opponent, ally, true), null, 'unpaired with a Cyclops Team Pilot, grant is inert');

  const mikhail = createInstance(lookupCard('GD03-090'), 0);
  pairPilot(state, player, kampfer, mikhail);
  const result = chooseAttackTarget(opponent, ally, true);
  assert.equal(result.instance, target, 'active AP5 enemy is now a legal target for every Cyclops Team Unit, not just Kämpfer');
});

test('Mikhail Kaminsky Attack grants Breach 1 to a chosen (Cyclops Team) ally this turn, including one that already has it (mandatory "Choose 1", no printed exclusion)', () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const alreadyBreach = deployUnit(state, player, { number: 'B', type: 'unit', traits: ['Cyclops Team'], ap: 1, hp: 1, keywords: { breach: 1 } });
  const target = deployUnit(state, player, { number: 'C', type: 'unit', traits: ['Cyclops Team'], ap: 1, hp: 1 });
  const unrelated = deployUnit(state, player, { number: 'U', type: 'unit', ap: 1, hp: 1 });

  const unit = deployUnit(state, player, { number: 'X', type: 'unit', ap: 2, hp: 2 });
  unit.pilot = createInstance(lookupCard('GD03-090'), 0);
  lookupCard('GD03-090').effects.attack(state, player, unit, { hooks: { chooseUnit: (candidates) => target } });
  assert.equal(getKeywords(target).breach, 1);
  assert.equal(unrelated.buffs.length, 0, 'non-Cyclops-Team Unit is never a candidate');

  const buffed = deployUnit(state, player, { number: 'X2', type: 'unit', ap: 2, hp: 2 });
  buffed.pilot = createInstance(lookupCard('GD03-090'), 0);
  lookupCard('GD03-090').effects.attack(state, player, buffed, { hooks: { chooseUnit: (candidates) => alreadyBreach } });
  assert.equal(alreadyBreach.buffs.length, 1, 'a Cyclops Team Unit that already has Breach is still a legal choice');
});

test("Tokwan's Unit takes no return damage when blocked by a Lv.4-or-lower blocker, but does from a Lv.5+ one", () => {
  const player = createPlayer(0);
  const opponent = createPlayer(1);
  const state = createGame(player, opponent);
  const attacker = deployUnit(state, player, { number: 'A', type: 'unit', ap: 3, hp: 5 });
  attacker.pilot = createInstance(lookupCard('GD04-088'), 0);
  const lowBlocker = createInstance({ number: 'B1', type: 'unit', level: 4, ap: 4, hp: 10, keywords: { blocker: true } }, 1);
  opponent.battleArea.push(lowBlocker);

  resolveAttack(state, 0, attacker, { type: 'player' }, { chooseBlocker: () => lowBlocker });
  assert.equal(attacker.damage, 0, 'immune to return damage from a Lv.4 blocker');

  attacker.rested = false;
  const highBlocker = createInstance({ number: 'B2', type: 'unit', level: 5, ap: 4, hp: 10, keywords: { blocker: true } }, 1);
  opponent.battleArea.push(highBlocker);
  resolveAttack(state, 0, attacker, { type: 'player' }, { chooseBlocker: () => highBlocker });
  assert.equal(attacker.damage, 4, 'not immune to a Lv.5 blocker');
});
