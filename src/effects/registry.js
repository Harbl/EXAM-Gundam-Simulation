const { dealDamage, getRemainingHP } = require('../rules/management');
const { deployUnit, becomeBase } = require('../rules/actions');
const { drawCard } = require('../rules/phases');

function opponentOf(state, player) {
  return state.players.find((p) => p !== player);
}

// --- Guntank GD01-008 ---------------------------------------------------
// [Deploy] Choose 1 rested enemy Unit. Deal 1 damage to it.
function guntankDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  dealDamage(target, 1);
}

// --- Zaku II ST03-008 ----------------------------------------------------
// [Attack] This Unit gets AP+2 during this turn.
function zakuIIAttackBuff(state, player, instance) {
  instance.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Char's Zaku II GD01-026 ---------------------------------------------
// [During Pair][Destroyed] Deploy 1 rested Char's Zaku II (Zeon, AP3/HP1) Unit token.
const CHARS_ZAKU_TOKEN = Object.freeze({
  number: 'TOKEN-CHARS-ZAKU',
  name: "Char's Zaku II",
  type: 'unit',
  color: 'green',
  traits: ['Zeon'],
  ap: 3,
  hp: 1,
  isToken: true,
  keywords: {}
});
function charsZakuGD01026Destroyed(state, player, instance, context) {
  if (!context.wasPaired) return; // gated by [During Pair]
  const token = deployUnit(state, player, CHARS_ZAKU_TOKEN);
  token.rested = true;
}

// --- Char's Zaku II ST03-006 ---------------------------------------------
// [Destroyed] Look at the top 3 cards of your deck. You may reveal 1 (Zeon)/(Neo Zeon) Unit
// card among them and add it to your hand. (Always takes the match if one exists -- with only
// one qualifying category there's no meaningful choice among candidates to model.)
function charsZakuST03006Destroyed(state, player) {
  const top3 = player.deck.splice(0, 3);
  const matchIdx = top3.findIndex(
    (c) => c.def.type === 'unit' && c.def.traits && (c.def.traits.includes('Zeon') || c.def.traits.includes('Neo Zeon'))
  );
  if (matchIdx !== -1) {
    const [chosen] = top3.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.unshift(...top3);
}

// --- Char Aznable ST03-011 (Pilot) ----------------------------------------
// [Attack] During this turn, this Unit gets AP+1 and, if it is a Link Unit, gains <High-Maneuver>.
function charAznableAttack(state, player, unit) {
  unit.buffs.push({ ap: 1, scope: 'turn' });
  if (unit.isLinkUnit) unit.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Amuro Ray ST01-010 (Pilot) --------------------------------------------
// [Burst] Add this card to your hand. [When Paired] Choose 1 enemy Unit with 5 or less HP. Rest it.
function amuroRayBurst(state, player, instance) {
  player.hand.push(instance);
}
function amuroRayWhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 5);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  target.rested = true;
}

// --- Gundam ST01-001 ---------------------------------------------------
// [Repair 2] (keyword, see card data). [During Pair] During your turn, all your Units get AP+1.
function gundamDuringPairStartOfTurn(state, player, instance) {
  if (!instance.pilot) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  for (const unit of player.battleArea) unit.buffs.push({ ap: 1, scope: 'turn' });
}

// --- A Show of Resolve GD01-100 (Command) ---------------------------------
// Draw 2.
function aShowOfResolveCommand(state, player) {
  drawCard(state, player);
  drawCard(state, player);
}

// --- Jaburo GD04-122 (Base) -----------------------------------------------
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand.
// [Activate*Main][Once per Turn] Rest 1 of your (Earth Federation) Units: choose 1 enemy Unit
// that is Lv.3 or lower. Rest it.
function jaburoBurst(state, player, instance) {
  becomeBase(state, player, instance); // fires Deploy internally
}
function jaburoDeploy(state, player, instance) {
  if (player.shields.length === 0) return;
  const shield = player.shields.shift();
  player.hand.push(shield);
}
function jaburoActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.restEnemy) return false;
  const { restUnit, target } = context;
  if (!restUnit || restUnit.rested || !(restUnit.def.traits || []).includes('Earth Federation')) return false;
  if (!target || (target.def.level || 0) > 3) return false;
  restUnit.rested = true;
  target.rested = true;
  instance.activationsUsed.restEnemy = true;
  return true;
}

// --- Zeong GD04-017 --------------------------------------------------------
// Link Condition [Char Aznable]. [When Paired (Newtype) Pilot] Deploy 2 Wire-Guided Arm ((Zeon)
// AP2/HP1, can't be paired) Unit tokens. [Destroyed] Deploy 1 rested Zeong (Head) ((Zeon) AP3/HP1)
// Unit token.
const WIRE_GUIDED_ARM_TOKEN = Object.freeze({
  number: 'TOKEN-WIRE-ARM',
  name: 'Wire-Guided Arm',
  type: 'unit',
  color: 'green',
  traits: ['Zeon'],
  ap: 2,
  hp: 1,
  isToken: true,
  keywords: {},
  cannotBePaired: true
});
const ZEONG_HEAD_TOKEN = Object.freeze({
  number: 'TOKEN-ZEONG-HEAD',
  name: 'Zeong (Head)',
  type: 'unit',
  color: 'green',
  traits: ['Zeon'],
  ap: 3,
  hp: 1,
  isToken: true,
  keywords: {}
});
function zeongWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('Newtype')) return;
  deployUnit(state, player, WIRE_GUIDED_ARM_TOKEN);
  deployUnit(state, player, WIRE_GUIDED_ARM_TOKEN);
}
function zeongDestroyed(state, player) {
  const token = deployUnit(state, player, ZEONG_HEAD_TOKEN);
  token.rested = true;
}

module.exports = {
  guntankDeploy,
  zakuIIAttackBuff,
  charsZakuGD01026Destroyed,
  charsZakuST03006Destroyed,
  charAznableAttack,
  amuroRayBurst,
  amuroRayWhenPaired,
  gundamDuringPairStartOfTurn,
  aShowOfResolveCommand,
  jaburoBurst,
  jaburoDeploy,
  jaburoActivateMain,
  zeongWhenPaired,
  zeongDestroyed
};
