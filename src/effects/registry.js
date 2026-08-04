const { dealDamage, getAP, getHP, getRemainingHP, getKeywords, isImmuneToEffectDestroy, recoverHP, removeFromField, restBaseOrRedirect, destroyCard, sendToZone, destroyTopShield, discardFromHand } = require('../rules/management');
const { deployUnit, deployBase, becomeBase, pairPilotFromTrash, pairPilot } = require('../rules/actions');
const { drawCard } = require('../rules/phases');
const { resolveUnitBattleDamage, applyBreach, destroyAndFireEffect, destroyOutrightAndFireEffect, resolveBurst } = require('../rules/combat');
const { fireCardEffect, dealEffectDamage, reduceEnemyAP, placeExResource, setActiveByEffect, restEnemyByEffect, payAbilityCost } = require('../rules/effects');
const { createInstance, shuffle } = require('../rules/state');
const { EX_RESOURCE_DEF, EX_BASE_DEF } = require('../rules/setup');
const { canAfford, payCost } = require('../rules/cost');

function opponentOf(state, player) {
  return state.players.find((p) => p !== player);
}

// Shared by Gaia Gundam (LR+) GD05-034 and Abyss Gundam (MA Mode) GD05-046: forces a card out of
// the enemy's hand and flags the turn for Gaia Gundam (MA Mode) GD05-041's "your opponent discarded
// due to one of your effects" hand cost reduction (src/rules/cost.js) to read.
function forceEnemyDiscard(player, opponent, card) {
  opponent.hand.splice(opponent.hand.indexOf(card), 1);
  opponent.trash.push(card);
  player.enemyDiscardedByEffectThisTurn = true;
}

// Shared by Sazabi (R+) GD05-052's Deploy sacrifice and Gyunei's Jagd Doga GD05-057's Activate-Main
// self-destroy: destroys one of the controller's own Units as an effect cost. Flags the existing
// player.neoZeonSelfDestroyThisTurn (Axis GD05-129 precedent, src/rules/phases.js) when the source
// is (Neo Zeon) -- set BEFORE firing 'destroyed' so it's also visible synchronously to Quess's Jagd
// Doga (R+) GD05-053's own "destroyed by one of your (Neo Zeon) card's effects" reaction. Also
// broadcasts to the field for Alpha Azieru GD05-054's "when one of your Units is destroyed by an
// effect, draw 1" (Once per Turn).
function destroyFriendlyByEffect(state, player, source, target) {
  if ((source.def.traits || []).includes('Neo Zeon')) player.neoZeonSelfDestroyThisTurn = true;
  const pilot = target.pilot;
  destroyCard(state, player, target);
  fireCardEffect(state, player, target, 'destroyed', { wasPaired: !!pilot, pilot });
  for (const c of [...player.battleArea, player.base].filter(Boolean)) {
    const handler = c.def.effects && c.def.effects.friendlyUnitDestroyedByEffect;
    if (handler) handler(state, player, c, { target });
  }
}

// --- Guntank GD01-008 ---------------------------------------------------
// [Deploy] Choose 1 rested enemy Unit. Deal 1 damage to it.
// (Heuristic default: the lowest-remaining-HP candidate, for the best shot at a kill/chip value.)
// Also reused verbatim by Anksha GD01-020, which has byte-identical text.
function guntankDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 1);
  destroyAndFireEffect(state, opponent, target);
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
// (Heuristic default: the highest-AP eligible candidate -- neutralize the biggest threat.)
function amuroRayBurst(state, player, instance) {
  player.hand.push(instance);
}
function amuroRayWhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 5);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
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

// --- Kayra's Re-GZ GD05-029 ------------------------------------------------
// [Deploy] Look at the top card of your deck. Return it to the top or bottom of your deck.
// (Heuristic: keep a Unit/Base on top since it's an immediate board play; bury anything else.)
function kayrasRegzDeploy(state, player) {
  if (player.deck.length === 0) return;
  const top = player.deck[0];
  const worthKeeping = top.def.type === 'unit' || top.def.type === 'base';
  if (!worthKeeping) {
    player.deck.shift();
    player.deck.push(top);
  }
}

// --- Re-GZ GD05-019 ---------------------------------------------------------
// [Destroyed] Look at the top 3 cards of your deck. You may reveal 1 (Londo Bell) Unit card among
// them and add it to your hand. Return the remaining cards randomly to the bottom of your deck.
function regzDestroyed(state, player) {
  const top3 = player.deck.splice(0, 3);
  const matchIdx = top3.findIndex((c) => c.def.type === 'unit' && (c.def.traits || []).includes('Londo Bell'));
  if (matchIdx !== -1) {
    const [chosen] = top3.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// --- Gundam AGE-2 Normal (SP Ver.) GD05-024 ---------------------------------
// [Destroyed] Choose 1 green (Earth Federation) Pilot card from your trash. Add it to your hand.
// If you do, discard 1. (Heuristic: discard whichever hand card is least immediately useful.)
function gundamAge2Destroyed(state, player) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'pilot' && c.def.color === 'green' && (c.def.traits || []).includes('Earth Federation')
  );
  if (candidates.length === 0) return;
  const chosen = candidates[0];
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);

  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  discardFromHand(player, toDiscard);
}

// --- Nu Gundam GD05-020 ------------------------------------------------------
// [During Pair] This Unit gains <Breach 3> (see card data). [Deploy] If there are 2 or more
// (Londo Bell) cards in your trash, place 1 EX Resource.
function nuGundam020Deploy(state, player) {
  const londoBellInTrash = player.trash.filter((c) => (c.def.traits || []).includes('Londo Bell')).length;
  if (londoBellInTrash < 2) return;
  player.resourceArea.push(createInstance(EX_RESOURCE_DEF, player.id));
}

// --- Nu Gundam GD05-017 -------------------------------------------------------
// <Breach 5> (see card data). [When Paired] You may choose 3 (Londo Bell) cards from your trash.
// Exile them. If you do, choose 1 enemy Unit; begin a battle between this Unit and it, only
// performing the damage step (no rest/block/action -- reuses the same damage-exchange rules).
// (Heuristic: only worth burning 3 trashed cards for a favorable/safe kill, same bar as a normal
// attack decision -- picks the best such kill if a hook is given, else finds one unassisted.)
function nuGundam017WhenPaired(state, player, unit, context) {
  const londoBellCards = player.trash.filter((c) => (c.def.traits || []).includes('Londo Bell'));
  if (londoBellCards.length < 3) return;
  const opponent = opponentOf(state, player);

  const unitAP = getAP(unit);
  const isFavorableKill = (u) => unitAP >= getRemainingHP(u) && getAP(u) < getRemainingHP(unit);
  const target =
    context.hooks && context.hooks.chooseUnit
      ? context.hooks.chooseUnit(opponent.battleArea.filter(isFavorableKill))
      : opponent.battleArea.find(isFavorableKill);
  if (!target) return;

  for (const card of londoBellCards.slice(0, 3)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  resolveUnitBattleDamage(state, player, opponent, unit, target, {});
}

// --- Amuro Ray GD05-085 (Pilot) ----------------------------------------------
// [Burst] Add this card to your hand. [During your turn, when this Unit destroys an enemy Unit
// with battle damage, this Unit recovers 2 HP] (all battles in this engine happen on the active
// player's turn, so no separate turn check is needed here).
function amuroRay085Burst(state, player, instance) {
  player.hand.push(instance);
}
function amuroRay085DestroysEnemy(state, player, unit) {
  recoverHP(unit, 2);
}

// --- Ra Cailum GD05-125 (Base) -----------------------------------------------
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Activate*Main] Rest this
// Base: choose 1 friendly (Londo Bell) Unit. During this turn, when it receives enemy damage,
// reduce it by 1.
function raCailumBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function raCailumDeploy(state, player) {
  if (player.shields.length === 0) return;
  player.hand.push(player.shields.shift());
}
function raCailumActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const target = context.target;
  if (!target || !(target.def.traits || []).includes('Londo Bell')) return false;
  instance.rested = true;
  target.buffs.push({ damageReduction: 1, scope: 'turn' });
  return true;
}

// --- Corsica Base ST02-016 ----------------------------------------------------
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn,
// deploy 1 [Tallgeese] ((OZ) AP4/HP2) Unit token. If it is your turn and a card with "Corsica Base"
// in its card name is in your trash, deploy 2 [Leo] ((OZ) AP1/HP1) Unit tokens instead.
const TALLGEESE_TOKEN = Object.freeze({
  number: 'TOKEN-TALLGEESE',
  name: 'Tallgeese',
  type: 'unit',
  color: 'blue',
  traits: ['OZ'],
  ap: 4,
  hp: 2,
  isToken: true,
  keywords: {}
});
const LEO_TOKEN = Object.freeze({
  number: 'TOKEN-LEO',
  name: 'Leo',
  type: 'unit',
  color: 'blue',
  traits: ['OZ'],
  ap: 1,
  hp: 1,
  isToken: true,
  keywords: {}
});
function corsicaBaseBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function corsicaBaseDeploy(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());

  const isOwnTurn = state.players[state.activePlayerIdx] === player;
  if (!isOwnTurn) return;

  const priorCopyTrashed = player.trash.some((c) => c.def.name === 'Corsica Base');
  if (priorCopyTrashed) {
    deployUnit(state, player, LEO_TOKEN);
    deployUnit(state, player, LEO_TOKEN);
  } else {
    deployUnit(state, player, TALLGEESE_TOKEN);
  }
}

// --- Overflowing Affection GD01-118 (Command) ---
// [Main] Draw 2. Then, discard 1.
function overflowingAffectionCommand(state, player) {
  drawCard(state, player);
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Aile Strike Gundam ST04-001 ---
// <Blocker> (data). [When Paired][Lv.4 or Higher Pilot] Choose 1 enemy Unit with 4 or less HP.
// Return it to its owner's hand.
function aileStrikeGundamWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || (pilot.def.level || 0) < 4) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Strike Freedom Gundam GD05-002 ---
// [Deploy] Choose 1 to 2 of your Units. During this turn, when they destroy an enemy card with
// battle damage, draw 1. [During Pair][Attack] You may discard 2. If you do, choose 1 enemy Unit
// with the lowest Lv. Return it to the bottom of its owner's deck.
function strikeFreedomDeploy(state, player) {
  const targets = player.battleArea.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const u of targets) u.buffs.push({ onKillDraw: 1, scope: 'turn' });
}
function strikeFreedomAttack(state, player, unit) {
  if (!unit.pilot || player.hand.length < 2) return;
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => (a.def.level || 0) - (b.def.level || 0))[0];
  if (!target) return;
  const discards = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0)).slice(0, 2);
  for (const c of discards) {
    player.hand.splice(player.hand.indexOf(c), 1);
    player.trash.push(c);
  }
  removeFromField(opponent, target, opponent.deck);
  sendToZone(opponent.deck, target);
}

// --- Kira Yamato ST04-010 (Pilot) ---
// [Burst] Add this card to your hand. [Attack] Choose 1 enemy Unit. It gets AP-2 during this battle.
function kiraYamatoST04010Burst(state, player, instance) {
  player.hand.push(instance);
}
function kiraYamatoST04010Attack(state, player, unit, context) {
  if (!context.target || context.target.type !== 'unit') return;
  context.target.instance.buffs.push({ ap: -2, scope: 'battle' });
}

// --- Kira Yamato GD05-081 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] If this is an (Orb)/(Triple Ship Alliance)
// Unit, draw 1.
function kiraYamatoGD05081Burst(state, player, instance) {
  player.hand.push(instance);
}
function kiraYamatoGD05081WhenLinked(state, player, unit) {
  const traits = unit.def.traits || [];
  if (traits.includes('Orb') || traits.includes('Triple Ship Alliance')) drawCard(state, player);
}

// --- Victory Gundam GD04-003 ---
// [Attack] If you have 3 or more (League Militaire) Units in play, draw 1.
function victoryGundamGD04003Attack(state, player) {
  const count = player.battleArea.filter((u) => (u.def.traits || []).includes('League Militaire')).length;
  if (count >= 3) drawCard(state, player);
}

// --- V-Dash Gundam GD04-006 ---
// <Breach 3> (data). [Activate*Main][Once per Turn] Rest 1 of your other (League Militaire) Units:
// Choose 1 enemy Unit with 4 or less HP. Rest it.
function vDashGundamActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.restEnemy) return false;
  const { restUnit, target } = context;
  if (!restUnit || restUnit.rested || !(restUnit.def.traits || []).includes('League Militaire')) return false;
  if (!target || getRemainingHP(target) > 4) return false;
  restUnit.rested = true;
  target.rested = true;
  instance.activationsUsed.restEnemy = true;
  return true;
}

// --- Üso Ewin GD04-081 (Pilot) & Reineforce Jr. GD04-121 (Base) share the [Parts] token ---
// Üso Ewin: [Burst] Add this card to hand. [When Paired] If this is a (League Militaire) Unit,
// deploy 1 [Parts] token. Reineforce Jr.: [Burst] Deploy this card. [Deploy] Add 1 of your Shields
// to your hand. Then, during your turn, if a friendly (League Militaire) Unit is in play, deploy
// 1 [Parts] token.
const PARTS_TOKEN = Object.freeze({
  number: 'TOKEN-PARTS',
  name: 'Parts',
  type: 'unit',
  color: 'blue',
  traits: ['League Militaire'],
  ap: 1,
  hp: 1,
  isToken: true,
  keywords: {},
  cannotAttackPlayer: true
});
function usoEwinBurst(state, player, instance) {
  player.hand.push(instance);
}
function usoEwinWhenPaired(state, player, unit) {
  if (!(unit.def.traits || []).includes('League Militaire')) return;
  deployUnit(state, player, PARTS_TOKEN);
}
function reineforceJrBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function reineforceJrDeploy(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  const isOwnTurn = state.players[state.activePlayerIdx] === player;
  if (!isOwnTurn) return;
  const hasLeagueMilitaire = player.battleArea.some((u) => (u.def.traits || []).includes('League Militaire'));
  if (hasLeagueMilitaire) deployUnit(state, player, PARTS_TOKEN);
}

// --- Airframe Seizure GD05-111 (Command) ---
// [Main] Discard 1. If you do, draw 2.
function airframeSeizureCommand(state, player) {
  if (player.hand.length === 0) return;
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  discardFromHand(player, toDiscard);
  drawCard(state, player);
  drawCard(state, player);
}

// --- Darkness Finger GD05-110 (Command, Special Move) ---
// [Burst] Activate this card's Main. [Main/Action] Choose 1 enemy Unit. Deal 2 damage to it. Then,
// if you have a Unit with "Master Gundam" in its card name in play, draw 1.
function darknessFingerCommand(state, player, instance, context) {
  player.specialMoveActivatedThisTurn = true;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 2);
  if (player.battleArea.some((u) => (u.def.name || '').includes('Master Gundam'))) drawCard(state, player);
}
function darknessFingerBurst(state, player, instance) {
  darknessFingerCommand(state, player, instance, {});
}

// --- Gundam Maxter GD05-069 ---
// [Destroyed-on-kill] During your turn, when this Unit destroys an enemy Unit with battle damage,
// look at the top 4 cards of your deck. You may reveal 1 (Special Move) Command card among them
// and add it to your hand. Return the rest randomly to the bottom of your deck. [During Link]
// [Attack] Activate Main on the card paired with this Unit (currently a no-op until a Pilot with
// its own Activate-Main ability exists, since none do yet).
function gundamMaxterDestroysEnemy(state, player) {
  const top4 = player.deck.splice(0, 4);
  const matchIdx = top4.findIndex((c) => c.def.type === 'command' && (c.def.traits || []).includes('Special Move'));
  if (matchIdx !== -1) {
    const [chosen] = top4.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top4));
}
function gundamMaxterAttack(state, player, unit) {
  if (!unit.isLinkUnit || !unit.pilot) return;
  const pilotActivateMain = unit.pilot.def.effects && unit.pilot.def.effects.activateMain;
  if (pilotActivateMain) pilotActivateMain(state, player, unit.pilot, {});
}

// --- Rising Gundam GD05-072 ---
// [When Linked] Choose 1 enemy Unit with 4 or less HP. Rest it.
function risingGundamWhenLinked(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.rested = true;
}

// --- Shining Gundam GD05-066 ---
// [Deploy] You may choose 2 (MF) Unit cards from your trash. Exile them. If you do, choose 1
// (Special Move) Command card from your trash. Add it to your hand. [Attack][Once per Turn]
// Choose 1 of your rested Resources. Set it as active.
function shiningGundam066Deploy(state, player, instance) {
  const mfUnits = player.trash.filter((c) => c.def.type === 'unit' && (c.def.traits || []).includes('MF'));
  if (mfUnits.length < 2) return;
  const specialMoveCommand = player.trash.find(
    (c) => c.def.type === 'command' && (c.def.traits || []).includes('Special Move')
  );
  if (!specialMoveCommand) return;
  for (const card of mfUnits.slice(0, 2)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  player.trash.splice(player.trash.indexOf(specialMoveCommand), 1);
  player.hand.push(specialMoveCommand);
}
function shiningGundam066Attack(state, player, unit) {
  if (unit.activationsUsed.untapResource) return;
  const restedResource = player.resourceArea.find((r) => r.rested);
  if (!restedResource) return;
  restedResource.rested = false;
  unit.activationsUsed.untapResource = true;
}

// --- Master Gundam GD05-033 ---
// [Attack] You may choose 2 (Special Move) Command cards from your trash. Exile them. If you do,
// deal 5 damage to the first card in your opponent's shield area.
function masterGundamAttack(state, player, unit, context) {
  const specialMoveCards = player.trash.filter(
    (c) => c.def.type === 'command' && (c.def.traits || []).includes('Special Move')
  );
  if (specialMoveCards.length < 2) return;
  for (const card of specialMoveCards.slice(0, 2)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  applyBreach(state, opponentOf(state, player), 5, context.hooks || {}, unit);
}

// --- Domon Kasshu GD05-097 (Pilot) ---
// [Burst] Add this card to your hand. [When Paired] Draw 1. Then, discard 1. If you discard a
// (Special Move) Command card with this effect, you may activate its Main.
function domonKasshuBurst(state, player, instance) {
  player.hand.push(instance);
}
function domonKasshuWhenPaired(state, player) {
  drawCard(state, player);
  // Real card text ties a bonus to WHICH card gets discarded ("if you discard a (Special Move)
  // Command card with this effect, you may activate its Main"), unlike every other plain "discard 1"
  // site in this file (which is why they default to the generic highest-cost heuristic) -- so this one
  // deliberately seeks out a (Special Move) Command first, only falling back to that generic default
  // when hand has none. Found via a real strategy write-up describing this exact discard-for-value
  // line (discard Shining Finger off Domon Kasshu to rest/kill an enemy Unit) that the old
  // highest-cost-only selection could easily miss whenever a bigger non-Special-Move card was in hand.
  const specialMoveCommands = player.hand.filter((c) => c.def.type === 'command' && (c.def.traits || []).includes('Special Move'));
  const toDiscard = specialMoveCommands.sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0]
    || [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (!toDiscard) return;
  discardFromHand(player, toDiscard);

  const isSpecialMoveCommand = toDiscard.def.type === 'command' && (toDiscard.def.traits || []).includes('Special Move');
  if (isSpecialMoveCommand && toDiscard.def.effects && toDiscard.def.effects.command) {
    toDiscard.def.effects.command(state, player, toDiscard, {});
  }
}

// --- Victory Gundam GD04-011 ---
// [Destroyed] If another friendly (League Militaire) Unit is in play, deploy 1 [Parts] token
// (shares the same token as Üso Ewin/Reineforce Jr., defined further below).
function victoryGundamGD04011Destroyed(state, player) {
  const hasOtherLeagueMilitaire = player.battleArea.some((u) => (u.def.traits || []).includes('League Militaire'));
  if (!hasOtherLeagueMilitaire) return;
  deployUnit(state, player, PARTS_TOKEN);
}

// --- Unforeseen Incident ST01-014 (Command) ---
// [Burst] Activate this card's Main. [Main/Action] Choose 1 enemy Unit. It gets AP-3 during this turn.
function unforeseenIncidentCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ ap: -3, scope: 'turn' });
}
function unforeseenIncidentBurst(state, player, instance, context) {
  unforeseenIncidentCommand(state, player, instance, context);
}

// --- Master Asia GD05-089 (Pilot) ---
// [Burst] Add this card to your hand. If there are 3+ (MF) cards in your trash, you may deploy it
// as an AP3/HP3 Unit instead (don't treat it as a Pilot). [During Link][Attack] If you have
// activated a (Special Move) Command card's Main/Action this turn, choose 1 enemy Unit, deal 2.
function masterAsiaBurst(state, player, instance) {
  const mfInTrash = player.trash.filter((c) => (c.def.traits || []).includes('MF')).length;
  if (mfInTrash < 3) {
    player.hand.push(instance);
    return;
  }
  instance.def = Object.assign({}, instance.def, { type: 'unit', ap: 3, hp: 3 });
  instance.turnDeployed = state.turnNumber;
  player.battleArea.push(instance);
}
function masterAsiaAttack(state, player, unit, context) {
  if (!unit.isLinkUnit || !player.specialMoveActivatedThisTurn) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 2);
}

// --- Cyclone Punch GD05-121 (Command, Special Move; pairable from trash as a Pilot) ---
// [Main] Choose 1 enemy Unit. It gets AP-2 during this turn. After activating this card's Main,
// you may pair this card from your trash with one of your (MF) Units (the +1/+1 Chibodee Crocket
// pairing itself is handled by the AI's runCommands via the shared `pairPilotFromTrash` helper).
function cyclonePunchCommand(state, player, instance, context) {
  player.specialMoveActivatedThisTurn = true;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Shining Finger GD05-120 (Command, Special Move) ---
// [Burst] Add this card to your hand. [Main/Action] Choose 1 enemy Unit with 4 or less HP. Rest it.
// Then, you may choose 1 of your Units with "Shining Gundam" in its card name; it gets First Strike.
function shiningFingerBurst(state, player, instance) {
  player.hand.push(instance);
}
function shiningFingerCommand(state, player, instance, context) {
  player.specialMoveActivatedThisTurn = true;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.rested = true;
  const shiningGundam = player.battleArea.find((u) => (u.def.name || '').includes('Shining Gundam'));
  if (shiningGundam) shiningGundam.buffs.push({ keyword: 'firstStrike', scope: 'turn' });
}

// --- Gundam Fight GD05-128 (Base, Stronghold) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Activate*Main] Rest this
// Base: if a friendly (MF) Link Unit is in play, choose 1 friendly Unit. It gets AP+2 this turn.
function gundamFightBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function gundamFightDeploy(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}
function gundamFightActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const hasMfLink = player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('MF'));
  if (!hasMfLink) return false;
  const target = context.target;
  if (!target) return false;
  instance.rested = true;
  target.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Gundam Exia Repair GD05-050 ---
// When this Unit deals battle damage to an enemy Unit that is Lv.4 or lower with no paired Pilot,
// destroy that enemy Unit outright (modeled as topping up its damage to lethal, so the engine's
// normal destroy/Breach/destroysEnemy chain still fires exactly as any other kill would).
// [Destroyed] Place the top 2 cards of your deck into your trash.
function gundamExiaRepairDealsBattleDamage(state, player, unit, context) {
  const defender = context.defender;
  if (!defender || defender.pilot) return;
  if ((defender.def.level || 0) > 4) return;
  defender.damage = getHP(defender);
}
function gundamExiaRepairDestroyed(state, player) {
  player.trash.push(...player.deck.splice(0, 2));
}

// --- Gundam Barbatos 1st Form GD02-054 ---
// [Attack] If this Unit is damaged, draw 1.
function gundamBarbatos1stFormAttack(state, player, unit) {
  if (unit.damage > 0) drawCard(state, player);
}

// --- Gundam Barbatos Adapt GD03-056 (Deploy) & Mikazuki Augus ST05-010 (When Paired) share text ---
// Choose 1 of your Units and 1 enemy Unit. Deal 1 damage to them.
function gundamBarbatosAdaptDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  // Tekkadan's whole design wants its own Units damaged (e.g. Gundam Barbatos 1st Form GD02-054:
  // "[Attack] If this Unit has damage, draw 1"), unlike the generic "damage your tankiest Unit for
  // safety" default every other friendly-damage effect in this file falls back to -- so this
  // specifically seeks out a still-undamaged benefitsFromSelfDamage Unit first (found via real
  // strategy discussion describing Tekkadan's self-damage payoffs, which the tankiest-HP-only default
  // had no way to notice).
  const selfDamageCandidates = player.battleArea.filter((u) => u.def.benefitsFromSelfDamage && u.damage === 0);
  const friendlyTarget = selfDamageCandidates.length > 0
    ? selfDamageCandidates.sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0]
    : context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : [...player.battleArea].sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  const enemyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (friendlyTarget) dealDamage(friendlyTarget, 1);
  if (enemyTarget) dealDamage(enemyTarget, 1);
}
function mikazukiAugusBurst(state, player, instance) {
  player.hand.push(instance);
}
function mikazukiAugusWhenPaired(state, player, unit, context) {
  gundamBarbatosAdaptDeploy(state, player, unit, context);
}

// --- Widespread Annihilation GD05-114 (Command) ---
// [Main] Destroy all Units that are Lv.4 or lower (both players' -- an outright destroy regardless
// of remaining HP, so it can't reuse the HP-check-gated combat destroy helper; still fires each
// Unit's own Destroyed trigger, same as any other kill).
function widespreadAnnihilationCommand(state, player) {
  for (const p of state.players) {
    const toDestroy = p.battleArea.filter(
      (u) => (u.def.level || 0) <= 4 && !(p !== player && isImmuneToEffectDestroy(u))
    );
    for (const unit of toDestroy) {
      destroyOutrightAndFireEffect(state, p, unit);
    }
  }
}

// --- Sword Strike Gundam GD01-073 ---
// [During Link][Attack] Choose 1 enemy Unit with 2 or less HP. Return it to its owner's hand.
// (No link condition is legible on this print's scan, so it stays a plain vanilla body unless/until
// some other effect grants it Link status -- flagged as a research gap, not guessed at.)
function swordStrikeGundamAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Underground Desert Base GD01-126 & Mining Asteroid Palau GD01-128 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. (Shared with several other
// simple Stronghold Bases already in the DB -- kept as its own pair of one-liners here to match the
// existing per-card convention rather than retrofitting the older cards onto a shared name.)
function simpleBurstBase(state, player, instance) {
  becomeBase(state, player, instance);
}
function simpleBaseDeployAddShield(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}

// --- Gundam Gusion Rebake GD02-055 ---
// <Blocker> (data). [Deploy] Choose 1 of your Units and 1 enemy Unit. Deal 1 damage to them
// (identical text to Gundam Barbatos Adapt's Deploy, defined above -- reused directly).

// --- Gun EZ GD04-015 ---
// [Deploy] Choose 1 of your active (League Militaire) Units and 1 enemy Unit that is Lv.3 or lower.
// Rest them.
function gunEZDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const friendlyCandidates = player.battleArea.filter((u) => !u.rested && (u.def.traits || []).includes('League Militaire'));
  const friendlyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(friendlyCandidates)
    : friendlyCandidates.sort((a, b) => getAP(a) - getAP(b))[0];
  const enemyCandidates = opponent.battleArea.filter((u) => !u.rested && (u.def.level || 0) <= 3);
  const enemyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(enemyCandidates)
    : enemyCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!friendlyTarget || !enemyTarget) return;
  friendlyTarget.rested = true;
  enemyTarget.rested = true;
}

// --- V2 Gundam GD05-001 ---
// <Repair 2> (data). [Activate*Main][Once per Turn] Rest 2 of your Units: set this Unit as active.
// (Engine-correct, but not yet wired into the AI's runActivations -- resting 2 other Units to untap
// this one is rarely worth it under the current heuristic and needs real judgement to use well;
// flagged rather than guessed at with a shallow always-fire rule.)
function v2GundamActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.setActive) return false;
  const { restUnits } = context;
  if (!restUnits || restUnits.length < 2) return false;
  const valid = restUnits.every((u) => u !== instance && !u.rested && player.battleArea.includes(u));
  if (!valid) return false;
  for (const u of restUnits) u.rested = true;
  instance.rested = false;
  instance.activationsUsed.setActive = true;
  return true;
}

// --- Graceful Demeanor GD04-117 (Command) ---
// [Burst] Activate this card's Action. [Action] Choose 1 to 2 enemy Units that are Lv.3 or lower.
// Return them to their owners' hands.
function gracefulDemeanorCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const t of targets) {
    removeFromField(opponent, t, opponent.hand);
    sendToZone(opponent.hand, t);
  }
}
function gracefulDemeanorBurst(state, player, instance, context) {
  gracefulDemeanorCommand(state, player, instance, context);
}

// --- Rick Dias GD02-079 ---
// <Blocker> (data). No other printed ability.

// --- Silver Bullet GD04-068 ---
// <Blocker> (data). When this Unit receives effect damage from an enemy, reduce it by 3 (a
// permanent, un-scoped buff -- see `effectDamageReduction` in dealDamage).
function silverBulletDeploy(state, player, instance) {
  instance.buffs.push({ effectDamageReduction: 3 });
}

// --- Freedom Gundam ST09-004 ---
// <Blocker> (data). While a friendly Base is in play, this Unit gains <Suppression>. Re-evaluated
// at the start of every turn (a turn-granularity approximation of an otherwise fully dynamic
// board-state check, matching how <During Pair> keyword grants are already handled elsewhere).
function freedomGundamStartOfTurn(state, player, instance) {
  instance.grantedKeywords.suppression = !!player.base;
}

// --- Striker Pack ST04-012 (Command) ---
// [Burst] If you have no (Earth Alliance) Unit tokens in play, deploy 1 [Aile Strike Gundam]
// ((Earth Alliance)AP3HP3Blocker) Unit token. [Main] If you have no (Earth Alliance) Unit tokens in
// play, deploy 1 [Sword Strike Gundam] (AP4HP2Blocker) or 1 [Launcher Strike Gundam] (AP2HP4Blocker)
// Unit token.
const AILE_STRIKE_TOKEN = Object.freeze({
  number: 'TOKEN-AILE-STRIKE', name: 'Aile Strike Gundam', type: 'unit', color: 'white',
  traits: ['Earth Alliance'], ap: 3, hp: 3, isToken: true, keywords: { blocker: true }
});
const SWORD_STRIKE_TOKEN = Object.freeze({
  number: 'TOKEN-SWORD-STRIKE', name: 'Sword Strike Gundam', type: 'unit', color: 'white',
  traits: ['Earth Alliance'], ap: 4, hp: 2, isToken: true, keywords: { blocker: true }
});
const LAUNCHER_STRIKE_TOKEN = Object.freeze({
  number: 'TOKEN-LAUNCHER-STRIKE', name: 'Launcher Strike Gundam', type: 'unit', color: 'white',
  traits: ['Earth Alliance'], ap: 2, hp: 4, isToken: true, keywords: { blocker: true }
});
function hasEarthAllianceToken(player) {
  return player.battleArea.some((u) => u.def.isToken && (u.def.traits || []).includes('Earth Alliance'));
}
function strikerPackBurst(state, player) {
  if (hasEarthAllianceToken(player)) return;
  deployUnit(state, player, AILE_STRIKE_TOKEN);
}
function strikerPackCommand(state, player, instance, context) {
  if (hasEarthAllianceToken(player)) return;
  const choice = context.hooks && context.hooks.chooseToken
    ? context.hooks.chooseToken([SWORD_STRIKE_TOKEN, LAUNCHER_STRIKE_TOKEN])
    : SWORD_STRIKE_TOKEN;
  deployUnit(state, player, choice);
}

// --- Archangel ST04-015 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (both shared with
// simpleBurstBase/simpleBaseDeployAddShield). [Activate*Main][Once per Turn] 2: Choose 1 friendly
// Unit with <Blocker>. Set it as active. It can't attack during this turn. (Engine-correct, but
// not wired into the AI's runActivations -- spending 2 resources to untap a Blocker mid-turn needs
// real judgement about the board state, same reasoning as V2 Gundam's setActive ability above.)
function archangelActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.setActive) return false;
  const activeMatching = player.resourceArea.filter((r) => !r.rested);
  if (activeMatching.length < 2) return false;
  const target = context.target;
  if (!target || !getKeywords(target).blocker) return false;
  activeMatching[0].rested = true;
  activeMatching[1].rested = true;
  setActiveByEffect(state, player, target);
  target.buffs.push({ cannotAttack: true, scope: 'turn' });
  instance.activationsUsed.setActive = true;
  return true;
}

// --- Gundam NT-1 GD03-001 ---
// <Repair 2> (data). [When Paired] Choose 1 rested enemy Unit. Deal 1 damage to it. When this
// effect destroys an enemy Unit, draw 1.
function gundamNT1WhenPaired(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 1);
  if (getRemainingHP(target) <= 0 && !isImmuneToEffectDestroy(target)) {
    destroyAndFireEffect(state, opponent, target);
    drawCard(state, player);
  }
}

// --- Penelope (Flight Form) GD04-002 ---
// [Static] During your turn, all your (Earth Federation) Units get AP+1 (same turn-refreshed
// pattern as Gundam ST01-001's During-Pair aura above, trait-filtered instead of paired-gated).
// [Deploy] During this turn, when one of your (Earth Federation) Units destroys an enemy Unit with
// battle damage, choose 1 enemy Unit with 5 or less HP and rest it. The grant lives as a turn-scoped
// buff on Penelope's own instance (a "team trait" trigger, `teamOnKillRestEnemy: <trait>`) rather
// than being stamped onto every current Unit, so it still covers Units deployed later the same turn
// -- combat.js's fireDestroysEnemy checks for it generically.
function penelopeFlightFormStartOfTurn(state, player, instance) {
  if (state.players[state.activePlayerIdx] !== player) return;
  for (const u of player.battleArea) {
    if ((u.def.traits || []).includes('Earth Federation')) u.buffs.push({ ap: 1, scope: 'turn' });
  }
}
function penelopeFlightFormDeploy(state, player, instance) {
  instance.buffs.push({ teamOnKillRestEnemy: 'Earth Federation', scope: 'turn' });
}

// --- Shining Gundam (Super Mode) GD05-068 ---
// If you've activated a (Special Move) Command's Main/Action this turn, this Unit gains
// <Suppression> during this turn -- checked when it attacks, since that's the only point
// Suppression is ever observable, so this reuses the existing specialMoveActivatedThisTurn flag
// rather than building a full broadcast trigger for a single card. [During Link][Attack] AP+2
// during this battle.
function shiningGundamSuperModeAttack(state, player, unit) {
  if (player.specialMoveActivatedThisTurn) unit.buffs.push({ keyword: 'suppression', scope: 'turn' });
  if (unit.isLinkUnit) unit.buffs.push({ ap: 2, scope: 'battle' });
}

// --- Sazabi GD05-049 ---
// <Suppression> (data). [Attack] You may choose 1 of your Units. Destroy it. If you do, your
// opponent chooses 1 of their non-battling Units and destroys it. (Heuristic default: only worth
// it when your weakest spare Unit is a worse loss than the opponent's biggest non-battling threat.)
function sazabiAttack(state, player, unit, context) {
  const ownCandidates = player.battleArea.filter((u) => u !== unit);
  if (ownCandidates.length === 0) return;
  const opponent = opponentOf(state, player);
  const targetInstance = context.target && context.target.type === 'unit' ? context.target.instance : null;
  const enemyCandidates = opponent.battleArea.filter((u) => u !== targetInstance && !isImmuneToEffectDestroy(u));
  if (enemyCandidates.length === 0) return;

  const toSacrifice = [...ownCandidates].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  const enemyTarget = [...enemyCandidates].sort((a, b) => getAP(b) - getAP(a))[0];
  if (getAP(toSacrifice) + getRemainingHP(toSacrifice) >= getAP(enemyTarget) + getRemainingHP(enemyTarget)) return;

  destroyCard(state, player, toSacrifice);
  fireCardEffect(state, player, toSacrifice, 'destroyed', { wasPaired: !!toSacrifice.pilot });
  if ((unit.def.traits || []).includes('Neo Zeon')) player.neoZeonSelfDestroyThisTurn = true; // Axis GD05-129's Activate*Main condition
  destroyCard(state, opponent, enemyTarget);
  fireCardEffect(state, opponent, enemyTarget, 'destroyed', { wasPaired: !!enemyTarget.pilot });
}

// --- Char Aznable GD05-093 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] You may choose 1 (Neo Zeon) Base card from
// your trash. Deploy it.
function charAznableGD05093Burst(state, player, instance) {
  player.hand.push(instance);
}
function charAznableGD05093WhenLinked(state, player, unit, context) {
  const candidates = player.trash.filter((c) => c.def.type === 'base' && (c.def.traits || []).includes('Neo Zeon'));
  if (candidates.length === 0) return;
  const chosen = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  player.trash.splice(player.trash.indexOf(chosen), 1);
  becomeBase(state, player, chosen);
}

// --- Ryusei-Go (Graze Custom II) GD02-058 ---
// [Deploy] Choose 1 of your Units. Deal 1 damage to it. If you do, draw 1. Then, discard 1.
function ryuseiGoDeploy(state, player, instance, context) {
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : [...player.battleArea].sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  if (!target) return;
  dealDamage(target, 1);
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Gundam Barbatos Lupus GD03-050 ---
// [Activate*Main] Choose 3 (Tekkadan)/(Teiwaz) Unit cards from your trash. Exile them. If you do,
// choose 1 enemy Unit. Deal 2 damage to it. (Not once-per-turn per the card's own text, but not
// wired into the AI's runActivations -- permanently exiling 3 trash Units is a real cost that needs
// judgement, same reasoning as V2 Gundam/Gundam Barbatos Lupus-style abilities above.)
function gundamBarbatosLupusActivateMain(state, player, instance, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && ((c.def.traits || []).includes('Tekkadan') || (c.def.traits || []).includes('Teiwaz'))
  );
  if (candidates.length < 3) return false;
  const opponent = opponentOf(state, player);
  const target = context.target || (opponent.battleArea.length
    ? [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0]
    : null);
  if (!target) return false;
  for (const c of candidates.slice(0, 3)) {
    player.trash.splice(player.trash.indexOf(c), 1);
    player.removal.push(c);
  }
  dealDamage(target, 2);
  return true;
}

// --- Kshatriya GD01-044 ---
// [When Paired] (Cyber-Newtype)/(Newtype) Pilot: Choose 1 to 2 enemy Units. Deal 1 damage to them.
function kshatriyaWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  const traits = pilot ? pilot.def.traits || [] : [];
  if (!traits.includes('Cyber-Newtype') && !traits.includes('Newtype')) return;
  const opponent = opponentOf(state, player);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b)).slice(0, 2);
  for (const t of targets) dealDamage(t, 1);
}

// --- Unicorn Gundam 02 Banshee (Destroy Mode) GD01-003 ---
// Link Condition [Christina Mackenzie]/[Amuro Ray]. [During Link][Attack] Choose 12 cards from your
// trash. Return them to your deck and shuffle it. If you do, set this Unit as active. It gains
// <First Strike> during this turn.
function unicornBansheeDestroyModeAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  if (player.trash.length < 12) return;
  const chosen = context.hooks && context.hooks.chooseCards
    ? context.hooks.chooseCards(player.trash, 12)
    : player.trash.slice(0, 12);
  for (const c of chosen) {
    player.trash.splice(player.trash.indexOf(c), 1);
    player.deck.push(c);
  }
  shuffle(player.deck);
  unit.rested = false;
  unit.buffs.push({ keyword: 'firstStrike', scope: 'turn' });
}

// --- Marida Cruz GD01-093 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Attack] Choose 1 enemy Unit whose Lv. is equal
// to or lower than this Unit's Lv. Deal 1 damage to it.
function maridaCruzBurst(state, player, instance) {
  player.hand.push(instance);
}
function maridaCruzAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const opponent = opponentOf(state, player);
  const level = unit.def.level || 0;
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= level);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 1);
}

// --- Close Combat ST03-013 (Command) ---
// [Burst] Activate this card's Main. [Main/Action] Choose 1 enemy Unit. Deal 2 damage to it.
function closeCombatCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 2);
}
function closeCombatBurst(state, player, instance, context) {
  closeCombatCommand(state, player, instance, context);
}

// --- Wing Gundam ST02-001 ---
// <Breach 5> (data). This Unit may choose an active enemy Unit that is Lv.4 or lower as its attack
// target (see `activeTargetLevelCap` in its card data, read by the AI's `chooseAttackTarget`
// instead of a dedicated effect function -- there's no separate "declare attack" hook to attach to).

// --- Wing Gundam (Bird Mode) ST02-002 ---
// [Deploy] Place 1 EX Resource (same one-liner as Nu Gundam GD05-020's Deploy, just unconditional).
function wingGundamBirdModeDeploy(state, player) {
  player.resourceArea.push(createInstance(EX_RESOURCE_DEF, player.id));
}

// --- Wing Gundam Zero GD01-024 ---
// <High-Maneuver> (data). [Deploy] Deal 3 damage to all Units that are Lv.5 or lower (both players').
function wingGundamZeroGD01024Deploy(state, player) {
  for (const p of [player, opponentOf(state, player)]) {
    for (const u of p.battleArea) {
      if ((u.def.level || 0) <= 5) dealDamage(u, 3);
    }
  }
}

// --- Wing Gundam Zero (EW) GD05-067 ---
// While a rested enemy Unit is in play, this Unit gains <Suppression> (re-evaluated each start of
// turn, the same turn-granularity approximation as Freedom Gundam ST09-004's Base-gated version).
// [Attack] Choose 1 enemy Unit. Rest it.
function wingGundamZeroEWStartOfTurn(state, player, instance) {
  const opponent = opponentOf(state, player);
  instance.grantedKeywords.suppression = opponent.battleArea.some((u) => u.rested);
}
function wingGundamZeroEWAttack(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Heero Yuy GD05-098 (Pilot) ---
// [Burst] Add this card to your hand. [When this Unit destroys an enemy shield area card with
// damage, choose 1 enemy Unit. It gets AP-2 during this turn.]
function heeroYuy098Burst(state, player, instance) {
  player.hand.push(instance);
}
function heeroYuy098DestroysShield(state, player, unit) {
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Heero Yuy ST02-010 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] This Unit gets AP+1 and HP+1 (see
// `duringLinkAp`/`duringLinkHp` on its card data -- getAP/getHP already read those off a Pilot,
// same fields a Unit's own card data can carry).
function heeroYuy010Burst(state, player, instance) {
  player.hand.push(instance);
}

// --- Naval Bombardment GD01-120 (Command) ---
// [Burst] Choose 1 enemy Unit. It gets AP-3 during this turn. [Action] Choose 1 friendly Unit with
// <Blocker>. It gets AP+3 during this turn. (Two genuinely different abilities on one card, unlike
// the usual "Burst just activates Main" shorthand used elsewhere.)
function navalBombardmentBurst(state, player) {
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -3, scope: 'turn' });
}
function navalBombardmentCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => getKeywords(u).blocker);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: 3, scope: 'turn' });
}

// --- Peacemillion GD03-125 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Once per Turn] During your turn, when a friendly (Operation Meteor)/(G Team) Unit that is Lv.6
// or higher destroys an enemy Unit with battle damage, that friendly Unit may recover 2 HP. (Reacts
// to ANY qualifying friendly Unit's kill, not just its own -- combat.js's fireDestroysEnemy
// broadcasts a `friendlyUnitDestroysEnemy` event to the attacking player's whole field for exactly
// this kind of Base-wide reactive text.)
function peacemillionBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function peacemillionDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
}
function peacemillionFriendlyUnitDestroysEnemy(state, player, instance, context) {
  if (instance.activationsUsed.recoverOnKill) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  const attacker = context.attacker;
  const traits = attacker.def.traits || [];
  if ((attacker.def.level || 0) < 6) return;
  if (!traits.includes('Operation Meteor') && !traits.includes('G Team')) return;
  recoverHP(attacker, 2);
  instance.activationsUsed.recoverOnKill = true;
}

// --- Kindhearted GD04-101 (Command) ---
// [Burst] Activate this card's Main. [Main/Action] During this turn, friendly Units can't be
// destroyed by enemy effects. Then, draw 1. (New `effectDestroyImmune` turn-buff, checked at the
// handful of spots where an effect destroys an opponent's Unit outright: Widespread Annihilation's
// board wipe, Gundam NT-1's When-Paired kill, and Sazabi's Attack sacrifice.)
function kindheartedCommand(state, player) {
  for (const u of player.battleArea) u.buffs.push({ effectDestroyImmune: true, scope: 'turn' });
  drawCard(state, player);
}
function kindheartedBurst(state, player) {
  kindheartedCommand(state, player);
}

// --- M1 Astray Shrike GD05-015 ---
// [Deploy] Choose 1 rested enemy Unit. Deal 1 damage to it.
function m1AstrayShrikeDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 1);
}

// --- Isaribi ST05-015 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Activate*Main] Rest this Base: Choose 1 of your damaged Units. It gets AP+2 during this turn.
function isaribiBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function isaribiDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
}
function isaribiActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const damaged = player.battleArea.filter((u) => u.damage > 0);
  if (damaged.length === 0) return false;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(damaged)
    : damaged.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  instance.rested = true;
  target.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Haow Gundam GD05-036 ---
// Link Condition [Master Asia]. [When Paired] You may choose 1 of your other active (MF) Units.
// Rest it. If you do, deal 2 damage to all enemy Units whose Lv. is equal to or lower than that
// Unit's Lv.
function haowGundamWhenPaired(state, player, unit, context) {
  const candidates = player.battleArea.filter((u) => u !== unit && !u.rested && (u.def.traits || []).includes('MF'));
  if (candidates.length === 0) return;
  const chosen = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!chosen) return;
  chosen.rested = true;
  const level = chosen.def.level || 0;
  const opponent = opponentOf(state, player);
  for (const u of opponent.battleArea) {
    if ((u.def.level || 0) <= level) dealDamage(u, 2);
  }
}

// --- White Base ST01-015 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Activate*Main][Once per Turn] 2: Deploy 1 [Gundam] Unit token if you have no Units in play,
// deploy 1 [Guncannon] token if you have only 1 Unit in play, or deploy 1 [Guntank] token if you
// have 2 or more (all (White Base Team)). Engine-correct but not wired into the AI's
// runActivations -- spending 2 real resources needs judgement the heuristic doesn't have yet,
// same reasoning as Archangel/V2 Gundam's Activate*Main abilities above.
const WHITE_BASE_GUNDAM_TOKEN = Object.freeze({
  number: 'TOKEN-WB-GUNDAM', name: 'Gundam', type: 'unit', color: 'blue',
  traits: ['White Base Team'], ap: 3, hp: 3, isToken: true
});
const WHITE_BASE_GUNCANNON_TOKEN = Object.freeze({
  number: 'TOKEN-WB-GUNCANNON', name: 'Guncannon', type: 'unit', color: 'blue',
  traits: ['White Base Team'], ap: 2, hp: 2, isToken: true
});
const WHITE_BASE_GUNTANK_TOKEN = Object.freeze({
  number: 'TOKEN-WB-GUNTANK', name: 'Guntank', type: 'unit', color: 'blue',
  traits: ['White Base Team'], ap: 1, hp: 1, isToken: true
});
function whiteBaseActivateMain(state, player, instance) {
  if (instance.activationsUsed.deployToken) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 2) return false;
  activeResources[0].rested = true;
  activeResources[1].rested = true;
  instance.activationsUsed.deployToken = true;
  const unitCount = player.battleArea.length;
  const token = unitCount === 0 ? WHITE_BASE_GUNDAM_TOKEN : unitCount === 1 ? WHITE_BASE_GUNCANNON_TOKEN : WHITE_BASE_GUNTANK_TOKEN;
  deployUnit(state, player, token);
  return true;
}

// --- Battle of Aces GD01-111 (Command) ---
// [Burst] Choose 1 enemy Unit. Deal 2 damage to it. [Main/Action] Choose 1 damaged enemy Unit.
// Deal 3 damage to it.
function battleOfAcesBurst(state, player) {
  const target = opponentOf(state, player).battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 2);
}
function battleOfAcesCommand(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.damage > 0);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 3);
}

// --- Improved Technique GD03-109 (Command) ---
// [Burst] Activate this card's Main. [Main/Action] Choose 1 enemy Unit that is Lv.4 or lower. Deal
// 3 damage to it. If there are 2 or more cards with "Improved Technique" in their card name in your
// trash, choose 1 enemy Unit instead (no level restriction).
function improvedTechniqueCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const copiesInTrash = player.trash.filter((c) => (c.def.name || '').includes('Improved Technique')).length;
  const candidates = copiesInTrash >= 2
    ? opponent.battleArea
    : opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 3);
}
function improvedTechniqueBurst(state, player) {
  improvedTechniqueCommand(state, player, null, {});
}

// --- Rewloola ST03-015 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 enemy Unit
// with 5 or less AP. Deal 1 damage to it.
function rewloolaDeploy(state, player, instance, context) {
  simpleBaseDeployAddShield(state, player);
  const candidates = opponentOf(state, player).battleArea.filter((u) => getAP(u) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 1);
}

// --- Axis GD05-129 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Activate*Main] Rest this Base: If one of your Units has been destroyed by one of your (Neo
// Zeon) card's effects during this turn, deploy 1 (Neo Zeon) Unit card that is Lv.3 or lower from
// your hand. Gated on the new `player.neoZeonSelfDestroyThisTurn` flag (reset each start phase,
// same convention as the pre-existing `specialMoveActivatedThisTurn`), set wherever a friendly Neo
// Zeon card's own effect destroys a friendly Unit -- currently just Sazabi's Attack sacrifice, the
// only such interaction that exists in the DB so far.
function axisActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  if (!player.neoZeonSelfDestroyThisTurn) return false;
  const candidates = player.hand.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Neo Zeon') && (c.def.level || 0) <= 3
  );
  const choice = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  if (!choice) return false;
  instance.rested = true;
  player.hand.splice(player.hand.indexOf(choice), 1);
  deployUnit(state, player, choice.def);
  return true;
}

// --- Waldfeld's Murasame GD05-003 ---
// Link Condition [Andrew Waldfeld]. [Destroyed] If you have an (Orb) Pilot in play, draw 1.
function waldfeldsMurasameDestroyed(state, player) {
  const hasOrbPilot = player.battleArea.some((u) => u.pilot && (u.pilot.def.traits || []).includes('Orb'));
  if (hasOrbPilot) drawCard(state, player);
}

// --- Hashmal GD05-006 ---
// [Once per Turn] During your turn, when this Unit destroys an enemy card with battle damage,
// deploy 1 [Pluma] ((Calamity War) AP2/HP1) Unit token. This Unit gains the same number of
// <Repair 1> as the number of (Calamity War) Unit tokens in play (implemented as a `repair` buff,
// a one-line generalization to `applyRepairAtEndOfTurn` mirroring the existing ap/hp buff pattern).
const PLUMA_TOKEN = Object.freeze({
  number: 'TOKEN-PLUMA', name: 'Pluma', type: 'unit', color: 'blue', traits: ['Calamity War'], ap: 2, hp: 1, isToken: true
});
function hashmalDestroysEnemy(state, player, instance) {
  if (!instance.activationsUsed.deployPluma) {
    deployUnit(state, player, PLUMA_TOKEN);
    instance.activationsUsed.deployPluma = true;
  }
  const tokenCount = player.battleArea.filter((u) => u.def.isToken && (u.def.traits || []).includes('Calamity War')).length;
  instance.buffs = instance.buffs.filter((b) => !b.hashmalRepair);
  instance.buffs.push({ repair: tokenCount, hashmalRepair: true });
}

// --- Andrew Waldfeld GD05-082 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] This Unit gains <Repair 2> (data field
// `duringLinkRepair`, read by `applyRepairAtEndOfTurn` -- mirrors the pilot-side
// duringLinkAp/duringLinkHp pattern from Heero Yuy ST02-010).
function andrewWaldfeldBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Rouei GD03-067 ---
// [Deploy] You may choose 1 of your Units. Deal 1 damage to it. It gets AP+1 during this turn.
function roueiDeploy(state, player, instance, context) {
  if (player.battleArea.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : [...player.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  dealDamage(target, 1);
  target.buffs.push({ ap: 1, scope: 'turn' });
}

// --- Gundam Flauros (Ryusei-Go) GD05-060 ---
// [Deploy][Attack] Choose 1 enemy Unit that is Lv.2 or lower. Destroy it.
function gundamFlaurosRyuseiGoDestroy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Akihiro Altland ST05-011 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] During your turn, when this Unit destroys an
// enemy Unit with battle damage, choose 1 (Tekkadan) Unit card that is Lv.2 or lower from your
// trash. Add it to your hand.
function akihiroAltlandDestroysEnemy(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Tekkadan') && (c.def.level || 0) <= 2
  );
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}

// --- Shenlong Gundam GD01-029 ---
// <Breach 4> (data). [Attack] Choose 1 enemy Unit with <Blocker> that is Lv.3 or lower. Destroy it.
function shenlongGundamAttack(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter(
    (u) => getKeywords(u).blocker && (u.def.level || 0) <= 3 && !isImmuneToEffectDestroy(u)
  );
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Altron Gundam GD03-018 ---
// <Breach 5> (data). [Attack] Choose 1 enemy Unit with <Blocker>. Deal 5 damage to it.
function altronGundamAttack(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getKeywords(u).blocker);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 5);
}

// --- Riddhe Marcenas GD04-098 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] When this Unit receives effect damage from an
// enemy, reduce it by 2 (new pilot-side `duringLinkEffectDamageReduction` field, checked directly
// in `dealDamage` alongside the existing permanent `effectDamageReduction` buff category).
function riddheMarcenasBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Unicorn Gundam 02 Banshee Norn (Destroy Mode) GD04-065 ---
// Link Condition [Riddhe Marcenas]. [During Link][Activate*Main] Exile 3 blue cards from your
// trash: set this Unit as active. It can't choose the enemy player as its attack target during
// this turn. Engine-correct but not wired into the AI's runActivations -- spending a real trash
// cost needs judgement the heuristic doesn't have, same reasoning as Archangel/White Base above.
// [Attack] All enemy Units get AP-1 during this turn.
function unicornBansheeNormActivateMain(state, player, instance) {
  if (!instance.isLinkUnit || !instance.rested) return false;
  const blueCards = player.trash.filter((c) => c.def.color === 'blue').slice(0, 3);
  if (blueCards.length < 3) return false;
  for (const c of blueCards) player.trash.splice(player.trash.indexOf(c), 1);
  instance.rested = false;
  instance.buffs.push({ cannotAttackPlayer: true, scope: 'turn' });
  return true;
}
function unicornBansheeNormAttack(state, player) {
  for (const u of opponentOf(state, player).battleArea) u.buffs.push({ ap: -1, scope: 'turn' });
}

// --- Presidential Office GD05-130 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Destroyed] You may exile this card from your trash. If you do, deploy 1 Base card with
// "Presidential Office" in its card name from your hand.
function presidentialOfficeDestroyed(state, player, instance) {
  const idx = player.trash.indexOf(instance);
  if (idx === -1) return;
  const replacement = player.hand.find(
    (c) => c.def.type === 'base' && (c.def.name || '').includes('Presidential Office')
  );
  if (!replacement) return;
  player.trash.splice(idx, 1);
  player.hand.splice(player.hand.indexOf(replacement), 1);
  deployBase(state, player, replacement.def);
}

// --- Argama GD02-129 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. This Base can't receive
// enemy effect damage (a permanent, un-scoped `effectDamageReduction: Infinity` buff -- same
// mechanism as Silver Bullet's Reduce 3, just uncapped).
function argamaDeploy(state, player, instance) {
  simpleBaseDeployAddShield(state, player);
  instance.buffs.push({ effectDamageReduction: Infinity });
}

// --- Hoka Kyoten Juzetsujin GD05-112 (Command, Special Move; pairable from trash as a Pilot) ---
// [Main] Choose 1 of your (MF) Units without <Breach>. It gains <Breach 3> during this turn.
function hokaKyotenJuzetsujinCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter(
    (u) => (u.def.traits || []).includes('MF') && !getKeywords(u).breach
  );
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates[0];
  if (target) target.buffs.push({ breach: 3, scope: 'turn' });
}

// --- Graviton Hammer GD05-122 (Command, Special Move; pairable from trash as a Pilot) ---
// [Main] Choose 1 enemy Unit that is Lv.4 or lower. Rest it.
function gravitonHammerCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Dragon Gundam GD05-035 ---
// Link Condition [Sai Saici]. [Once per Turn] When this Unit destroys an enemy shield-area card
// with damage, choose 1 enemy Unit with 3 or less AP. Deal 2 damage to it.
function dragonGundamDestroysShield(state, player, instance, context) {
  if (instance.activationsUsed.dragonShieldTrigger) return;
  instance.activationsUsed.dragonShieldTrigger = true;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 2);
}

// --- Aegis Gundam ST04-006 ---
// [Attack] If this Unit has 5 or more AP, choose 1 enemy Unit that is Lv.5 or higher. Deal 3 damage to it.
function aegisGundamAttack(state, player, instance, context) {
  if (getAP(instance) < 5) return;
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) >= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 3);
}

// --- GFreD GD03-035 ---
// [Activate*Main][Once per Turn] 1, exile 1 Pilot card from your trash: Deal 1 damage to all enemy
// Units. (Engine-correct, not wired into runActivations -- exiling a specific trashed Pilot is a
// real resource cost needing judgement, same reasoning as Archangel/V2 Gundam above.)
// [When Linked] During this turn, this Unit may choose an active enemy Unit with AP equal to or
// less than this Unit as its attack target.
function gfredActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.trashDamage) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  const pilotCard = context.exilePilot;
  if (!pilotCard || pilotCard.def.type !== 'pilot' || !player.trash.includes(pilotCard)) return false;
  activeResources[0].rested = true;
  player.trash.splice(player.trash.indexOf(pilotCard), 1);
  for (const u of opponentOf(state, player).battleArea) dealDamage(u, 1);
  instance.activationsUsed.trashDamage = true;
  return true;
}
function gfredWhenLinked(state, player, unit) {
  unit.buffs.push({ activeTargetAPCap: true, scope: 'turn' });
}

// --- Justice Gundam GD01-066 ---
// [Deploy] Deploy 1 [Fatum-00] ((Triple Ship Alliance)*AP2*HP2*<Blocker>) Unit token.
// [During Pair][Attack] Choose 1 of your (Triple Ship Alliance) Unit tokens; it may attack on the
// turn it is deployed.
const FATUM00_TOKEN = Object.freeze({
  number: 'TOKEN-FATUM00', name: 'Fatum-00', type: 'unit', color: 'white',
  traits: ['Triple Ship Alliance'], ap: 2, hp: 2, isToken: true, keywords: { blocker: true }
});
function justiceGundamDeploy(state, player) {
  deployUnit(state, player, FATUM00_TOKEN);
}
function justiceGundamAttack(state, player, instance, context) {
  if (!instance.pilot) return;
  const candidates = player.battleArea.filter(
    (u) => u.def.isToken && (u.def.traits || []).includes('Triple Ship Alliance') && u.turnDeployed === state.turnNumber
  );
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (target) target.buffs.push({ canAttackOnDeployTurn: true, scope: 'turn' });
}

// --- GQuuuuuuX (Omega Psycommu) GD03-034 ---
// <Suppression> (data). [Deploy] Choose 1 enemy Unit. Deal 3 damage to it.
function gquuuuuuxOmegaPsycommuDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 3);
}

// --- Athrun Zala ST04-011 ---
// [Burst] Add this card to your hand. [When Linked] During this turn, this Unit may choose an
// active enemy Unit that is Lv.5 or lower as its attack target.
function athrunZalaST04011Burst(state, player, instance) {
  player.hand.push(instance);
}
function athrunZalaST04011WhenLinked(state, player, unit) {
  unit.buffs.push({ activeTargetLevelCap: 5, scope: 'turn' });
}

// --- Nyaan GD03-092 ---
// [Burst] Add this card to your hand. [When Linked] Place the top card of your deck into your
// trash. If you placed a (Zeon)/(Clan) card with this effect, choose 1 enemy Unit. Deal 1 damage to it.
function nyaanBurst(state, player, instance) {
  player.hand.push(instance);
}
function nyaanWhenLinked(state, player, unit, context) {
  if (player.deck.length === 0) return;
  const milled = player.deck.shift();
  player.trash.push(milled);
  const traits = milled.def.traits || [];
  if (!traits.includes('Zeon') && !traits.includes('Clan')) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 1);
}

// --- Chang Wufei GD01-091 ---
// [Burst] Add this card to your hand.
function changWufeiBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Hy-Gogg GD03-024 ---
// [When Linked] If you have another (Cyclops Team) Unit in play, deploy 1 rested [Hy-Gogg]
// ((Cyclops Team)*AP2*HP1) Unit token.
const HYGOGG_TOKEN = Object.freeze({
  number: 'TOKEN-HYGOGG', name: 'Hy-Gogg', type: 'unit', color: 'green',
  traits: ['Cyclops Team'], ap: 2, hp: 1, isToken: true
});
function hyGoggWhenLinked(state, player, unit) {
  const hasOtherCyclops = player.battleArea.some((u) => u !== unit && (u.def.traits || []).includes('Cyclops Team'));
  if (!hasOtherCyclops) return;
  const token = deployUnit(state, player, HYGOGG_TOKEN);
  token.rested = true;
}

// --- Kämpfer GD03-017 ---
// [Burst] Choose 1 (Cyclops Team) Pilot card from your trash. Add it to your hand.
// [When Paired]*(Cyclops Team) Pilot] All your (Cyclops Team) Units may choose an active enemy
// Unit with 5 or less AP as their attack target during this turn.
function kampferBurst(state, player, instance, context) {
  const candidates = player.trash.filter((c) => c.def.type === 'pilot' && (c.def.traits || []).includes('Cyclops Team'));
  const target = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  if (!target) return;
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}
function kampferWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('Cyclops Team')) return;
  for (const u of player.battleArea) {
    if ((u.def.traits || []).includes('Cyclops Team')) u.buffs.push({ activeTargetAPThreshold: 5, scope: 'turn' });
  }
}

// --- Mikhail Kaminsky GD03-090 ---
// [Burst] Add this card to your hand. [Attack] Choose 1 of your (Cyclops Team) Units. It gains
// <Breach 1> during this turn.
function mikhailKaminskyBurst(state, player, instance) {
  player.hand.push(instance);
}
function mikhailKaminskyAttack(state, player, unit, context) {
  const candidates = player.battleArea.filter(
    (u) => (u.def.traits || []).includes('Cyclops Team') && !getKeywords(u).breach
  );
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (target) target.buffs.push({ breach: 1, scope: 'turn' });
}

// --- Tokwan GD04-088 ---
// [Burst] Add this card to your hand. (Static: "when this Unit is blocked by an enemy Unit that is
// Lv.4 or lower, it can't receive battle damage during this battle" lives on the card def as
// blockedByLowLevelImmuneCap, read directly by combat.js's isImmuneToBlockerReturnDamage.)
function tokwanBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Impulse Gundam ST09-001 ---
// [Activate*Main] 2, return this Unit to the bottom of its owner's deck: choose 1 Unit card with
// "Impulse Gundam" in its card name that is Lv.4 or higher from your trash. Deploy it. (Engine-
// correct, not wired into runActivations -- trading this Unit away for a specific bigger trash
// card needs real judgement, same reasoning as Archangel/V2 Gundam above.)
function impulseGundamActivateMain(state, player, instance, context) {
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 2) return false;
  const target = context.target;
  const valid = target && player.trash.includes(target) && (target.def.name || '').includes('Impulse Gundam')
    && (target.def.level || 0) >= 4;
  if (!valid) return false;
  activeResources[0].rested = true;
  activeResources[1].rested = true;
  // 3-3-6: a paired Pilot follows this Unit to the deck rather than being silently dropped.
  removeFromField(player, instance, player.deck);
  sendToZone(player.deck, instance);
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
  return true;
}

// --- Sword Impulse Gundam ST09-006 ---
// [Deploy] If you deploy this Unit from your trash, choose 1 enemy Unit that is Lv.3 or lower.
// Destroy it.
function swordImpulseGundamDeploy(state, player, instance, context) {
  if (!context.fromTrash) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Force Impulse Gundam ST09-002 ---
// [Destroyed] Choose 1 (Minerva Squad) Unit card without "Force Impulse Gundam" in its card name
// from your trash. Add it to your hand.
function forceImpulseGundamDestroyed(state, player, instance, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Minerva Squad')
      && !(c.def.name || '').includes('Force Impulse Gundam')
  );
  const target = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  if (!target) return;
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}

// --- Destiny Gundam GD04-050 ---
// <High-Maneuver> (data). [During Pair][Attack] You may choose 1 (Minerva Squad) Unit card from
// your trash. Pay its cost to deploy it.
function destinyGundamGD04050Attack(state, player, instance, context) {
  if (!instance.pilot) return;
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Minerva Squad') && canAfford(player, c.def, { fromTrash: true })
  );
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  payCost(player, target.def, { fromTrash: true });
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
}

// --- Destiny Gundam GD05-055 ---
// <First Strike> (data). (Static: "Once per Turn, when this Unit receives enemy battle damage,
// reduce it by 2" lives on the card def as oncePerTurnBattleDamageReduction, read directly by
// management.js's dealDamage.)

// --- Shinn Asuka ST09-008 ---
// [Burst] Add this card to your hand. [Attack] If this is a (Minerva Squad) Unit, choose 1 of your
// Resources. Set it as active.
function shinnAsukaST09008Burst(state, player, instance) {
  player.hand.push(instance);
}
function shinnAsukaST09008Attack(state, player, unit) {
  if (!(unit.def.traits || []).includes('Minerva Squad')) return;
  const restedResource = player.resourceArea.find((r) => r.rested);
  if (restedResource) restedResource.rested = false;
}

// --- Zeheart Galette GD03-094 ---
// [Burst] Add this card to your hand. [When Paired] Place the top 2 cards of your deck into your
// trash. If you placed a (Vagan) card with this effect, choose 1 enemy Unit. It gets AP-2 during
// this turn.
function zeheartGaletteBurst(state, player, instance) {
  player.hand.push(instance);
}
function zeheartGaletteWhenPaired(state, player, unit, context) {
  const milled = player.deck.splice(0, 2);
  for (const c of milled) player.trash.push(c);
  if (!milled.some((c) => (c.def.traits || []).includes('Vagan'))) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Awakened Power GD02-110 (Command) ---
// [Main] Choose 1 Unit card that is Lv.5 or lower from your trash. Pay its cost to deploy it.
function awakenedPowerCommand(state, player, instance, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.level || 0) <= 5 && canAfford(player, c.def, { fromTrash: true })
  );
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  payCost(player, target.def, { fromTrash: true });
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
}

// --- Minerva ST09-010 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn,
// look at the top 2 cards of your deck and return 1 to the top. Place the remaining card into your
// trash. (Heuristic: keep a Unit/Base on top for the immediate board play, same as Kayra's Re-GZ.)
function minervaBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function minervaDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  const isOwnTurn = state.players[state.activePlayerIdx] === player;
  if (!isOwnTurn || player.deck.length === 0) return;
  const top2 = player.deck.splice(0, 2);
  const keepIdx = top2.findIndex((c) => c.def.type === 'unit' || c.def.type === 'base');
  const keep = top2.splice(keepIdx === -1 ? 0 : keepIdx, 1)[0];
  player.deck.unshift(keep);
  for (const c of top2) player.trash.push(c);
}

// --- Gundam Exia ST07-001 ---
// [When Paired] Place the top 2 cards of your deck into your trash. If you place a (CB) card with
// this effect, draw 1. [End of turn] If there are 7+ (CB) cards in your trash, untap 1 of your
// Resources.
function gundamExiaST07001WhenPaired(state, player) {
  const milled = player.deck.splice(0, 2);
  for (const c of milled) player.trash.push(c);
  if (milled.some((c) => (c.def.traits || []).includes('CB'))) drawCard(state, player);
}
function gundamExiaST07001EndOfTurn(state, player) {
  if (state.players[state.activePlayerIdx] !== player) return;
  const cbInTrash = player.trash.filter((c) => (c.def.traits || []).includes('CB')).length;
  if (cbInTrash < 7) return;
  const rested = player.resourceArea.find((r) => r.rested);
  if (rested) rested.rested = false;
}

// --- Gundam Virtue ST07-004 ---
// While you have a (CB) Pilot in play, this Unit gains <Blocker> -- re-evaluated each start of
// turn like the other conditional-keyword grants above (freedomGundamStartOfTurn etc).
function gundamVirtueStartOfTurn(state, player, instance) {
  instance.grantedKeywords.blocker = player.battleArea.some(
    (u) => u.pilot && (u.pilot.def.traits || []).includes('CB')
  );
}

// --- Setsuna F. Seiei ST07-009 (Pilot) ---
// [Burst] Add this card to your hand. [Attack] This Unit gets AP+1 during this turn. If there are
// 7+ (CB) cards in your trash, all your (CB) Units get AP+1 instead.
function setsunaFSeieiST07009Burst(state, player, instance) {
  player.hand.push(instance);
}
function setsunaFSeieiST07009Attack(state, player, unit) {
  const cbInTrash = player.trash.filter((c) => (c.def.traits || []).includes('CB')).length;
  if (cbInTrash >= 7) {
    for (const u of player.battleArea) {
      if ((u.def.traits || []).includes('CB')) u.buffs.push({ ap: 1, scope: 'turn' });
    }
  } else {
    unit.buffs.push({ ap: 1, scope: 'turn' });
  }
}

// --- Gundam Exia (Trans-Am) GD03-049 ---
// <Suppression> (data). [When this Unit destroys an enemy shield-area card with battle damage] If
// there are 10+ (CB) cards in your trash, choose 1 enemy Unit with the lowest HP. Destroy it.
function gundamExiaTransAmDestroysShield(state, player, unit, context) {
  const cbInTrash = player.trash.filter((c) => (c.def.traits || []).includes('CB')).length;
  if (cbInTrash < 10) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  destroyCard(state, opponent, target);
  fireCardEffect(state, opponent, target, 'destroyed', {});
}

// --- Gundam Kyrios GD04-034 ---
// <First Strike> (data). [During Link] This Unit gets AP+2 for each of your rested (CB) Units --
// computed at the Attack step (the only point this Unit's own AP actually matters), since getAP
// has no access to the owner's battle area to recompute it live.
function gundamKyriosAttack(state, player, unit) {
  if (!unit.isLinkUnit) return;
  const restedCB = player.battleArea.filter((u) => u.rested && (u.def.traits || []).includes('CB')).length;
  if (restedCB > 0) unit.buffs.push({ ap: restedCB * 2, scope: 'battle' });
}

// --- Nena Trinity GD04-089 (Pilot) ---
// [Burst] Add this card to your hand. [Activate*Main] <Support 2> (Rest this Unit: 1 other
// friendly Unit gets AP+2 during this turn) -- the generic Support keyword (rules/effects.js
// activateSupport) is Unit-sided; this is a fixed amount granted by a Pilot instead, so it's
// simpler to inline than to force the paired Unit's def.keywords.support to read 2.
function nenaTrinityBurst(state, player, instance) {
  player.hand.push(instance);
}
function nenaTrinityActivateMain(state, player, unit, context) {
  const target = context.target;
  if (!target || target === unit || unit.rested) return false;
  unit.rested = true;
  target.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Hallelujah Haptism GD04-090 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Once per Turn] During your turn, when this
// Unit destroys an enemy Unit with battle damage, look at the top card of your deck. If it's a
// (CB) card, you may reveal it and add it to your hand. Return any remaining card to the bottom
// of your deck.
function hallelujahHaptismBurst(state, player, instance) {
  player.hand.push(instance);
}
function hallelujahHaptismDestroysEnemy(state, player, unit) {
  if (state.players[state.activePlayerIdx] !== player) return;
  if (unit.activationsUsed.hallelujahDeckPeek) return;
  unit.activationsUsed.hallelujahDeckPeek = true;
  const top = player.deck.shift();
  if (!top) return;
  if ((top.def.traits || []).includes('CB')) player.hand.push(top);
  else player.deck.push(top);
}

// --- Overwhelming Pressure GD04-109 (Command) ---
// [Main/Action] Choose 1 enemy Unit that is Lv.6 or lower. Deal 4 damage to it.
function overwhelmingPressureCommand(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) <= 6);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 4);
}

// --- Gundam Throne Eins (GN High Mega Launcher) GD05-038 ---
// [During Link] This Unit gains <Suppression> -- isLinkUnit only ever flips false to true (never
// back), and that transition is exactly when [When Linked] fires (actions.js pairPilot), so a
// one-time grant there covers the rest of the instance's lifetime with no per-turn recheck needed.
// [Activate*Main][Once per Turn] Rest 3 of your (CB) Units: choose 1 enemy Unit, deal 4 damage to
// it. Requires judgement on which 3 Units to tap and which enemy to hit, so (like GFreD/Impulse
// Gundam before it) this is engine-correct and tested directly but not wired into the AI's
// runActivations whitelist.
function gundamThroneEinsWhenLinked(state, player, unit) {
  unit.grantedKeywords.suppression = true;
}
function gundamThroneEinsActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.throneEinsBarrage) return false;
  const candidates = player.battleArea.filter((u) => !u.rested && (u.def.traits || []).includes('CB'));
  if (candidates.length < 3) return false;
  const target = context.target;
  if (!target) return false;
  instance.activationsUsed.throneEinsBarrage = true;
  const toRest = context.toRest || candidates.slice(0, 3);
  for (const u of toRest) u.rested = true;
  dealDamage(target, 4);
  return true;
}

// --- GQuuuuuuX (Omega Psycommu) ST06-001 ---
// [When Linked] If another friendly (Clan) Unit is in play, this gains <First Strike> during this turn.
function gquuuuuuxST06001WhenLinked(state, player, unit) {
  const hasOtherClan = player.battleArea.some((u) => u !== unit && (u.def.traits || []).includes('Clan'));
  if (hasOtherClan) unit.buffs.push({ keyword: 'firstStrike', scope: 'turn' });
}

// --- GQuuuuuuX (Omega Psycommu) ST06-002 ---
// [Deploy] If another friendly (Clan) Unit is in play, choose 1 enemy Unit. Deal 1 damage to it.
function gquuuuuuxST06002Deploy(state, player, unit, context) {
  const hasOtherClan = player.battleArea.some((u) => u !== unit && (u.def.traits || []).includes('Clan'));
  if (!hasOtherClan) return;
  const candidates = opponentOf(state, player).battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 1);
}

// --- Red Gundam ST06-005 ---
// <Breach 1> (data). [Attack] Choose 1 to 2 friendly (Clan) Units. They get AP+2 during this turn
// (Graceful Demeanor GD04-117's "choose 1 to 2" default-slice pattern, reused directly).
function redGundamST06005Attack(state, player, unit, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Clan'));
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const t of targets) t.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Ortega's Rick Dom (GQ) ST06-007 ---
// [Deploy] Choose 1 of your other (Clan) Units. During this turn, it may choose an active enemy
// Unit with 3 or less AP as its attack target -- reuses the existing `activeTargetAPThreshold`
// buff family from chooseAttackTarget (Kämpfer GD03-017 precedent), just granted to a chosen
// Unit instead of the whole team.
function ortegasRickDomDeploy(state, player, unit, context) {
  const candidates = player.battleArea.filter((u) => u !== unit && (u.def.traits || []).includes('Clan'));
  const target = context.target || (context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0]);
  if (!target) return;
  target.buffs.push({ activeTargetAPThreshold: 3, scope: 'turn' });
}

// --- Amate Yuzuriha (Machu) ST06-009 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] Look at the top card of your deck. If it's a
// (Clan) card, you may reveal it and add it to your hand. Return any remaining card to the bottom
// of your deck.
function amateYuzurihaMachuBurst(state, player, instance) {
  player.hand.push(instance);
}
function amateYuzurihaMachuWhenLinked(state, player) {
  const top = player.deck.shift();
  if (!top) return;
  if ((top.def.traits || []).includes('Clan')) player.hand.push(top);
  else player.deck.push(top);
}

// --- Shuji Itō ST06-010 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Attack] If you have a (Clan) Unit in play,
// look at the top card of your deck. Return it to the top or bottom of your deck (a pure scry --
// keep (Clan) cards on top, send anything else to the bottom, since there's no other selection
// criterion in the printed text).
function shujiItoBurst(state, player, instance) {
  player.hand.push(instance);
}
function shujiItoAttack(state, player, unit) {
  if (!unit.isLinkUnit) return;
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('Clan'))) return;
  if (player.deck.length === 0) return;
  const top = player.deck.shift();
  if ((top.def.traits || []).includes('Clan')) player.deck.unshift(top);
  else player.deck.push(top);
}

// --- Schoolgirl and Smuggler ST06-012 (Command) ---
// [Main] Look at the top 3 cards of your deck. You may reveal 1 (Clan) Unit/Pilot card among them
// and add it to your hand. Return the remaining cards randomly to the bottom of your deck (Gundam
// Maxter GD05-069's dig-and-shuffle-back pattern, reused directly).
function schoolgirlAndSmugglerCommand(state, player) {
  const top3 = player.deck.splice(0, 3);
  const idx = top3.findIndex((c) => (c.def.type === 'unit' || c.def.type === 'pilot') && (c.def.traits || []).includes('Clan'));
  if (idx !== -1) {
    const [chosen] = top3.splice(idx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// --- GQuuuuuuX (Omega Psycommu) GD02-038 ---
// [Deploy] Look at the top 3 cards of your deck. You may deploy 1 (Clan) Unit card that is Lv.4 or
// lower among them. Return the remaining cards randomly to the bottom of your deck.
function gquuuuuuxGD02038Deploy(state, player) {
  const top3 = player.deck.splice(0, 3);
  const idx = top3.findIndex((c) => c.def.type === 'unit' && (c.def.traits || []).includes('Clan') && (c.def.level || 0) <= 4);
  if (idx !== -1) {
    const [chosen] = top3.splice(idx, 1);
    deployUnit(state, player, chosen.def);
  }
  player.deck.push(...shuffle(top3));
}

// --- Shuji's Hideout GD02-126 ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to hand. [Destroyed] Choose 1 enemy
// Unit that is Lv.4 or lower. Deal 1 damage to it.
function shujisHideoutDestroyed(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 1);
}

// --- Red Gundam GD03-039 ---
// [Deploy] Choose 1 other active friendly (Clan) Unit. Rest it. If you do, choose 1 enemy Unit
// with 2 or less AP. Deal 2 damage to it.
function redGundamGD03039Deploy(state, player, unit, context) {
  const candidates = player.battleArea.filter((u) => u !== unit && !u.rested && (u.def.traits || []).includes('Clan'));
  const cost = context.restUnit || candidates.sort((a, b) => getAP(a) - getAP(b))[0];
  if (!cost) return;
  cost.rested = true;
  const enemyCandidates = opponentOf(state, player).battleArea.filter((u) => getAP(u) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(enemyCandidates)
    : enemyCandidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 2);
}

// --- Gundam GD01-001 (RX-78-2) ---
// <teamRepairAura> (data, see effects.js). [When Paired] If you have 2 or more other Units in
// play, draw 1.
function gundamGD01001WhenPaired(state, player) {
  if (player.battleArea.length >= 3) drawCard(state, player);
}

// --- Unicorn Gundam (Destroy Mode) GD01-002 ---
// [Attack] Choose 1 enemy Unit. Rest it. (Its "destroy a Link Unicorn-Mode Unit to play this for
// 0 Lv./cost" evolve-play clause lives in actions.js/heuristic.js as `evolveCondition` --
// see `findEvolveTarget`/`deployByEvolve`.)
function unicornGundamDestroyModeAttack(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.rested = true;
}

// --- Guncannon GD01-004 ---
// <Repair 1> (data). [When Paired] Choose 1 enemy Unit with 2 or less HP. Rest it.
function guncannonGD01004WhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.rested = true;
}

// --- Unicorn Gundam (Unicorn Mode) GD01-005 ---
// [During Link][Destroyed] Return this Unit's paired Pilot to its owner's hand. Then, discard 1.
// (Heuristic default discard: the highest-cost card in hand, matching every other "discard 1"
// site's convention.)
function unicornGundamUnicornModeDestroyed(state, player, unit, context) {
  if (!unit.isLinkUnit || !context.pilot) return;
  const idx = player.trash.indexOf(context.pilot);
  if (idx !== -1) player.trash.splice(idx, 1);
  sendToZone(player.hand, context.pilot);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Noin's Aries GD01-007 ---
// [Destroyed] If you have another (OZ) Unit in play, draw 1.
function noinsAriesDestroyed(state, player) {
  if (player.battleArea.some((u) => (u.def.traits || []).includes('OZ'))) drawCard(state, player);
}

// --- G-Fighter GD01-009 ---
// [Deploy] Choose 1 of your (White Base Team) Units. It gains <High-Maneuver> during this turn.
function gFighterDeploy(state, player, unit, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('White Base Team'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Unicorn Gundam 02 Banshee (Unicorn Mode) GD01-010 ---
// [When Paired] Choose 1 enemy Unit with 3 or less HP. Rest it.
function unicornBansheeGD01010WhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.rested = true;
}

// --- Zechs' Leo GD01-012 ---
// [When Paired] Choose 1 enemy Unit with 3 or less HP. Rest it.
function zechsLeoWhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.rested = true;
}

// --- G-Sky Easy GD01-014 ---
// [During Link][Activate·Action][Once per Turn] Choose 1 Unit: it recovers 1 HP. (Engine-correct,
// not wired into the AI -- Activate·Action abilities aren't modeled by runActivations at all yet,
// same known simplification flagged for every other reactive Action-step ability.)
function gSkyEasyActivateAction(state, player, instance, context) {
  if (!instance.isLinkUnit) return false;
  if (instance.activationsUsed.recoverHp) return false;
  const target = context.target;
  if (!target) return false;
  recoverHP(target, 1);
  instance.activationsUsed.recoverHp = true;
  return true;
}

// --- Ball GD01-015 ---
// [Attack] Choose 1 of your Units. It recovers 1 HP.
function ballGD01015Attack(state, player, unit, context) {
  const damageTaken = (u) => (u.def.hp || 0) - getRemainingHP(u);
  const candidates = player.battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => damageTaken(b) - damageTaken(a))[0];
  if (!target) return;
  recoverHP(target, 1);
}

// --- Byarlant Custom GD01-019 ---
// While 4 or more enemy Units are in play, this Unit gains <Blocker> (re-evaluated each start of
// turn, matching the Gundam Virtue ST07-004 precedent for this style of conditional grant).
function byarlantCustomStartOfTurn(state, player, instance) {
  instance.grantedKeywords.blocker = opponentOf(state, player).battleArea.length >= 4;
}

// --- Char's Gelgoog GD01-023 ---
// [Activate·Main] Discard 1 (Zeon)/(Neo Zeon) Unit card. If a Pilot is not paired with this Unit,
// choose 1 (Newtype) Pilot card that is Lv.3 or lower from your trash. Pair it with this Unit.
// (Not AI-wired -- a judgment call on when the trade is worth it, same precedent as G-Sky Easy's
// Activate·Action; engine-correct and directly testable.)
function charsGelgoogActivateMain(state, player, instance, context) {
  const discardCandidates = player.hand.filter(
    (c) => c.def.type === 'unit' && ((c.def.traits || []).includes('Zeon') || (c.def.traits || []).includes('Neo Zeon'))
  );
  if (discardCandidates.length === 0) return false;
  const toDiscard = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(discardCandidates)
    : [...discardCandidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  discardFromHand(player, toDiscard);

  if (!instance.pilot) {
    const pilotCandidates = player.trash.filter(
      (c) => c.def.type === 'pilot' && (c.def.traits || []).includes('Newtype') && (c.def.level || 0) <= 3
    );
    const chosenPilot = context.hooks && context.hooks.chooseCard
      ? context.hooks.chooseCard(pilotCandidates)
      : pilotCandidates[0];
    if (chosenPilot) pairPilotFromTrash(state, player, instance, chosenPilot);
  }
  return true;
}

// --- Gundam Deathscythe GD01-025 ---
// [When Paired(Operation Meteor) Pilot] Place 1 rested Resource. Then, this Unit gains <First
// Strike> during this turn.
function gundamDeathscytheGD01025WhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('Operation Meteor')) return;
  if (player.resourceDeck.length) {
    const resource = player.resourceDeck.shift();
    resource.rested = true;
    player.resourceArea.push(resource);
  }
  unit.buffs.push({ keyword: 'firstStrike', scope: 'turn' });
}

// --- Big Zam GD01-027 ---
// <Breach 4> (data). [Deploy] If there are 10 or more (Zeon)/(Neo Zeon) Unit cards in your trash,
// deal 4 damage to all Units with <Blocker>. (Literal text carries no "enemy" qualifier, unlike
// every other targeted-damage card in this batch, so it hits Blocker Units on both sides.)
function bigZamGD01027Deploy(state, player) {
  const zeonInTrash = player.trash.filter(
    (c) => c.def.type === 'unit' && ((c.def.traits || []).includes('Zeon') || (c.def.traits || []).includes('Neo Zeon'))
  ).length;
  if (zeonInTrash < 10) return;
  const opponent = opponentOf(state, player);
  for (const u of [...player.battleArea, ...opponent.battleArea]) {
    if (getKeywords(u).blocker) {
      const owner = player.battleArea.includes(u) ? player : opponent;
      dealDamage(u, 4);
      destroyAndFireEffect(state, owner, u);
    }
  }
}

// --- Gundam Sandrock GD01-028 ---
// [Deploy] You may deploy 1 (Maganac Corps) Unit card from your hand.
function gundamSandrockDeploy(state, player, instance, context) {
  const candidates = player.hand.filter((c) => c.def.type === 'unit' && (c.def.traits || []).includes('Maganac Corps'));
  if (candidates.length === 0) return;
  const chosen = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : [...candidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.hand.splice(player.hand.indexOf(chosen), 1);
  deployUnit(state, player, chosen.def);
}

// --- Gyan GD01-032 ---
// [When Paired(Zeon) Pilot] Choose 1 enemy Unit with <Blocker> that is Lv.2 or lower. Destroy it.
function gyanGD01032WhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('Zeon')) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getKeywords(u).blocker && (u.def.level || 0) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyAndFireEffect(state, opponent, target);
}

// --- Adzam GD01-038 ---
// [Deploy] If 5 or more enemy Units are in play, deal 1 damage to all enemy Units.
function adzamGD01038Deploy(state, player) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length < 5) return;
  for (const u of [...opponent.battleArea]) {
    dealDamage(u, 1);
    destroyAndFireEffect(state, opponent, u);
  }
}

// --- Rasid's Maganac GD01-043 ---
// [Deploy] Choose 1 of your green Units. During this turn, it may choose an active enemy Unit with
// 4 or less AP as its attack target.
function rasidsManagacGD01043Deploy(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.def.color === 'green');
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ activeTargetAPThreshold: 4, scope: 'turn' });
}

// --- Duel Gundam GD01-045 ---
// [When Paired] Look at the top 3 cards of your deck. You may deploy 1 (ZAFT) Unit card that is
// Lv.4 or lower among them. Return the remaining cards randomly to the bottom of your deck.
function duelGundamGD01045WhenPaired(state, player, unit, context) {
  const top3 = player.deck.splice(0, 3);
  const candidates = top3.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('ZAFT') && (c.def.level || 0) <= 4
  );
  const chosen = candidates.length
    ? context.hooks && context.hooks.chooseCard
      ? context.hooks.chooseCard(candidates)
      : [...candidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0]
    : null;
  if (chosen) {
    top3.splice(top3.indexOf(chosen), 1);
    deployUnit(state, player, chosen.def);
  }
  player.deck.push(...shuffle(top3));
}

// --- Shamblo GD01-047 ---
// [Attack] If 2 or more other rested friendly Units are in play, choose 1 enemy Unit. Deal 3
// damage to it.
function shambloGD01047Attack(state, player, unit) {
  const otherRested = player.battleArea.filter((u) => u !== unit && u.rested).length;
  if (otherRested < 2) return;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 3);
  destroyAndFireEffect(state, opponent, target);
}

// --- Zaku I Sniper Type GD01-048 ---
// <Support 1> (data). [Deploy] Look at the top card of your deck. If it is a (Zeon)/(Neo Zeon)
// Unit card, you may reveal it and add it to your hand. Return any remaining card to the bottom
// of your deck.
function zakuISniperGD01048Deploy(state, player) {
  if (player.deck.length === 0) return;
  const top = player.deck.shift();
  const isZeonUnit = top.def.type === 'unit' && ((top.def.traits || []).includes('Zeon') || (top.def.traits || []).includes('Neo Zeon'));
  if (isZeonUnit) player.hand.push(top);
  else player.deck.push(top);
}

// --- Blitz Gundam GD01-049 ---
// [Deploy] Choose 1 of your (ZAFT) Units with 5 or more AP. It gains <First Strike> during this
// turn.
function blitzGundamGD01049Deploy(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('ZAFT') && getAP(u) >= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ keyword: 'firstStrike', scope: 'turn' });
}

// --- LaGOWE GD01-050 ---
// [Attack] If this Unit has 5 or more AP and it is attacking an enemy Unit, choose 1 enemy Unit.
// Deal 2 damage to it.
function lagoweGD01050Attack(state, player, unit, context) {
  if (getAP(unit) < 5) return;
  if (!context.target || context.target.type !== 'unit') return;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 2);
  destroyAndFireEffect(state, opponent, target);
}

// --- Geara Zulu GD01-052 ---
// [Deploy] Choose 1 enemy Unit. Deal 1 damage to it.
function gearaZuluGD01052Deploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 1);
  destroyAndFireEffect(state, opponent, target);
}

// --- Geara Doga GD01-053 ---
// [Activate·Main][Once per Turn](1) Choose 1 enemy Unit with 2 or less AP. Deal 1 damage to it.
function gearaDogaGD01053ActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.pingLowAP) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return false;
  activeResources[0].rested = true;
  instance.activationsUsed.pingLowAP = true;
  dealDamage(target, 1);
  destroyAndFireEffect(state, opponent, target);
  return true;
}

// --- Geara Doga GD01-056 ---
// [Destroyed] Choose 1 enemy Unit with 5 or less AP. Deal 1 damage to it.
function gearaDogaGD01056Destroyed(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 1);
  destroyAndFireEffect(state, opponent, target);
}

// --- Galluss-K GD01-058 ---
// [Activate·Action][Once per Turn](1) Choose 1 Unit that is Lv.4 or higher. It gets AP+1 during
// this battle. (Not AI-wired -- same Activate·Action precedent as G-Sky Easy: engine-correct and
// directly testable, but a reactive Action-step ability the AI doesn't model yet.)
function gallussKGD01058ActivateAction(state, player, instance, context) {
  if (instance.activationsUsed.buffLvFour) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  const target = context.target;
  if (!target || (target.def.level || 0) < 4) return false;
  activeResources[0].rested = true;
  instance.activationsUsed.buffLvFour = true;
  target.buffs.push({ ap: 1, scope: 'battle' });
  return true;
}

// --- Zee Zulu GD01-059 ---
// [Attack] If you are attacking the enemy player, this Unit gets AP+2 during this battle.
function zeeZuluGD01059Attack(state, player, unit, context) {
  if (context.target && context.target.type === 'player') unit.buffs.push({ ap: 2, scope: 'battle' });
}

// --- ZnO GD01-063 ---
// During your turn, while this Unit is battling an enemy Unit that is Lv.2 or lower, it gains
// <First Strike>. (Only matters when this Unit is the attacker, since a Blocker activates during
// the opponent's turn, not "your turn" for its own controller -- modeled via the Attack trigger
// against the declared target, scoped to just this battle.)
function znoGD01063Attack(state, player, unit, context) {
  if (context.target && context.target.type === 'unit' && (context.target.instance.def.level || 0) <= 2) {
    unit.buffs.push({ keyword: 'firstStrike', scope: 'battle' });
  }
}

// --- Freedom Gundam GD01-065 ---
// <Blocker> (data). [During Pair][Once per Turn] When you pair a Pilot with this Unit or one of
// your white Units, choose 1 enemy Unit. It gets AP-2 during this turn.
function freedomGundamGD01065AllyPaired(state, player, instance, context) {
  if (!instance.pilot) return;
  if (instance.activationsUsed.apDebuff) return;
  const { pairedUnit } = context;
  if (pairedUnit !== instance && pairedUnit.def.color !== 'white') return;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  instance.activationsUsed.apDebuff = true;
  target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Gundam Aerial Rebuild GD01-067 ---
// [When Paired] Choose 1 Command card that is Lv.5 or lower from your trash. Add it to your hand.
function gundamAerialRebuildWhenPaired(state, player) {
  const candidates = player.trash.filter((c) => c.def.type === 'command' && (c.def.level || 0) <= 5);
  if (candidates.length === 0) return;
  const chosen = [...candidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);
}

// --- Perfect Strike Gundam GD01-068 / Darilbalde GD01-075 ---
// <Blocker> (data, GD01-068 only). [Deploy] Choose 1 enemy Unit with 1 HP. Return it to its
// owner's hand.
function perfectStrikeGundamDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) === 1);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Strike Rouge GD01-069 ---
// [Activate·Main][Once per Turn](1) Choose 1 of your rested white Units with <Blocker>. Set it as
// active. It can't attack during this turn.
function strikeRougeActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.unrestBlocker) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  const candidates = player.battleArea.filter((u) => u.rested && u.def.color === 'white' && getKeywords(u).blocker);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return false;
  activeResources[0].rested = true;
  instance.activationsUsed.unrestBlocker = true;
  setActiveByEffect(state, player, target);
  target.buffs.push({ cannotAttack: true, scope: 'turn' });
  return true;
}

// --- Gundam Pharact GD01-071 ---
// [During Link][Attack] Choose 1 enemy Unit. It gets AP-2 during this battle.
function gundamPharactAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: -2, scope: 'battle' });
}

// --- Chuchu's Demi Trainer GD01-074 ---
// [Attack] Draw 1. Then, discard 1. (Heuristic default discard: the highest-cost card in hand,
// matching every other "discard 1" site's convention.)
function chuchusDemiTrainerAttack(state, player) {
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Michaelis GD01-076 ---
// While there are 4 or more Command cards in your trash, this Unit gets AP+1 and HP+1
// (re-evaluated each start of turn, via the shared grantedStatBonus mechanism).
function michaelisStartOfTurn(state, player, instance) {
  const commandsInTrash = player.trash.filter((c) => c.def.type === 'command').length;
  instance.grantedStatBonus = commandsInTrash >= 4 ? { ap: 1, hp: 1 } : {};
}

// --- Mistral GD01-078 ---
// [Deploy] Choose 1 enemy Unit. It gets AP-1 during this turn.
function mistralDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: -1, scope: 'turn' });
}

// --- Cagalli's Skygrasper GD01-080 ---
// [Destroyed] Choose 1 enemy Unit that is Lv.2 or lower. Return it to its owner's hand.
function cagallisSkygrasperDestroyed(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- M1 Astray GD01-081 ---
// While you have another (Triple Ship Alliance) Unit in play, this Unit gets AP+1 and <Blocker>
// (re-evaluated each start of turn).
function m1AstrayStartOfTurn(state, player, instance) {
  const hasAnotherTripleShip = player.battleArea.some(
    (u) => u !== instance && (u.def.traits || []).includes('Triple Ship Alliance')
  );
  instance.grantedStatBonus = hasAnotherTripleShip ? { ap: 1 } : {};
  instance.grantedKeywords.blocker = hasAnotherTripleShip;
}

// --- Gundam Aerial GD01-082 ---
// [During Pair][Activate·Action][Once per Turn](2) Choose 1 enemy Unit. It gets AP-1 during this
// battle. (Not AI-wired -- Activate·Action precedent, engine-correct and directly testable.)
function gundamAerialGD01082ActivateAction(state, player, instance, context) {
  if (!instance.pilot) return false;
  if (instance.activationsUsed.debuffEnemy) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 2) return false;
  const target = context.target;
  if (!target) return false;
  activeResources[0].rested = true;
  activeResources[1].rested = true;
  instance.activationsUsed.debuffEnemy = true;
  target.buffs.push({ ap: -1, scope: 'battle' });
  return true;
}

// --- Sayla Mass GD01-087 (Pilot) ---
// [Burst] Add this card to your hand. (Its "While this Unit is blue, gains <Repair 1>" clause
// lives in effects.js's applyRepairAtEndOfTurn via duringPairRepairIfColor.)
function saylaMassBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Banagher Links GD01-088 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] Draw 1.
function banagherLinksGD01088Burst(state, player, instance) {
  player.hand.push(instance);
}
function banagherLinksGD01088WhenLinked(state, player) {
  drawCard(state, player);
}

// --- Riddhe Marcenas GD01-089 (Pilot) ---
// [Burst] Add this card to your hand. (Its "While this Unit has <Repair>, gets AP+1" clause lives
// in management.js's getAP via apBonusIfRepair.)
function riddheMarcenasBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Duo Maxwell GD01-090 (Pilot) ---
// [Burst] Add this card to your hand. (Its "During Link, AP can't be reduced by enemy effects"
// clause lives in management.js's getAP via duringLinkApReduceImmune.)
function duoMaxwellGD01090Burst(state, player, instance) {
  player.hand.push(instance);
}

// --- M'Quve GD01-092 (Pilot) ---
// [Burst] Add this card to your hand. (Its "While this Unit is (Zeon), gains <Breach 1>" clause
// lives in management.js's getKeywords via breachIfUnitTrait.)
function mQuveBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Yzak Jule GD01-094 (Pilot) ---
// [Burst] Add this card to your hand. [Once per Turn] When an enemy Link Unit is destroyed with
// damage while this Unit is attacking, draw 1.
function yzakJuleBurst(state, player, instance) {
  player.hand.push(instance);
}
function yzakJuleDestroysEnemy(state, player, unit, context) {
  if (unit.activationsUsed.yzakDraw) return;
  if (!context.defender || !context.defender.isLinkUnit) return;
  unit.activationsUsed.yzakDraw = true;
  drawCard(state, player);
}

// --- Dearka Elthman GD01-095 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] Discard 1. If you do, draw 1.
function dearkaElthmanBurst(state, player, instance) {
  player.hand.push(instance);
}
function dearkaElthmanWhenLinked(state, player) {
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (!toDiscard) return;
  discardFromHand(player, toDiscard);
  drawCard(state, player);
}

// --- Cagalli Yula Athha GD01-096 (Pilot) ---
// [Burst] Add this card to your hand. (Its "While this Unit is white, gains <Blocker>" clause
// lives in management.js's getKeywords via keywordIfUnitColor.)
function cagalliYulaAthhaBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Guel Jeturk GD01-097 (Pilot) ---
// [Burst] Add this card to your hand. [Activate·Main][Once per Turn] If your opponent has 8 or
// more cards in their hand, set this Unit as active. It can't attack during this turn.
function guelJeturkBurst(state, player, instance) {
  player.hand.push(instance);
}
function guelJeturkActivateMain(state, player, unit) {
  if (unit.activationsUsed.guelUnrest) return false;
  const opponent = opponentOf(state, player);
  if (opponent.hand.length < 8) return false;
  unit.activationsUsed.guelUnrest = true;
  unit.rested = false;
  unit.buffs.push({ cannotAttack: true, scope: 'turn' });
  return true;
}

// --- Elan Ceres GD01-098 (Pilot) ---
// [Burst] Add this card to your hand. [Activate·Action][Once per Turn] If an enemy Unit with 1 or
// less AP is in play, this Unit recovers 1 HP. (Not AI-wired -- Activate·Action precedent.)
function elanCeresBurst(state, player, instance) {
  player.hand.push(instance);
}
function elanCeresActivateAction(state, player, unit) {
  if (unit.activationsUsed.elanHeal) return false;
  const opponent = opponentOf(state, player);
  if (!opponent.battleArea.some((u) => getAP(u) <= 1)) return false;
  unit.activationsUsed.elanHeal = true;
  recoverHP(unit, 1);
  return true;
}

// --- Fortress Defense GD01-106's [Zaku] token ---
const ZAKU_TOKEN = Object.freeze({
  number: 'TOKEN-ZAKU',
  name: 'Zaku',
  type: 'unit',
  color: 'green',
  traits: ['Zeon'],
  ap: 1,
  hp: 1,
  isToken: true,
  keywords: {}
});

// --- Intercept Orders GD01-099 (Command) ---
// [Burst] Choose 1 enemy Unit with 5 or less HP. Rest it.
// [Main]/[Action] Choose 1 to 2 enemy Units with 3 or less HP. Rest them.
function interceptOrdersBurst(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.rested = true;
}
function interceptOrdersCommand(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 3);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const t of targets) t.rested = true;
}

// --- Deep Devotion GD01-101 (Command, pilotMode: Lucrezia Noin) ---
// [Main]/[Action] Choose 1 friendly Link Unit. It recovers 3 HP.
function deepDevotionCommand(state, player, instance, context) {
  const damageTaken = (u) => (u.def.hp || 0) - getRemainingHP(u);
  const candidates = player.battleArea.filter((u) => u.isLinkUnit);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => damageTaken(b) - damageTaken(a))[0];
  if (!target) return;
  recoverHP(target, 3);
}

// --- Securing the Supply Line GD01-102 (Command) ---
// [Main] All friendly Units that are Lv.4 or lower recover 2 HP.
function securingTheSupplyLineCommand(state, player) {
  for (const u of player.battleArea) {
    if ((u.def.level || 0) <= 4) recoverHP(u, 2);
  }
}

// --- The Stubborn Cog GD01-103 (Command, pilotMode: Daguza Mackle) ---
// [Main] Choose 1 active friendly (Earth Federation) Unit and 1 active enemy Unit. Rest them.
function theStubbornCogCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const friendlyCandidates = player.battleArea.filter((u) => !u.rested && (u.def.traits || []).includes('Earth Federation'));
  const enemyCandidates = opponent.battleArea.filter((u) => !u.rested);
  const friendlyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(friendlyCandidates)
    : friendlyCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
  const enemyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(enemyCandidates)
    : enemyCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (friendlyTarget) friendlyTarget.rested = true;
  if (enemyTarget) enemyTarget.rested = true;
}

// --- Signs of a Revolution GD01-104 (Command) ---
// [Burst] Draw 1. [Main] Choose 1 rested enemy Unit. Deal 2 damage to it.
function signsOfARevolutionBurst(state, player) {
  drawCard(state, player);
}
function signsOfARevolutionCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 2);
  destroyAndFireEffect(state, opponent, target);
}

// --- Citizens, Take a Stand! GD01-105 (Command) ---
// [Burst] Add this card to your hand. [Main] All your Units get AP+2 during this turn.
function citizensTakeAStandBurst(state, player, instance) {
  player.hand.push(instance);
}
function citizensTakeAStandCommand(state, player) {
  for (const u of player.battleArea) u.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Fortress Defense GD01-106 (Command, pilotMode: Dozle Zabi) ---
// [Main] Deploy 2 [Zaku] ((Zeon) AP1/HP1) Unit tokens.
function fortressDefenseCommand(state, player) {
  deployUnit(state, player, ZAKU_TOKEN);
  deployUnit(state, player, ZAKU_TOKEN);
}

// --- First Contact GD01-107 (Command) ---
// [Burst] Place 1 EX Resource. [Main] Place 1 rested Resource.
function firstContactBurst(state, player) {
  player.resourceArea.push(createInstance(EX_RESOURCE_DEF, player.id));
}
function firstContactCommand(state, player) {
  if (player.resourceDeck.length === 0) return;
  const resource = player.resourceDeck.shift();
  resource.rested = true;
  player.resourceArea.push(resource);
}

// --- Strategic Arms GD01-108 (Command) ---
// [Main] Deal 2 damage to all Units with <Blocker>. (No "enemy" qualifier in the real text, same
// as Big Zam GD01-027 -- hits Blocker Units on both sides.)
function strategicArmsCommand(state, player) {
  const opponent = opponentOf(state, player);
  for (const u of [...player.battleArea, ...opponent.battleArea]) {
    if (getKeywords(u).blocker) {
      const owner = player.battleArea.includes(u) ? player : opponent;
      dealDamage(u, 2);
      destroyAndFireEffect(state, owner, u);
    }
  }
}

// --- The Path to Victory or Defeat GD01-109 (Command) ---
// [Main] Look at the top 5 cards of your deck. You may reveal 1 (Operation Meteor)/(G Team) Unit
// card/Pilot card among them and add it to your hand. Return the remaining cards randomly to the
// bottom of your deck.
function thePathToVictoryOrDefeatCommand(state, player, instance, context) {
  const top5 = player.deck.splice(0, 5);
  const candidates = top5.filter(
    (c) => (c.def.type === 'unit' || c.def.type === 'pilot') &&
      ((c.def.traits || []).includes('Operation Meteor') || (c.def.traits || []).includes('G Team'))
  );
  const chosen = candidates.length
    ? context.hooks && context.hooks.chooseCard
      ? context.hooks.chooseCard(candidates)
      : [...candidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0]
    : null;
  if (chosen) {
    top5.splice(top5.indexOf(chosen), 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top5));
}

// --- Rasid's Orders GD01-110 (Command, pilotMode: Rasid Kurama) ---
// [Main]/[Action] Choose 1 Unit that is Lv.4 or higher. During this turn, it may choose an active
// enemy Unit with 6 or less AP as its attack target.
function rasidsOrdersCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.level || 0) >= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ activeTargetAPThreshold: 6, scope: 'turn' });
}

// --- Extreme Hatred GD01-112 (Command, pilotMode: Loni Garvey) ---
// [Main] Choose 2 of your active Units. Rest them. If you do, choose 1 enemy Unit. Deal 3 damage
// to it.
function extremeHatredCommand(state, player, instance, context) {
  const activeUnits = player.battleArea.filter((u) => !u.rested);
  if (activeUnits.length < 2) return;
  const toRest = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(activeUnits)
    : activeUnits.sort((a, b) => getAP(a) - getAP(b)).slice(0, 2);
  if (toRest.length < 2) return;
  for (const u of toRest) u.rested = true;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 3);
  destroyAndFireEffect(state, opponent, target);
}

// --- The Desert Tiger GD01-113 (Command, pilotMode: Andrew Waldfeld) ---
// [Main]/[Action] Choose 1 friendly (ZAFT) Unit. It gets AP+3 during this turn.
function theDesertTigerCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('ZAFT'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ ap: 3, scope: 'turn' });
}

// --- Assault on Torrington Base GD01-114 (Command, pilotMode: Yonem Kirks) ---
// [Action] Choose 2 friendly Units. They get AP+1 during this turn.
function assaultOnTorringtonBaseCommand(state, player, instance, context) {
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(player.battleArea)
    : [...player.battleArea].sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const u of targets) u.buffs.push({ ap: 1, scope: 'turn' });
}

// --- Zeon Remnant Forces GD01-115 (Command) ---
// [Main]/[Action] Choose 1 enemy Unit. Deal 1 damage to it.
function zeonRemnantForcesCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 1);
  destroyAndFireEffect(state, opponent, target);
}

// --- Stealth Stratagem GD01-116 (Command, pilotMode: Nicol Amarfi) ---
// [Main]/[Action] Choose 1 enemy Unit with 2 or less AP. Deal 2 damage to it.
function stealthStratagemCommand(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getAP(u) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 2);
  destroyAndFireEffect(state, opponentOf(state, player), target);
}

// --- The Witch and the Bride GD01-117 (Command) ---
// [Burst] Activate this card's [Main]. [Main]/[Action] Choose 1 enemy Unit with 5 or less HP.
// Return it to its owner's hand.
function theWitchAndTheBrideBurst(state, player, instance, context) {
  instance.def.effects.command(state, player, instance, context);
}
function theWitchAndTheBrideCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Iron-Fisted Discipline GD01-119 (Command, pilotMode: Chuatury Panlunch) ---
// [Main]/[Action] Choose 1 enemy Unit that is Lv.4 or lower. It gets AP-2 during this turn.
function ironFistedDisciplineCommand(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Midair Modifications GD01-121 (Command) ---
// [Burst] Activate this card's [Main]. [Main] Choose 1 rested Unit with <Blocker>. Set it as
// active. It can't attack during this turn. (Scraped text drops the "your"/"friendly" qualifier --
// unresting an enemy Blocker would be actively harmful to yourself, so this reads it as "your own",
// the same intent as Strike Rouge GD01-069's near-identical ability.)
function midairModificationsBurst(state, player, instance, context) {
  instance.def.effects.command(state, player, instance, context);
}
function midairModificationsCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.rested && getKeywords(u).blocker);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  setActiveByEffect(state, player, target);
  target.buffs.push({ cannotAttack: true, scope: 'turn' });
}

// --- Covert Operative GD01-122 (Command, pilotMode: Shaddiq Zenelli) ---
// [Main] Choose 1 enemy Unit with 2 or less HP. Return it to its owner's hand. If you have a Link
// Unit in play, choose 1 enemy Unit with 4 or less HP instead.
function covertOperativeCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const hasLinkUnit = player.battleArea.some((u) => u.isLinkUnit);
  const threshold = hasLinkUnit ? 4 : 2;
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= threshold);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Nahel Argama GD01-123 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 enemy Unit
// with 3 or less HP. Rest it.
function nahelArgamaDeploy(state, player, instance, context) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Side 7 GD01-124 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Activate·Main] Rest this
// Base: choose 1 friendly Unit. It recovers 1 HP.
function side7ActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const damageTaken = (u) => (u.def.hp || 0) - getRemainingHP(u);
  const candidates = player.battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => damageTaken(b) - damageTaken(a))[0];
  if (!target) return false;
  instance.rested = true;
  recoverHP(target, 1);
  return true;
}

// --- Zanzibar GD01-125 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn,
// you may deploy 1 (Zeon) Unit card that is Lv.4 or lower from your hand.
function zanzibarDeploy(state, player, instance, context) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  if (state.players[state.activePlayerIdx] !== player) return;
  const candidates = player.hand.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Zeon') && (c.def.level || 0) <= 4
  );
  if (candidates.length === 0) return;
  const chosen = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : [...candidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.hand.splice(player.hand.indexOf(chosen), 1);
  deployUnit(state, player, chosen.def);
}

// --- Gamow GD01-127 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Activate·Action] Rest
// this Base: choose 1 friendly (ZAFT) Unit with 5 or more AP. It gains <Breach 3> during this
// battle. (Not AI-wired -- Activate·Action precedent.)
function gamowActivateAction(state, player, instance, context) {
  if (instance.rested) return false;
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('ZAFT') && getAP(u) >= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return false;
  instance.rested = true;
  target.buffs.push({ breach: 3, scope: 'battle' });
  return true;
}

// --- Kusanagi GD01-129 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 enemy Unit
// with 3 or less HP. Return it to its owner's hand.
function kusanagiDeploy(state, player, instance, context) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- 13th Tactical Testing Sector GD01-130 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Activate·Main] Rest this
// Base: if a friendly (Academy) Unit is in play, choose 1 enemy Unit. It gets AP-1 during this turn.
function thirteenthTacticalTestingSectorActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('Academy'))) return false;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return false;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  instance.rested = true;
  target.buffs.push({ ap: -1, scope: 'turn' });
  return true;
}

// === GD02 batch 1 (GD02-001 through GD02-015) =============================

// --- Psycho Gundam (LR+) GD02-001 ---
// <Breach 3> (data). [During Pair: (Cyber-Newtype) Pilot] When one of your (Titans) Units destroys
// an enemy shield area card with damage, this Unit recovers 2 HP.
function psychoGundamLRFriendlyUnitDestroysShield(state, player, instance, context) {
  if (!instance.pilot || !(instance.pilot.def.traits || []).includes('Cyber-Newtype')) return;
  if (!(context.attacker.def.traits || []).includes('Titans')) return;
  recoverHP(instance, 2);
}

// --- Gundam Epyon (LR+) GD02-002 ---
// [During Link][Once per Turn] During your turn, when one of your Units destroys an enemy Unit
// with battle damage, set this Unit as active.
function gundamEpyonLRFriendlyUnitDestroysEnemy(state, player, instance) {
  if (!instance.isLinkUnit) return;
  if (instance.activationsUsed.setActiveOnAllyKill) return;
  instance.activationsUsed.setActiveOnAllyKill = true;
  instance.rested = false;
}

// --- Gundam Mk-II (Titans) (R+) GD02-003 ---
// [During Pair: Lv.3 or Lower Pilot][Destroyed] You may discard 1 Unit card. If you do, return the
// card paired with this Unit to your hand.
function gundamMk2TitansGD02003Destroyed(state, player, instance, context) {
  if (!context.wasPaired || (context.pilot.def.level || 0) > 3) return;
  const candidates = player.hand.filter((c) => c.def.type === 'unit').sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0));
  const discard = candidates[0];
  if (!discard) return;
  player.hand.splice(player.hand.indexOf(discard), 1);
  player.trash.push(discard);
  const trashIdx = player.trash.indexOf(context.pilot);
  if (trashIdx !== -1) player.trash.splice(trashIdx, 1);
  player.hand.push(context.pilot);
}

// --- Byarlant GD02-004 ---
// [When Paired] Choose 1 rested enemy Unit with 3 or less HP. It won't be set as active during the
// start phase of your opponent's next turn. (Heuristic default: the highest-AP eligible candidate.)
function byarlantGD02004WhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.rested && getRemainingHP(u) <= 3);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.skipNextUntap = true;
}

// --- Tallgeese (R+) GD02-005 ---
// [During Link][Attack] Choose 1 enemy Unit with 2 or less HP. Rest it. (Heuristic default: prefers
// an active candidate, since resting an already-rested Unit accomplishes nothing.)
function tallgeeseGD02005Attack(state, player, instance) {
  if (!instance.isLinkUnit) return;
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 2);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => (a.rested === b.rested ? getAP(b) - getAP(a) : a.rested ? 1 : -1))[0];
  target.rested = true;
}

// --- Gabthley GD02-008 ---
// [When Linked] Choose 1 rested enemy Unit. Deal 1 damage to it. (Heuristic default: the
// lowest-remaining-HP candidate, matching Guntank GD01-008's convention.)
function gabthleyGD02008WhenLinked(state, player, unit) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealEffectDamage(state, player, opponent, target, 1);
  destroyAndFireEffect(state, opponent, target);
}

// --- Calamity Gundam GD02-009 ---
// [Once per Turn] When this Unit's AP is reduced by an enemy effect, choose 1 rested enemy Unit.
// Deal 2 damage to it. (Heuristic default: the lowest-remaining-HP candidate.)
function calamityGundamApReducedByEnemy(state, player, instance) {
  if (instance.activationsUsed.pingOnApReduce) return;
  instance.activationsUsed.pingOnApReduce = true;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealEffectDamage(state, player, opponent, target, 2);
  destroyAndFireEffect(state, opponent, target);
}

// --- Raider Gundam GD02-010 ---
// [Once per Turn] When this Unit receives enemy effect damage, draw 1.
function raiderGundamReceivesEnemyEffectDamage(state, player, instance) {
  if (instance.activationsUsed.drawOnEffectDamage) return;
  instance.activationsUsed.drawOnEffectDamage = true;
  drawCard(state, player);
}

// --- Moebius (Peacemaker Team) GD02-011 ---
// [Activate: Action] Destroy this Unit: Choose 1 enemy Base/enemy Shield this Unit is battling.
// Deal 6 damage to it. (Not wired into the AI's mid-battle action-step hook -- see Gamow
// GD01-127/other Activate abilities for the same "function exists, AI doesn't invoke it yet"
// precedent. context.target is whatever this Unit is currently battling (8-4); applyBreach's own
// Base-then-Shield priority already matches "choose 1 enemy Base/enemy Shield" (13-1-2).)
function moebiusPeacemakerActivateAction(state, player, instance, context) {
  if (!context.target || context.target.type !== 'player') return false;
  destroyCard(state, player, instance);
  applyBreach(state, opponentOf(state, player), 6, context.hooks || {});
  return true;
}

// --- Galbaldy Beta GD02-014 ---
// [Deploy] Choose 1 of your (Titans) Units. It gets AP+1 during this turn. (Heuristic default: the
// highest-AP eligible candidate, to buff the biggest threat.)
function galbaldyBetaDeploy(state, player, instance) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Titans'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: 1, scope: 'turn' });
}

// === GD02 batch 2 (GD02-016 through GD02-030) ===

// --- Elmeth (LR+) GD02-020 ---
// [Deploy] Look at the top 5 cards of your deck. You may reveal 1 green (Zeon) Pilot card among
// them and add it to your hand. Return the remaining cards randomly to the bottom of your deck.
// (thePathToVictoryOrDefeatCommand GD01-109's dig-and-shuffle-back pattern, reused directly.)
function elmethGD02020Deploy(state, player) {
  const top5 = player.deck.splice(0, 5);
  const candidates = top5.filter((c) => c.def.type === 'pilot' && c.def.color === 'green' && (c.def.traits || []).includes('Zeon'));
  const chosen = candidates.length ? [...candidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0] : null;
  if (chosen) {
    top5.splice(top5.indexOf(chosen), 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top5));
}

// --- Gundam AGE-1 Normal (LR+) GD02-021 ---
// [Deploy] You may discard 1 green (Earth Federation) Unit card. If you do, place 1 EX Resource.
// Then, if you are Lv.7 or higher, draw 1. (Player Lv. = resource-area count, per cost.js's own
// Lv-affordability check. Heuristic discard: the cheapest eligible candidate, to trigger the bonus
// as cheaply as possible.)
function gundamAge1NormalLRDeploy(state, player) {
  const candidates = player.hand.filter(
    (c) => c.def.type === 'unit' && c.def.color === 'green' && (c.def.traits || []).includes('Earth Federation')
  );
  if (candidates.length) {
    const toDiscard = [...candidates].sort((a, b) => (a.def.cost || 0) - (b.def.cost || 0))[0];
    discardFromHand(player, toDiscard);
    placeExResource(state, player);
  }
  if (player.resourceArea.length >= 7) drawCard(state, player);
}

// --- G-Exes GD02-022 ---
// [Once per Turn] When you place an EX Resource, choose 1 of your (AGE System) Units. It gains
// <Breach 2> during this turn. (Heuristic default: the highest-AP eligible candidate.)
function gExesPlacesExResource(state, player, instance) {
  if (instance.activationsUsed.breachOnExResource) return;
  instance.activationsUsed.breachOnExResource = true;
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('AGE System'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ breach: 2, scope: 'turn' });
}

// --- Gundam AGE-1 Spallow (R+) GD02-023 ---
// [During Link] While you are Lv.7 or higher, this Unit gains <First Strike>. (Live-checked each
// attack rather than a static duringLinkKeywords grant, since it's conditional on player Lv.)
function gundamAge1SpallowAttack(state, player, instance) {
  if (!instance.isLinkUnit) return;
  if (player.resourceArea.length < 7) return;
  instance.buffs.push({ keyword: 'firstStrike', scope: 'battle' });
}

// --- Genoace Custom GD02-026 ---
// [Deploy] If you are Lv.7 or higher, choose 1 of your (AGE System) Units. It gets AP+2 during
// this turn.
function genoaceCustomDeploy(state, player) {
  if (player.resourceArea.length < 7) return;
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('AGE System'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: 2, scope: 'turn' });
}

// === GD02 batch 3 (GD02-031 through GD02-045) ===

// --- Gundam AGE-1 Titus GD02-031 ---
// "While you are Lv.7 or higher, this Unit gets AP+2" -- re-evaluated every resource phase (see
// phases.js) rather than deploy-time, since it's a continuous static condition.
function gundamAge1TitusGD02031ResourcePhase(state, player, instance) {
  instance.grantedStatBonus = player.resourceArea.length >= 7 ? { ap: 2 } : {};
}

// --- Kikeroga (MA Mode) (GQ) GD02-033 ---
// "While another friendly (Zeon) Link Unit is in play, this Unit gains <Breach 5>."
function kikerogaGD02033StartOfTurn(state, player, instance) {
  const hasAnotherZeonLink = player.battleArea.some(
    (u) => u !== instance && u.isLinkUnit && (u.def.traits || []).includes('Zeon')
  );
  instance.grantedKeywords.breach = hasAnotherZeonLink ? 5 : 0;
}

// --- Qubeley (LR+) GD02-036 ---
// [When Linked] gains Suppression during this turn.
// [During Pair: (Neo Zeon) Pilot] [Attack] Choose 1 damaged enemy Unit. Deal 2 damage to it.
function qubeleyGD02036WhenLinked(state, player, instance) {
  instance.buffs.push({ keyword: 'suppression', scope: 'turn' });
}
function qubeleyGD02036Attack(state, player, instance) {
  if (!instance.pilot || !(instance.pilot.def.traits || []).includes('Neo Zeon')) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.damage > 0);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 2);
}

// --- Gundam Virsago (LR+) GD02-037 ---
// <Breach 1> (data). [Deploy] If there are 3 or less enemy Shields, choose 1 enemy Unit with 5 or
// less AP. Deal 2 damage to it.
function virsagoGD02037Deploy(state, player) {
  const opponent = opponentOf(state, player);
  if (opponent.shields.length > 3) return;
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 5);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 2);
}

// --- Haman Karn's Gaza C GD02-039 ---
// [When Paired] Choose 1 enemy Unit that is Lv.3 or lower. Deal 1 damage to it.
function hamanKarnsGazaCWhenPaired(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 1);
}

// --- Gundam Ashtaron (R+) GD02-040 ---
// <Support 2> (data, activateSupport). [Deploy] Choose 1 of your other (New UNE) Units. It can't
// receive battle damage from enemy Units with 2 or less HP during this turn (see
// isImmuneToLowHPEnemyDamage in combat.js).
function ashtaronRPlusGD02040Deploy(state, player, instance) {
  const candidates = player.battleArea.filter((u) => u !== instance && (u.def.traits || []).includes('New UNE'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ lowHPEnemyDamageImmuneCap: 2, scope: 'turn' });
}

// --- Sugai's Gelgoog (GQ) (R+) GD02-041 ---
// [Deploy] Choose 1 enemy Unit that is Lv.5 or higher. Deal 2 damage to it.
function sugaisGelgoogGQRPlusDeploy(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) >= 5);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 2);
}

// --- Gundam Ashtaron (MA Mode) GD02-042 ---
// [Deploy] Choose 1 of your (New UNE) Units. It gains <High Maneuver> during this turn.
function ashtaronMAModeGD02042Deploy(state, player) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('New UNE'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Daughtress Weapon GD02-043 / Daughtress Command GD02-044 ---
// Weapon [Deploy] / Command [Destroyed]: if you have another (New UNE) Unit in play, deploy 1
// rested [Daughtress] ((New UNE) AP0/HP1) Unit token.
const DAUGHTRESS_TOKEN = Object.freeze({
  number: 'TOKEN-DAUGHTRESS', name: 'Daughtress', type: 'unit', color: 'red', traits: ['New UNE'], ap: 0, hp: 1, isToken: true
});
function daughtressWeaponDeploy(state, player, instance) {
  if (!player.battleArea.some((u) => u !== instance && (u.def.traits || []).includes('New UNE'))) return;
  deployUnit(state, player, DAUGHTRESS_TOKEN).rested = true;
}
function daughtressCommandDestroyed(state, player) {
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('New UNE'))) return;
  deployUnit(state, player, DAUGHTRESS_TOKEN).rested = true;
}

// --- GINN Long-Range Reconnaissance Type GD02-045 ---
// [Attack] If this Unit has 5 or more AP and it is attacking an enemy Unit, draw 1.
function ginnLongRangeReconAttack(state, player, instance, context) {
  if (getAP(instance) < 5 || !context.target || context.target.type !== 'unit') return;
  drawCard(state, player);
}

// === GD02 batch 4 (GD02-046 through GD02-062) ===

// --- Sayla's Light-Type Guncannon GD02-046 ---
// [Deploy] Choose 1 enemy Unit token. Deal 2 damage to it.
function saylasLightTypeGuncannonDeploy(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.def.isToken);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 2);
}

// --- Gaza C GD02-047 ---
// [Activate*Main] Rest this Unit: Destroy this and choose 1 enemy Unit that is Lv.5 or lower. Deal
// 1 damage to it. (Not wired into the AI's runActivations -- destroying your own Unit is a real
// sacrifice that needs judgement, same precedent as V2 Gundam/Archangel/Gundam Barbatos Lupus.)
function gazaCGD02047ActivateMain(state, player, instance) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 5);
  const target = candidates.length ? candidates.sort((a, b) => getAP(b) - getAP(a))[0] : null;
  destroyCard(state, player, instance);
  fireCardEffect(state, player, instance, 'destroyed', { wasPaired: !!instance.pilot });
  if (target) dealEffectDamage(state, player, opponent, target, 1);
}

// --- Gundam X (LR+) GD02-053 ---
// <Suppression> (data). [During Link] During your turn, while there are 7 or more cards in your
// trash, all your other (Vulture) Units get AP+2 -- re-evaluated (and toggled off during the
// opponent's turn) each time startOfTurn fires, same turn-granularity approximation used by
// Freedom Gundam etc, applied to other instances' own grantedStatBonus rather than this Unit's own.
function gundamXLRPlusGD02053StartOfTurn(state, player, instance) {
  const isOwnTurn = state.players[state.activePlayerIdx] === player;
  const active = isOwnTurn && instance.isLinkUnit && player.trash.length >= 7;
  for (const u of player.battleArea) {
    if (u === instance || !(u.def.traits || []).includes('Vulture')) continue;
    u.grantedStatBonus = active ? { ap: 2 } : {};
  }
}

// --- Gundam X GD02-056 ---
// [During Pair: (Vulture) Pilot] [Destroyed] Choose 1 (Vulture) Unit card that is Lv.5 or higher
// from your trash. Add it to your hand.
function gundamXGD02056Destroyed(state, player, instance, context) {
  if (!context.pilot || !(context.pilot.def.traits || []).includes('Vulture')) return;
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Vulture') && (c.def.level || 0) >= 5
  );
  if (candidates.length === 0) return;
  const chosen = candidates[0];
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);
}

// --- Zedas GD02-057 ---
// [During Pair] [Attack] You may choose 1 of your other Units. Destroy it. If you do, choose 1
// enemy Unit that is Lv.4 or lower. Deal 2 damage to it. (Heuristic: only sacrifices when the 2
// damage secures a kill on the enemy target, never just to chip damage.)
function zedasGD02057Attack(state, player, instance) {
  if (!instance.pilot) return;
  const opponent = opponentOf(state, player);
  const enemyCandidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4 && getRemainingHP(u) <= 2);
  if (enemyCandidates.length === 0) return;
  const ownCandidates = player.battleArea.filter((u) => u !== instance);
  if (ownCandidates.length === 0) return;

  const enemyTarget = enemyCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
  const toSacrifice = [...ownCandidates].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];

  destroyCard(state, player, toSacrifice);
  fireCardEffect(state, player, toSacrifice, 'destroyed', { wasPaired: !!toSacrifice.pilot });
  dealEffectDamage(state, player, opponent, enemyTarget, 2);
}

// --- Gundam Leopard (U+) GD02-060 ---
// [Deploy] If there are 7 or more cards in your trash, choose 1 enemy Unit that is Lv.4 or lower.
// Rest it.
function gundamLeopardUPlusDeploy(state, player) {
  if (player.trash.length < 7) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4 && !u.rested);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.rested = true;
}

// --- Hyakuri GD02-061 ---
// [When Paired: Purple Pilot] If there are 3 or more (Teiwaz)/(Tekkadan) cards in your trash,
// choose 1 enemy Unit with 3 or less AP. Rest it.
function hyakuriGD02061WhenPaired(state, player, instance, context) {
  if (!context.pilot || context.pilot.def.color !== 'purple') return;
  const trashCount = player.trash.filter(
    (c) => (c.def.traits || []).includes('Teiwaz') || (c.def.traits || []).includes('Tekkadan')
  ).length;
  if (trashCount < 3) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 3 && !u.rested);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.rested = true;
}

// === GD02 batch 5 (GD02-063 through GD02-078) ===

// --- Gundam Leopard GD02-064 ---
// <Blocker> is NOT on this card -- data-only otherwise except: "During your turn, while there are
// 7 or more cards in your trash, this Unit can't receive effect damage from enemy Commands," read
// via def.commandDamageImmuneWithTrash in dealEffectDamage (src/rules/effects.js).

// --- Gundam Barbatos 3rd Form GD02-068 ---
// [Deploy] Deal 2 damage to this Unit.
function gundamBarbatos3rdFormDeploy(state, player, instance) {
  dealDamage(instance, 2);
}

// --- Zeta Gundam (LR+) GD02-069 ---
// [During Link][Activate*Main][Once per Turn] Rest 1 active friendly Base: set this Unit as active.
// It can't choose the enemy player as its attack target during this turn. (Engine-correct, but not
// wired into the AI's runActivations -- same "resting something as a cost needs real judgement"
// precedent as V2 Gundam/Archangel's setActive abilities and last batch's Gaza C.)
function zetaGundamLRPlusActivateMain(state, player, instance) {
  if (!instance.isLinkUnit) return false;
  if (instance.activationsUsed.setActive) return false;
  if (!player.base || player.base.rested) return false;
  restBaseOrRedirect(player);
  instance.rested = false;
  instance.buffs.push({ cannotAttackPlayer: true, scope: 'turn' });
  instance.activationsUsed.setActive = true;
  return true;
}

// --- Gundam Kimaris (LR+) GD02-070 ---
// [Deploy] If there are 4 or more (Gjallarhorn) cards in your trash, draw 2. If you do, discard 2.
function gundamKimarisLRPlusDeploy(state, player) {
  const gjallarhornInTrash = player.trash.filter((c) => (c.def.traits || []).includes('Gjallarhorn')).length;
  if (gjallarhornInTrash < 4) return;
  drawCard(state, player);
  drawCard(state, player);
  const discards = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0)).slice(0, 2);
  for (const c of discards) {
    player.hand.splice(player.hand.indexOf(c), 1);
    player.trash.push(c);
  }
}

// --- Gundam Mk-II (AEUG) GD02-071 ---
// [Deploy] If a friendly white Base is in play, you may pair 1 (AEUG) Pilot card from your hand
// with this Unit.
function gundamMkIIAEUGDeploy(state, player, instance) {
  if (!player.base || player.base.def.color !== 'white') return;
  const candidates = player.hand.filter((c) => c.def.type === 'pilot' && (c.def.traits || []).includes('AEUG'));
  if (candidates.length === 0) return;
  pairPilot(state, player, instance, candidates[0]);
}

// --- Hyaku-Shiki (R+) GD02-072 ---
// <Blocker> (data). While a friendly white Base is in play, this Unit gains <Repair 1>, read via
// def.repairIfFriendlyBase in applyRepairAtEndOfTurn (src/rules/effects.js).

// --- Carta's Graze Ritter (Ground Type) (R+) GD02-073 ---
// During your opponent's turn, the enemy Unit battling this Unit gains <First Strike>, read via
// def.attackerGainsFirstStrike in resolveUnitBattleDamage (src/rules/combat.js).

// --- Gundam Aerial Rebuild GD02-074 ---
// <High-Maneuver> (data). [During Pair] While there are 4 or more Command cards in your trash, this
// Unit gains <Blocker> -- re-evaluated each startOfTurn, same live-toggle shape as Freedom Gundam
// ST09-004's Suppression-while-Base grant above.
function gundamAerialRebuildStartOfTurn(state, player, instance) {
  const commandsInTrash = player.trash.filter((c) => c.def.type === 'command').length;
  instance.grantedKeywords.blocker = !!(instance.pilot && commandsInTrash >= 4);
}

// --- Rick Dias (Red) GD02-075 ---
// [Attack] Choose 1 active friendly Base. Rest it. If you do, choose 1 enemy Unit that is Lv.4 or
// lower. It gets AP-2 during this battle.
function rickDiasRedAttack(state, player, instance) {
  if (!player.base || player.base.rested) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  if (candidates.length === 0) return;
  restBaseOrRedirect(player);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: -2, scope: 'battle' });
}

// --- Buster Gundam GD02-076 ---
// While this Unit has 5 or more AP, it gains <Blocker>, read via def.blockerWhileAPAtLeast in
// getKeywords (src/rules/management.js).

// === GD02 batch 6 (GD02-080 through GD02-094) ===

// --- Nemo GD02-080 --- vanilla Unit, no effect (pure card data).

// --- Methuss GD02-081 ---
// [Deploy] If a friendly white Base is in play, choose 1 enemy Unit. It gets AP-2 during this turn.
function methussDeploy(state, player, instance, context) {
  if (!player.base || player.base.def.color !== 'white') return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Gaelio's Schwalbe Graze GD02-082 ---
// While you have another (Gjallarhorn) Unit in play, this Unit gains <Blocker> -- same live-toggle
// shape as M1 Astray GD01-081.
function gaeliosSchwalbeGrazeStartOfTurn(state, player, instance) {
  instance.grantedKeywords.blocker = player.battleArea.some(
    (u) => u !== instance && (u.def.traits || []).includes('Gjallarhorn')
  );
}

// --- Graze Ritter (Ground Type) GD02-083 ---
// [Destroyed] If it is your opponent's turn, choose 1 of your (Gjallarhorn) Units. Set it as active.
function grazeRitterGroundTypeGD02083Destroyed(state, player, instance, context) {
  if (state.players[state.activePlayerIdx] === player) return;
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Gjallarhorn'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.find((u) => u.rested) || candidates[0];
  if (target) setActiveByEffect(state, player, target);
}

// --- Lauda's Dilanza GD02-084 --- vanilla Unit, no effect (pure card data).

// --- Four Murasame (R+) GD02-085 ---
// [Burst] Add this card to your hand.
// [During Link][Once per Turn] During your turn, when this Unit recovers HP, if you have 4 or less
// cards in your hand, draw 1. (Fired via applyRepairAtEndOfTurn's recoversHP event.)
function fourMurasameBurst(state, player, instance) {
  player.hand.push(instance);
}
function fourMurasameRecoversHP(state, player, unit) {
  if (!unit.isLinkUnit || !unit.pilot) return;
  if (unit.activationsUsed.fourMurasameDraw) return;
  if (player.hand.length > 4) return;
  unit.activationsUsed.fourMurasameDraw = true;
  drawCard(state, player);
}

// --- Jerid Messa GD02-086 ---
// [Burst] Add this card to your hand.
// While you have another (Titans) Unit in play, this gets AP+1 -- re-evaluated each startOfTurn via
// the new Pilot-forwarding in triggerEvent, same live-toggle shape as M1 Astray GD01-081.
function jeridMessaBurst(state, player, instance) {
  player.hand.push(instance);
}
function jeridMessaStartOfTurn(state, player, unit) {
  const hasAnotherTitans = player.battleArea.some((u) => u !== unit && (u.def.traits || []).includes('Titans'));
  unit.grantedStatBonus = { ap: hasAnotherTitans ? 1 : 0 };
}

// --- Orga, Crot, and Shani GD02-087 ---
// [Burst] Add this card to your hand.
// [When Linked] If this is a blue Unit, choose 1 enemy Unit with <Blocker>. Rest it.
function orgaCrotShaniBurst(state, player, instance) {
  player.hand.push(instance);
}
function orgaCrotShaniWhenLinked(state, player, unit, context) {
  if (unit.def.color !== 'blue') return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getKeywords(u).blocker);
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (target) target.rested = true;
}

// --- Flit Asuno (R+) GD02-088 ---
// [Burst] Add this card to your hand.
// [When Linked] Look at the top 3 cards of your deck. You may reveal 1 green (Earth Federation) Unit
// card / 1 card with "AGE Device" in its card name among them and add it to your hand. Return the
// remaining cards randomly to the bottom of your deck.
function flitAsunoBurst(state, player, instance) {
  player.hand.push(instance);
}
function flitAsunoWhenLinked(state, player) {
  const top3 = player.deck.splice(0, 3);
  const idx = top3.findIndex(
    (c) =>
      (c.def.type === 'unit' && c.def.color === 'green' && (c.def.traits || []).includes('Earth Federation')) ||
      (c.def.name || '').includes('AGE Device')
  );
  if (idx !== -1) {
    const [chosen] = top3.splice(idx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// --- Lalah Sune GD02-089 ---
// [Burst] Add this card to your hand.
// [When Paired] Choose 1 of your other (Zeon) Link Units. It gains <Breach 1> during this turn.
function lalahSuneBurst(state, player, instance) {
  player.hand.push(instance);
}
function lalahSuneWhenPaired(state, player, unit, context) {
  const candidates = player.battleArea.filter(
    (u) => u !== unit && u.isLinkUnit && (u.def.traits || []).includes('Zeon') && !getKeywords(u).breach
  );
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (target) target.buffs.push({ breach: 1, scope: 'turn' });
}

// --- Challia Bull (GQ) GD02-090 ---
// [Burst] Add this card to your hand.
// While you have another Unit with <High-Maneuver> in play, this Unit gets AP+1 -- same startOfTurn
// live-toggle shape as Jerid Messa GD02-086 above.
function challiaBullGQBurst(state, player, instance) {
  player.hand.push(instance);
}
function challiaBullGQStartOfTurn(state, player, unit) {
  const hasAnotherHighManeuver = player.battleArea.some((u) => u !== unit && getKeywords(u).highManeuver);
  unit.grantedStatBonus = { ap: hasAnotherHighManeuver ? 1 : 0 };
}

// --- Haman Karn (R+) GD02-091 ---
// [Burst] Add this card to your hand.
// [When Paired] If this Unit is red, choose 1 enemy Unit whose Lv. is equal to or lower than this
// Unit. Deal 1 damage to it.
function hamanKarnRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function hamanKarnRPlusWhenPaired(state, player, unit, context) {
  if (unit.def.color !== 'red') return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= (unit.def.level || 0));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealEffectDamage(state, player, opponent, target, 1);
}

// --- Shagia Frost GD02-092 ---
// [Burst] Add this card to your hand.
// [During Link][Attack] Choose 1 of your (New UNE) Units. It gets AP+2 during this turn.
function shagiaFrostBurst(state, player, instance) {
  player.hand.push(instance);
}
function shagiaFrostAttack(state, player, unit) {
  if (!unit.isLinkUnit) return;
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('New UNE'));
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Olba Frost GD02-093 ---
// [Burst] Add this card to your hand.
// During your turn, when this Unit destroys an enemy Unit paired with a (Newtype) Pilot with battle
// damage, draw 1. ("During your turn" and "with battle damage" both collapse away: destroysEnemy
// only ever fires on the attacker's own turn, off battle damage -- same insight as Carta's Graze
// Ritter's First Strike grant.)
function olbaFrostBurst(state, player, instance) {
  player.hand.push(instance);
}
function olbaFrostDestroysEnemy(state, player, unit, context) {
  const pilot = context.defenderPilot;
  if (!pilot || !(pilot.def.traits || []).includes('Newtype')) return;
  drawCard(state, player);
}

// --- Garrod Ran & Tiffa Adill (R+) GD02-094 ---
// [Burst] Add this card to your hand.
// [When Paired] You may discard 1. If you do, look at the top 3 cards of your deck. You may reveal 1
// (Vulture) Unit card among them and add it to your hand. Return the remaining cards randomly to the
// bottom of your deck. (Heuristic discard: cheapest hand card, same reasoning as Gundam AGE-1 Normal
// (LR+) GD02-021 -- trigger the bonus as cheaply as possible.)
function garrodTiffaBurst(state, player, instance) {
  player.hand.push(instance);
}
function garrodTiffaWhenPaired(state, player) {
  const discard = [...player.hand].sort((a, b) => (a.def.cost || 0) - (b.def.cost || 0))[0];
  if (!discard) return;
  player.hand.splice(player.hand.indexOf(discard), 1);
  player.trash.push(discard);
  const top3 = player.deck.splice(0, 3);
  const idx = top3.findIndex((c) => c.def.type === 'unit' && (c.def.traits || []).includes('Vulture'));
  if (idx !== -1) {
    const [chosen] = top3.splice(idx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// === GD02 batch 7 (GD02-095 through GD02-109) ===

// --- Lafter Frankland GD02-095 ---
// [Burst] Add this card to your hand.
// [Attack] If this Unit is damaged and Lv.5 or lower, it gains <High-Maneuver> during this battle.
function lafterFranklandBurst(state, player, instance) {
  player.hand.push(instance);
}
function lafterFranklandAttack(state, player, unit) {
  if (unit.damage > 0 && (unit.def.level || 0) <= 5) unit.buffs.push({ keyword: 'highManeuver', scope: 'battle' });
}

// --- Desil Galette GD02-096 ---
// [Burst] Add this card to your hand.
// [When Linked] You may choose 1 (Vagan) Unit card that is Lv.2 or lower from your trash. Pay its
// cost to deploy it. (Same pay-cost-from-trash shape as Destiny Gundam GD04-050.)
function desilGaletteBurst(state, player, instance) {
  player.hand.push(instance);
}
function desilGaletteWhenLinked(state, player, unit, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Vagan') && (c.def.level || 0) <= 2 && canAfford(player, c.def, { fromTrash: true })
  );
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  payCost(player, target.def, { fromTrash: true });
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
}

// --- Kamille Bidan (R+) GD02-097 ---
// [Burst] Add this card to your hand.
// While there is a friendly white Base in play, this Unit gets AP+2 -- re-evaluated each
// startOfTurn via the Jerid Messa GD02-086 grantedStatBonus shape (base presence approximated at
// turn granularity, same accepted limitation).
function kamilleBidanRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function kamilleBidanRPlusStartOfTurn(state, player, unit) {
  unit.grantedStatBonus = { ap: player.base && player.base.def.color === 'white' ? 2 : 0 };
}

// --- Quattro Bajeena GD02-098 ---
// This card's name is also treated as [Char Aznable] (read via def.nameAlias in matchesLinkCondition).
// [Burst] Add this card to your hand.
// [When Linked] If this is an (AEUG) Unit, draw 1. Then, discard 1.
function quattroBajeenaBurst(state, player, instance) {
  player.hand.push(instance);
}
function quattroBajeenaWhenLinked(state, player, unit) {
  if (!(unit.def.traits || []).includes('AEUG')) return;
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Gaelio Bauduin GD02-099 ---
// [Burst] Add this card to your hand.
// [When Paired] If there are 4 or more (Gjallarhorn) cards in your trash, choose 1 enemy Unit. It
// gets AP-2 during this turn.
function gaelioBauduinBurst(state, player, instance) {
  player.hand.push(instance);
}
function gaelioBauduinWhenPaired(state, player, unit, context) {
  const gjallarhornInTrash = player.trash.filter((c) => (c.def.traits || []).includes('Gjallarhorn')).length;
  if (gjallarhornInTrash < 4) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Dramatic Turnabout (R+) GD02-100 (Command) ---
// [Burst] Draw 1.
// [Main] Choose 1 friendly damaged Unit. It recovers 2 HP. Then, draw 1.
function dramaticTurnaboutBurst(state, player) {
  drawCard(state, player);
}
function dramaticTurnaboutCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.damage > 0);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  recoverHP(target, 2);
  drawCard(state, player);
}

// --- Beneath the Mask GD02-101 (Command) ---
// [Main]/[Action] Choose 1 to 2 enemy Units that are Lv.2 or lower. Rest them. (Same 1-to-2 default-
// slice shape as Graceful Demeanor GD04-117.)
function beneathTheMaskCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const t of targets) t.rested = true;
}

// --- Mouar's Determination GD02-102 (Command; pairable as Pilot [Mouar Pharaoh]) ---
// [Main]/[Action] Choose 1 friendly (Titans) Unit. It gets AP+2 during this turn.
function mouarsDeterminationCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Titans'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- AGE Device (R+) GD02-103 (Command) ---
// [Burst] Choose 1 (Asuno Family) Pilot card from your trash. Add it to your hand.
// [Main] If you have an (AGE System) Unit in play, place 1 EX Resource.
function ageDeviceRPlusBurst(state, player, instance, context) {
  const candidates = player.trash.filter((c) => c.def.type === 'pilot' && (c.def.traits || []).includes('Asuno Family'));
  const target = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  if (!target) return;
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}
function ageDeviceRPlusCommand(state, player) {
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('AGE System'))) return;
  placeExResource(state, player);
}

// --- Turning Point of History GD02-104 (Command) ---
// [Main] Look at the top 3 cards of your deck and return 1 to the top. Return the remaining cards
// to the bottom of your deck. Then, if you have a (Newtype) Pilot in play, draw 1. (Heuristic: keep
// a Unit/Base on top for the immediate board play, same as Kayra's Re-GZ / Minerva.)
function turningPointOfHistoryCommand(state, player) {
  const top3 = player.deck.splice(0, 3);
  const idx = top3.findIndex((c) => c.def.type === 'unit' || c.def.type === 'base');
  const keep = idx !== -1 ? top3.splice(idx, 1)[0] : top3.shift();
  player.deck.unshift(keep);
  player.deck.push(...top3);
  if (player.battleArea.some((u) => u.pilot && (u.pilot.def.traits || []).includes('Newtype'))) drawCard(state, player);
}

// --- Valedictorian GD02-105 (Command; pairable as Pilot [Xavier Olivette]) ---
// [Action] Choose 1 of your Unit tokens. It can't receive battle damage from enemy Units during
// this battle (a permanent-shape damageReduction buff scoped to 'battle', same mechanism as
// Argama's effectDamageReduction: Infinity but for battle damage and time-boxed).
function valedictorianCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.def.isToken);
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (target) target.buffs.push({ damageReduction: Infinity, scope: 'battle' });
}

// --- White Wolf GD02-106 (Command; pairable as Pilot [Woolf Enneacle]) ---
// [Action] During this battle, your shield area can't receive damage from enemy Units that are
// Lv.3 or lower (def.shieldDamageImmuneLevelCap read in combat.js's resolveDamageStep).
function whiteWolfCommand(state, player) {
  player.shieldDamageImmuneLevelCap = 3;
}

// --- All-Range Attack (R+) GD02-107 (Command) ---
// [Burst] Choose 1 enemy Unit. Deal 1 damage to it.
// [Main] Deal 1 damage to all enemy Units other than Link Units.
function allRangeAttackRPlusBurst(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealEffectDamage(state, player, opponent, target, 1);
}
function allRangeAttackRPlusCommand(state, player) {
  const opponent = opponentOf(state, player);
  for (const u of opponent.battleArea) {
    if (!u.isLinkUnit) dealEffectDamage(state, player, opponent, u, 1);
  }
}

// --- That One Looks A Lot Stronger? GD02-108 (Command) ---
// [Main] Choose 1 friendly (Clan) Unit. During this turn, it may choose an active enemy Unit that
// is Lv.4 or lower as its attack target (same activeTargetLevelCap buff family as Wing Gundam/
// Athrun Zala).
function thatOneLooksALotStrongerCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Clan'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ activeTargetLevelCap: 4, scope: 'turn' });
}

// --- Undying Persistence GD02-109 (Command; pairable as Pilot [Shiiko Sugai]) ---
// [Main]/[Action] Choose 1 enemy Unit. Deal 1 damage to it.
function undyingPersistenceCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealEffectDamage(state, player, opponent, target, 1);
}

// === GD02 batch 8 (GD02-111 through GD02-130, final GD02 batch) ===

// --- Decisive Last Resort GD02-111 (Command) ---
// [Burst] Choose 1 enemy Unit that is Lv.3 or lower. Deal 2 damage to it.
// [Main] Choose 6 purple Unit cards from your trash. Exile them from the game. If you do, choose 1
// enemy Unit. Destroy it.
function decisiveLastResortBurst(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealEffectDamage(state, player, opponent, target, 2);
}
function decisiveLastResortCommand(state, player, instance, context) {
  const purpleUnits = player.trash.filter((c) => c.def.type === 'unit' && c.def.color === 'purple');
  if (purpleUnits.length < 6) return;
  for (const card of purpleUnits.slice(0, 6)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Momentary Respite (R+) GD02-112 (Command) ---
// [Burst] Draw 1. [Main] Choose 1 purple Pilot card from your trash. Add it to your hand.
function momentaryRespiteBurst(state, player) {
  drawCard(state, player);
}
function momentaryRespiteCommand(state, player) {
  const chosen = player.trash.find((c) => c.def.type === 'pilot' && c.def.color === 'purple');
  if (!chosen) return;
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);
}

// Shared by Sisterly Care GD02-113 and Hammerhead GD02-128: "If a friendly (Teiwaz) Link Unit is in
// play, choose 1 enemy Unit with 2 or less AP. Destroy it."
function teiwazLinkDestroyLowAP(state, player, context) {
  if (!player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('Teiwaz'))) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 2);
  const target = context && context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Sisterly Care GD02-113 (Command; pairable as Pilot [Amida Arca]) ---
// [Main]/[Action] If a friendly (Teiwaz) Link Unit is in play, choose 1 enemy Unit with 2 or less
// AP. Destroy it.
function sisterlyCareCommand(state, player, instance, context) {
  teiwazLinkDestroyLowAP(state, player, context);
}

// --- It's Name is Ryusei-Go GD02-114 (Command; pairable as Pilot [Norba Shino]) ---
// [Main]/[Action] Choose 1 damaged friendly Unit. It gets AP+2 during this turn.
function itsNameIsRyuseiGoCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.def.type === 'unit' && u.damage > 0);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Familial Devotion GD02-115 (Command; pairable as Pilot [Witz Sou]) ---
// [Main]/[Action] Choose 1 friendly (Vulture) Unit. It gets AP+2 during this turn.
function familialDevotionCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.def.type === 'unit' && (u.def.traits || []).includes('Vulture'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Comrades Come First GD02-116 (Command; pairable as Pilot [Roybea Loy]) ---
// [Main] If there are 7 or more cards in your trash, choose 1 friendly (Vulture) Unit. During this
// turn, it may choose an active enemy Unit that is Lv.4 or lower as its attack target (same
// activeTargetLevelCap buff family as Wing Gundam/Athrun Zala/That One Looks A Lot Stronger?).
function comradesComeFirstCommand(state, player, instance, context) {
  if (player.trash.length < 7) return;
  const candidates = player.battleArea.filter((u) => u.def.type === 'unit' && (u.def.traits || []).includes('Vulture'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ activeTargetLevelCap: 4, scope: 'turn' });
}

// --- A New Sign GD02-117 (Command) ---
// [Burst] Choose 1 (AEUG) Base card from your trash. Add it to your hand.
// [Main] Draw 3. Then, discard 2.
function aNewSignBurst(state, player) {
  const chosen = player.trash.find((c) => c.def.type === 'base' && (c.def.traits || []).includes('AEUG'));
  if (!chosen) return;
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);
}
function aNewSignCommand(state, player) {
  drawCard(state, player);
  drawCard(state, player);
  drawCard(state, player);
  for (let i = 0; i < 2; i++) {
    const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
    if (!toDiscard) break;
    discardFromHand(player, toDiscard);
  }
}

// --- Heart Set on Revenge GD02-118 (Command; pairable as Pilot [Ein Dalton]) ---
// [Action] Choose 1 enemy Unit with 4 or less HP battling a friendly Unit with <Blocker>. Return it
// to its owner's hand. Action-timing keyed to the current battle -- no generic action-step auto-cast
// wiring exists in this engine yet, so this reads context.attacker/context.defender directly (the
// same "call it explicitly" convention used for other battle-scoped effects tested outside
// resolveAttack, e.g. Lafter Frankland GD02-095).
function heartSetOnRevengeCommand(state, player, instance, context) {
  const attacker = context && context.attacker;
  const blocker = context && context.defender;
  if (!attacker || !blocker) return;
  if (getRemainingHP(attacker) > 4) return;
  if (!getKeywords(blocker).blocker) return;
  const opponent = opponentOf(state, player);
  removeFromField(opponent, attacker, opponent.hand);
  sendToZone(opponent.hand, attacker);
}

// --- Persistent and Fortitudinous GD02-119 (Command; pairable as Pilot [Carta Issue]) ---
// [Action] If you have a (Gjallarhorn) Link Unit in play, choose 1 enemy Unit. It gets AP-3 during
// this battle.
function persistentAndFortitudinousCommand(state, player, instance, context) {
  if (!player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('Gjallarhorn'))) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -3, scope: 'battle' });
}

// --- Aspiring Pilot GD02-120 (Command; pairable as Pilot [Fa Yuiry]) ---
// [Action] Choose 1 of your (AEUG) Units/Bases. It recovers 2 HP.
function aspiringPilotCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter(
    (u) => (u.def.type === 'unit' || u.def.type === 'base') && (u.def.traits || []).includes('AEUG')
  );
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : [...candidates].sort((a, b) => b.damage - a.damage)[0];
  if (target) recoverHP(target, 2);
}

// --- Dominion GD02-121 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 friendly
// blue Unit. It recovers 2 HP.
function dominionDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  const candidates = player.battleArea.filter((u) => u.def.type === 'unit' && u.def.color === 'blue');
  const target = [...candidates].sort((a, b) => b.damage - a.damage)[0];
  if (target) recoverHP(target, 2);
}

// --- Alexandria GD02-122 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 rested
// enemy Unit that is Lv.4 or lower. Deal 1 damage to it.
function alexandriaDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested && (u.def.level || 0) <= 4);
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealEffectDamage(state, player, opponent, target, 1);
}

// --- Sodon GD02-123 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 friendly
// Unit token. During this turn, it may choose an active enemy Unit with 5 or less AP as its attack
// target (activeTargetAPThreshold buff family, same as Kampfer GD03-017).
function sodonDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  const target = player.battleArea.find((u) => u.def.isToken);
  if (target) target.buffs.push({ activeTargetAPThreshold: 5, scope: 'turn' });
}

// --- Diva GD02-124 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand.
// [Static] During your turn, while you are Lv.7 or higher, all friendly green (Earth Federation)
// Units get AP+1 (same turn-refreshed static-aura pattern as Penelope (Flight Form) GD04-002).
function divaStartOfTurn(state, player) {
  if (state.players[state.activePlayerIdx] !== player) return;
  if (player.resourceArea.length < 7) return;
  for (const u of player.battleArea) {
    if (u.def.color === 'green' && (u.def.traits || []).includes('Earth Federation')) {
      u.buffs.push({ ap: 1, scope: 'turn' });
    }
  }
}

// --- Gwadan GD02-125 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn,
// you may discard 1 red card. If you do, draw 1. (Heuristic discard: the cheapest eligible
// candidate, same convention as Gundam AGE-1 Normal (LR+) GD02-021.)
function gwadanDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  if (state.players[state.activePlayerIdx] !== player) return;
  const candidates = player.hand.filter((c) => c.def.color === 'red');
  const toDiscard = [...candidates].sort((a, b) => (a.def.cost || 0) - (b.def.cost || 0))[0];
  if (!toDiscard) return;
  discardFromHand(player, toDiscard);
  drawCard(state, player);
}

// --- Freeden GD02-127 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand.
// [Destroyed] Place the top 2 cards of your deck into your trash.
function freedenDestroyed(state, player) {
  const milled = player.deck.splice(0, 2);
  for (const c of milled) player.trash.push(c);
}

// --- Hammerhead GD02-128 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn
// and a friendly (Teiwaz) Link Unit is in play, choose 1 enemy Unit with 2 or less AP. Destroy it.
function hammerheadDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  if (state.players[state.activePlayerIdx] !== player) return;
  teiwazLinkDestroyLowAP(state, player, {});
}

// --- Sleipnir GD02-130 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if a friendly
// (Gjallarhorn) Unit is in play, choose 1 enemy Unit. It gets AP-2 during this turn.
function sleipnirDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  if (!player.battleArea.some((u) => u.def.type === 'unit' && (u.def.traits || []).includes('Gjallarhorn'))) return;
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// === GD03 batch 1 (GD03-002 through GD03-015) ===

// --- The-O (LR+) GD03-002 ---
// <Repair 3>. [During Pair] When one of your other Units with <Repair> attacks, choose 1 enemy
// Unit whose Lv. is equal to or lower than that Unit. Rest it.
function theOAllyAttack(state, player, instance, context) {
  if (!instance.pilot) return;
  const attacker = context && context.attacker;
  if (!attacker || !getKeywords(attacker).repair) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= (attacker.def.level || 0));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Hambrabi GD03-004 ---
// [Attack] If you have 2 or more other (Titans) Units in play, choose 1 enemy Unit with 5 or less
// HP. Rest it.
function hambrabiAttack(state, player, instance, context) {
  const otherTitans = player.battleArea.filter((u) => u !== instance && (u.def.traits || []).includes('Titans'));
  if (otherTitans.length < 2) return;
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Kshatriya Besserung GD03-005 ---
// <Repair 1>. [Deploy] Draw 1.
function kshatriyaBesserungDeploy(state, player) {
  drawCard(state, player);
}

// --- Penelope (Middle Form) GD03-006 ---
// [Deploy] Choose 1 to 2 enemy Units with 3 or less HP. Rest them.
function penelopeMiddleFormDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 3);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const t of targets) t.rested = true;
}

// --- Gundam NT-1 Full Armor GD03-007 ---
// [Destroyed] Choose 1 enemy Unit with 3 or less HP. Rest it.
function gundamNT1FullArmorDestroyed(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Palace Athene GD03-009 ---
// [Deploy] You may choose 2 (Titans) cards from your trash. Exile them from the game. If you do,
// choose 1 enemy Unit that is Lv.4 or lower. Rest it.
function palaceAtheneDeploy(state, player, instance, context) {
  const titansCards = player.trash.filter((c) => (c.def.traits || []).includes('Titans'));
  if (titansCards.length < 2) return;
  for (const card of titansCards.slice(0, 2)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Hizack GD03-013 ---
// While you have another (Jupitris) Unit in play, this Unit gets AP+1 and <Repair 1> (Jerid Messa
// GD02-086 grantedStatBonus shape, extended with grantedKeywords for the Repair half).
function hizackStartOfTurn(state, player, unit) {
  const hasAnotherJupitris = player.battleArea.some((u) => u !== unit && (u.def.traits || []).includes('Jupitris'));
  unit.grantedStatBonus = { ap: hasAnotherJupitris ? 1 : 0 };
  unit.grantedKeywords.repair = hasAnotherJupitris ? 1 : 0;
}

// --- Baund Doc GD03-015 ---
// [Activate: Main][Once per Turn] Exile 3 (Titans) cards from your trash: This Unit gains
// <Breach 4> during this turn.
function baundDocActivateMain(state, player, instance) {
  if (instance.activationsUsed.breach) return false;
  const titansCards = player.trash.filter((c) => (c.def.traits || []).includes('Titans'));
  if (titansCards.length < 3) return false;
  for (const card of titansCards.slice(0, 3)) {
    player.trash.splice(player.trash.indexOf(card), 1);
    player.removal.push(card);
  }
  instance.buffs.push({ breach: 4, scope: 'turn' });
  instance.activationsUsed.breach = true;
  return true;
}

// === GD03 batch 2 (GD03-016 through GD03-036) ===

// --- Gundam AGE-2 Normal (LR+) GD03-019 ---
// [During Pair] Enemy Units choose this rested Unit as their attack target if possible when
// attacking (data field `duringPairTaunt`, read by the AI's getForcedAttackTargets). [When Linked]
// Place 1 EX Resource.
function gundamAge2NormalLRWhenLinked(state, player) {
  placeExResource(state, player);
}

// --- Zaku II FZ (R+) GD03-020 ---
// [When Paired] If there are 4 or more (Cyclops Team) cards in your trash, deploy 2 rested [Ad
// Balloon] ((Civilian) AP0/HP1, can't be set active or paired with a Pilot) Unit tokens. While you
// have a Unit with "Ad Balloon" in its card name in play, this Unit can't receive enemy battle
// damage (data field `immuneWhileUnitNameInPlay`, read by combat.js's isImmuneViaNamedToken).
const AD_BALLOON_TOKEN = Object.freeze({
  number: 'TOKEN-AD-BALLOON', name: 'Ad Balloon', type: 'unit', color: null,
  traits: ['Civilian'], ap: 0, hp: 1, isToken: true, cannotBeSetActive: true, cannotBePaired: true
});
function zakuIIFZWhenPaired(state, player) {
  const cyclopsInTrash = player.trash.filter((c) => (c.def.traits || []).includes('Cyclops Team')).length;
  if (cyclopsInTrash < 4) return;
  for (let i = 0; i < 2; i++) {
    const token = deployUnit(state, player, AD_BALLOON_TOKEN);
    token.rested = true;
  }
}

// --- Gundam Deathscythe Hell GD03-021 ---
// [Deploy] Choose 1 of your (Operation Meteor)/(G Team) Units. During this turn, it may choose an
// active enemy Unit as its attack target (activeTargetLevelCap buff with no real ceiling, reusing
// Wing Gundam ST02-001's shape).
function gundamDeathscytheHellGD03021Deploy(state, player, instance, context) {
  const candidates = player.battleArea.filter(
    (u) => (u.def.traits || []).includes('Operation Meteor') || (u.def.traits || []).includes('G Team')
  );
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ activeTargetLevelCap: Infinity, scope: 'turn' });
}

// --- Gundam Kyrios (R+) GD03-022 ---
// [During Link] During your turn, when this Unit destroys an enemy Unit with battle damage, deal 1
// damage to all enemy Units that are Lv.3 or lower.
function gundamKyriosRPlusDestroysEnemy(state, player, instance) {
  if (!instance.isLinkUnit) return;
  for (const u of opponentOf(state, player).battleArea) {
    if ((u.def.level || 0) <= 3) dealDamage(u, 1);
  }
}

// --- G-Bouncer GD03-023 ---
// When you place an EX Resource, choose 1 of your (AGE System) Units. It gains <High-Maneuver>
// during this turn.
function gBouncerPlacesExResource(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('AGE System'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Auda's Maganac GD03-028 ---
// [Attack] If you are attacking an enemy Unit, this Unit gets AP+2 during this battle.
function audasManganacAttack(state, player, instance, context) {
  if (context.target && context.target.type === 'unit') instance.buffs.push({ ap: 2, scope: 'battle' });
}

// --- Gundam Heavyarms Custom GD03-029 ---
// During your turn, when this Unit destroys an enemy Unit with battle damage, deal 2 damage to all
// enemy Units with <Blocker>.
function gundamHeavyarmsCustomDestroysEnemy(state, player) {
  for (const u of opponentOf(state, player).battleArea) {
    if (getKeywords(u).blocker) dealDamage(u, 2);
  }
}

// --- Providence Gundam (LR+) GD03-033 ---
// [During Pair: (ZAFT) Pilot] During your turn, all your (ZAFT) Units get AP+2. [Attack] Choose 1
// enemy Unit. Deal 1 damage to it for each 4 AP this Unit has.
function providenceGundamLRStartOfTurn(state, player, instance) {
  if (!instance.pilot || !(instance.pilot.def.traits || []).includes('ZAFT')) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  for (const u of player.battleArea) {
    if ((u.def.traits || []).includes('ZAFT')) u.buffs.push({ ap: 2, scope: 'turn' });
  }
}
function providenceGundamLRAttack(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  const amount = Math.floor(getAP(instance) / 4);
  if (target && amount > 0) dealDamage(target, amount);
}

// --- Xi Gundam (Flight Form) (R+) GD03-036 ---
// [When Linked] Deal 1 damage to all enemy Units.
function xiGundamFlightFormWhenLinked(state, player) {
  for (const u of opponentOf(state, player).battleArea) dealDamage(u, 1);
}

// === GD03 batch 3 (GD03-037 through GD03-053) ===

// --- Bertigo (R+) GD03-037 ---
// [During Link] During your turn, while this Unit is battling an enemy Unit with a [Destroyed]
// effect, it gains <First Strike>.
function bertigoAttack(state, player, instance, context) {
  if (!instance.isLinkUnit) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  const target = context.target;
  if (target && target.type === 'unit' && target.instance.def.effects && target.instance.def.effects.destroyed) {
    instance.buffs.push({ keyword: 'firstStrike', scope: 'battle' });
  }
}

// --- GuAIZ (Commander Type) GD03-038 ---
// [ActivateMain] <Support 1> (Rest this Unit. 1 other friendly Unit gets AP+1 during this turn.)
// During your turn, when this Unit is rested by an effect, choose 1 of your (ZAFT) Units. It gets
// AP+2 during this turn. -- inlined rather than layered onto the generic Support keyword (same
// call as Nena Trinity GD04-089), since the only way this Unit gets "rested by an effect" in the
// current cardpool is this ability's own self-rest cost.
function guaizCommanderActivateMain(state, player, unit, context) {
  const target = context.target;
  if (!target || target === unit || unit.rested) return false;
  unit.rested = true;
  target.buffs.push({ ap: 1, scope: 'turn' });
  const zaftCandidates = player.battleArea.filter((u) => (u.def.traits || []).includes('ZAFT'));
  const zaftTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(zaftCandidates)
    : zaftCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (zaftTarget) zaftTarget.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Patulia GD03-041 ---
// [Deploy] Deal 3 damage to all Bases.
function patuliaDeploy(state) {
  for (const p of state.players) {
    if (p.base) {
      dealDamage(p.base, 3);
      destroyAndFireEffect(state, p, p.base);
    }
  }
}

// --- Messer Type-F02 GD03-043 ---
// [When Paired] Choose 1 enemy Unit. Deal 1 damage to it.
function messerTypeF02WhenPaired(state, player, unit, context) {
  const candidates = opponentOf(state, player).battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 1);
}

// --- Daughtress Flyer GD03-044 ---
// [Deploy] Deploy 1 rested [Daughtress] ((New UNE) AP0/HP1) Unit token -- reuses the DAUGHTRESS_TOKEN
// def already defined above for Daughtress Weapon GD02-043 / Daughtress Command GD02-044.
function daughtressFlyerDeploy(state, player) {
  deployUnit(state, player, DAUGHTRESS_TOKEN).rested = true;
}

// --- Balient GD03-045 ---
// While you have a Unit token in play, this Unit gets AP+1 -- same startOfTurn live-toggle shape
// as Challia Bull (GQ) GD02-090.
function balientStartOfTurn(state, player, unit) {
  const hasToken = player.battleArea.some((u) => u !== unit && u.def.isToken);
  unit.grantedStatBonus = { ap: hasToken ? 1 : 0 };
}

// --- GFreD GD03-048 ---
// [Burst] If there are 3 or less enemy Shields, deploy 1 rested [GFreD] ((Zeon) AP4/HP3) Unit token.
const GFRED_TOKEN = Object.freeze({
  number: 'TOKEN-GFRED', name: 'GFreD', type: 'unit', color: null,
  traits: ['Zeon'], ap: 4, hp: 3, isToken: true
});
function gfreDBurst(state, player, instance) {
  const opponent = opponentOf(state, player);
  if (opponent.shields.length > 3) return;
  const token = deployUnit(state, player, GFRED_TOKEN);
  token.rested = true;
}

// --- Gundam X Divider GD03-051 ---
// [When Linked] You may choose 1 Unit card that is Lv.4 or lower from your trash. Pay its cost to
// deploy it. Same shape as Awakened Power GD02-110 / Destiny Gundam GD04-050.
function gundamXDividerWhenLinked(state, player, instance, context) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.level || 0) <= 4 && canAfford(player, c.def, { fromTrash: true })
  );
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  payCost(player, target.def, { fromTrash: true });
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
}

// --- Gundam Virtue (R+) GD03-052 ---
// <Support 2> (data). When this Unit deals battle damage to an enemy Unit that is Lv.5 or lower, if
// you have a (CB) Pilot in play, destroy that enemy Unit -- same "top up damage to lethal" shape as
// Gundam Exia Repair GD05-050.
function gundamVirtueRPlusDealsBattleDamage(state, player, unit, context) {
  const defender = context.defender;
  if (!defender || (defender.def.level || 0) > 5) return;
  const hasCBPilot = player.battleArea.some((u) => u.pilot && (u.pilot.def.traits || []).includes('CB'));
  if (!hasCBPilot) return;
  defender.damage = getHP(defender);
}

// --- Gundam Gusion Rebake Full City (R+) GD03-053 ---
// <Blocker> (data). [During Pair][Once per Turn] During your turn, when one of your
// (Tekkadan)/(Teiwaz) Units receives effect damage, choose 1 enemy Unit that is Lv.4 or lower. Rest
// it. (friendlyUnitReceivesEffectDamage broadcast added to effects.js's dealEffectDamage.)
function gundamGusionRebakeFriendlyUnitReceivesEffectDamage(state, player, instance, context) {
  if (!instance.pilot) return;
  if (instance.activationsUsed.restEnemy) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  const traits = context.target.def.traits || [];
  if (!traits.includes('Tekkadan') && !traits.includes('Teiwaz')) return;
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) <= 4);
  const chosen = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!chosen) return;
  chosen.rested = true;
  instance.activationsUsed.restEnemy = true;
}

// === GD03 batch 4 (GD03-054 through GD03-070) ===

// --- Zeydra GD03-054 ---
// [When Paired: (X-Rounder) Pilot] You may choose 4 (Vagan) cards from your trash. Exile them. If
// you do, choose 1 enemy Unit that is Lv.4 or lower. Destroy it.
function zeydraWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  const traits = pilot ? pilot.def.traits || [] : [];
  if (!traits.includes('X-Rounder')) return;
  const vaganCards = player.trash.filter((c) => (c.def.traits || []).includes('Vagan'));
  if (vaganCards.length < 4) return;
  const chosen = context.hooks && context.hooks.chooseCards
    ? context.hooks.chooseCards(vaganCards, 4)
    : vaganCards.slice(0, 4);
  for (const c of chosen) {
    player.trash.splice(player.trash.indexOf(c), 1);
    player.removal.push(c);
  }
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Gundam Hajiroboshi (2nd Form) GD03-055 ---
// [When Paired: Purple Pilot] Choose 1 enemy Unit that is Lv.2 or lower. Destroy it.
function gundamHajiroboshi2ndFormWhenPaired(state, player, unit, context) {
  if (!context.pilot || context.pilot.def.color !== 'purple') return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Farsia GD03-058 ---
// data only: "This card in your trash gets cost -1" (def.costReductionInTrash, read by
// effectiveCost when a caller passes { fromTrash: true } -- see cost.js).

// --- Zedas R GD03-059 ---
// [Attack] You may choose 1 (Vagan) card from your trash. Exile it. If you do, choose 1 of your
// (Vagan) Units. It gets AP+2 during this turn.
function zedasRAttack(state, player, unit, context) {
  const vaganCards = player.trash.filter((c) => (c.def.traits || []).includes('Vagan'));
  if (vaganCards.length === 0) return;
  const exiled = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(vaganCards)
    : vaganCards[0];
  player.trash.splice(player.trash.indexOf(exiled), 1);
  player.removal.push(exiled);
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Vagan'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- CGS Mobile Worker (Commander Type) GD03-060 ---
// [Once per Turn] During your turn, when this Unit receives effect damage, deploy 1 rested
// [CGS Mobile Worker] ((Tekkadan)AP1HP1) Unit token. (receivesEffectDamage trigger added to
// effects.js's dealEffectDamage -- unlike receivesEnemyEffectDamage, fires regardless of source.)
const CGS_MOBILE_WORKER_TOKEN = Object.freeze({
  number: 'TOKEN-CGS', name: 'CGS Mobile Worker', type: 'unit', color: null,
  traits: ['Tekkadan'], ap: 1, hp: 1, isToken: true
});
function cgsMobileWorkerReceivesEffectDamage(state, player, instance) {
  if (state.players[state.activePlayerIdx] !== player) return;
  if (instance.activationsUsed.deployToken) return;
  instance.activationsUsed.deployToken = true;
  deployUnit(state, player, CGS_MOBILE_WORKER_TOKEN).rested = true;
}

// --- Gundam Barbatos 6th Form GD03-061 ---
// data only: "While this Unit has 1 HP, it gains <Repair 3>" (def.repairIfHPExactly, read live in
// effects.js's applyRepairAtEndOfTurn -- can't be a startOfTurn snapshot since HP changes mid-turn).

// --- GX-Bit GD03-062 ---
// [Deploy] If you deploy this Unit from your trash, choose 1 enemy Unit with 4 or less AP. Deal 2
// damage to it. Same fromTrash-gated shape as Sword Impulse Gundam ST09-006.
function gxBitDeploy(state, player, instance, context) {
  if (!context.fromTrash) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 2);
}

// --- Defurse GD03-064 ---
// [Deploy] You may choose 1 (X-Rounder) card from your trash and add it to your hand. If you do,
// discard 1.
function defurseDeploy(state, player, instance, context) {
  const candidates = player.trash.filter((c) => (c.def.traits || []).includes('X-Rounder'));
  if (candidates.length === 0) return;
  const fetched = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates[0];
  player.trash.splice(player.trash.indexOf(fetched), 1);
  player.hand.push(fetched);
  const discard = context.hooks && context.hooks.chooseDiscard
    ? context.hooks.chooseDiscard(player.hand)
    : player.hand[0];
  if (discard) {
    player.hand.splice(player.hand.indexOf(discard), 1);
    player.trash.push(discard);
  }
}

// --- Gundam Hajiroboshi GD03-068 ---
// While a friendly Base is in play, this Unit gains <Blocker>. Same shape as Freedom Gundam
// ST09-004's freedomGundamStartOfTurn.
function gundamHajiroboshiStartOfTurn(state, player, instance) {
  instance.grantedKeywords.blocker = !!player.base;
}

// --- Graham's Union Flag Custom (LR+) GD03-069 ---
// <High-Maneuver> (data). [During Link] At the end of the turn when this Unit is paired with a
// Pilot, set it as active. Implemented off whenLinked (only fires when pairing actually satisfies
// the Link Condition) plus a one-turn flag consumed at endOfTurn.
function grahamsUnionFlagCustomWhenLinked(state, player, instance) {
  instance.pairedThisTurn = true;
}
function grahamsUnionFlagCustomEndOfTurn(state, player, instance) {
  if (!instance.pairedThisTurn) return;
  instance.pairedThisTurn = false;
  instance.rested = false;
}

// --- Freedom Gundam GD03-070 (LR+) ---
// data only: "While this Unit is rested, friendly Shields can't receive battle damage from enemy
// Units" (def.shieldDamageImmuneWhileRested, checked inline in combat.js's resolveDamageStep).

// === GD03 batch 5 (GD03-071 through GD03-084) ===

// --- Z Gundam (Biosensor) (R+) GD03-071 ---
// [Deploy] Choose 1 enemy Unit. For each (AEUG) Unit card in your trash, it gets AP-1 during this turn.
function zGundamBiosensorDeploy(state, player, instance, context) {
  const aeugInTrash = player.trash.filter((c) => c.def.type === 'unit' && (c.def.traits || []).includes('AEUG')).length;
  if (aeugInTrash === 0) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ ap: -aeugInTrash, scope: 'turn' });
}

// --- Aile Strike Gundam GD03-072 ---
// <Blocker> (data). [Deploy] If you have another (Triple Ship Alliance) Unit in play, draw 1. Then
// discard 1. (Distinct from ST04-001's byte-different "Aile Strike Gundam".)
function aileStrikeGundamGD03072Deploy(state, player, instance) {
  const hasOtherTSA = player.battleArea.some((u) => u !== instance && (u.def.traits || []).includes('Triple Ship Alliance'));
  if (!hasOtherTSA) return;
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Graze Ein (R+) GD03-073 ---
// <Blocker> (data). [During Link][Activate*Action][Once per Turn] If there are 6 or more
// (Gjallarhorn) cards in your trash, choose 1 enemy Unit battling this Unit. It gets AP-3 during
// this battle. Same "Engine-correct, not wired into runActivations" scoping as G-Sky Easy GD01-014
// -- takes context.target as the enemy Unit currently battling it.
function grazeEinActivateAction(state, player, instance, context) {
  if (!instance.isLinkUnit) return false;
  if (instance.activationsUsed.apDebuff) return false;
  const gjallarhornInTrash = player.trash.filter((c) => (c.def.traits || []).includes('Gjallarhorn')).length;
  if (gjallarhornInTrash < 6) return false;
  const target = context.target;
  if (!target) return false;
  target.buffs.push({ ap: -3, scope: 'battle' });
  instance.activationsUsed.apDebuff = true;
  return true;
}

// --- Tieren Taozi GD03-074 ---
// data only: "[During Pair] While you have another (Superpower Bloc) Unit in play, enemy Units
// choose this rested Unit as their attack target if possible" (def.duringPairTauntIfTrait, read by
// the AI's getForcedAttackTargets).

// --- Super Gundam GD03-075 ---
// [During Link][Attack] Choose 1 enemy Unit with no paired Pilot. It gets AP-2 during this turn.
function superGundamAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => !u.pilot);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Freedom Gundam (Meteor) GD03-076 ---
// [Once per Turn] During your turn, when your (Triple Ship Alliance) Unit deals battle damage to an
// enemy Unit, you may return the enemy Unit to its owner's hand. (friendlyUnitDealsBattleDamage
// broadcast added to combat.js's fireDealsBattleDamage.)
function freedomGundamMeteorFriendlyUnitDealsBattleDamage(state, player, instance, context) {
  if (instance.activationsUsed.returnEnemy) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  if (!(context.attacker.def.traits || []).includes('Triple Ship Alliance')) return;
  const target = context.defender;
  if (!target) return;
  const opponent = opponentOf(state, player);
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
  instance.activationsUsed.returnEnemy = true;
}

// --- Justice Gundam (METEOR) GD03-077 ---
// [When Linked] Choose 1 to 3 enemy Units with 3 or less HP. Return them to their owners' hands.
// Same "1 to N, return to hand" shape as Graceful Demeanor GD04-117.
function justiceGundamMeteorWhenLinked(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 3);
  for (const t of targets) {
    removeFromField(opponent, t, opponent.hand);
    sendToZone(opponent.hand, t);
  }
}

// --- Tieren High Mobility Type GD03-078 ---
// [During Link][Destroyed] Return the card paired with this Unit to your hand. Same shape as
// Unicorn Gundam (Unicorn Mode) GD01-005's unicornGundamUnicornModeDestroyed, minus the discard.
function tierenHighMobilityDestroyed(state, player, unit, context) {
  if (!unit.isLinkUnit || !context.pilot) return;
  const idx = player.trash.indexOf(context.pilot);
  if (idx !== -1) player.trash.splice(idx, 1);
  sendToZone(player.hand, context.pilot);
}

// --- G-Defenser GD03-079 ---
// data only: "When you rest your Base with one of your Units' effects, you may rest this Unit
// instead" (def.canRestInsteadOfBase, read by management.js's restBaseOrRedirect).

// --- Gundam Kimaris Trooper (Trooper Mode) GD03-080 ---
// [When Linked] Choose 1 (Gjallarhorn) Command card from your trash. Add it to your hand.
function gundamKimarisTrooperWhenLinked(state, player, unit, context) {
  const candidates = player.trash.filter((c) => c.def.type === 'command' && (c.def.traits || []).includes('Gjallarhorn'));
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates[0];
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}

// --- AEU Enact Demonstration Color GD03-081 ---
// data only: "This Unit can only attack during a turn when one of your (Superpower Bloc)/(UN) Units
// is deployed" (def.attackRequiresTraitDeployedThisTurn, read by the AI's runAttacks).

// --- Union Flag GD03-082 ---
// data only: "While you have 2 or more (Superpower Bloc)/(UN) Units in play, this card in your hand
// gets cost -1" (handCostReduction.traits OR-list, added to cost.js's effectiveCost).

// --- AEU Hellion GD03-083 ---
// <Blocker> (data only).

// --- Paptimus Scirocco (R+) GD03-084 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] Choose 1 of your other Units. It gains <Repair
// 2> during this turn (buffs.push repair, read by effects.js's applyRepairAtEndOfTurn). Then, if it
// is a (Jupitris) Unit, draw 1.
function paptimusSciroccoRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function paptimusSciroccoRPlusWhenLinked(state, player, unit, context) {
  const candidates = player.battleArea.filter((u) => u !== unit);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ repair: 2, scope: 'turn' });
  if ((target.def.traits || []).includes('Jupitris')) drawCard(state, player);
}

// === GD03 batch 6 (GD03-085 through GD03-101) ===

// --- Christina Mackenzie GD03-085 (Pilot) ---
// [Burst] Add this card to your hand. "When playing this card from your hand and pairing it with a
// Unit with 'Gundam NT-1' in its card name, play this card as if it has 0 cost" is data-only
// (def.freeCostIfPairUnitNameIncludes, read by cost.js's effectiveCost + heuristic.js's runPairings).
function christinaMackenzieBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Yazan Gable GD03-086 (Pilot) ---
// [Burst] Add this card to your hand. [Attack] Choose 1 of your (Titans) Units whose Lv. is equal
// to or lower than this Unit. It gets AP+1 during this turn.
function yazanGableBurst(state, player, instance) {
  player.hand.push(instance);
}
function yazanGableAttack(state, player, unit, context) {
  const candidates = player.battleArea.filter(
    (u) => (u.def.traits || []).includes('Titans') && (u.def.level || 0) <= (unit.def.level || 0)
  );
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 1, scope: 'turn' });
}

// --- Sarah Zabiarov GD03-087 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] Choose 1 enemy Unit that is Lv.3 or lower. Rest it.
function sarahZabiarovBurst(state, player, instance) {
  player.hand.push(instance);
}
function sarahZabiarovWhenLinked(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// --- Asemu Asuno (R+) GD03-088 (Pilot) ---
// [Burst] Add this card to your hand. "[During Link] If this is an (AGE System) Unit, it gets AP+1
// and <Breach 1>" is data-only (duringLinkApIfTrait / duringLinkBreachIfTrait, read by
// management.js's getAP/getKeywords).
function asemuAsunoRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Bernard Wiseman GD03-089 (Pilot) ---
// [Burst] Add this card to your hand. "Increase this Unit's AP by an amount equal to the number of
// (Cyclops Team) Pilot cards/Command cards with unique names in your trash" -- re-evaluated each
// startOfTurn via the shared grantedStatBonus mechanism (Michaelis GD01-076 shape).
function bernardWisemanBurst(state, player, instance) {
  player.hand.push(instance);
}
function bernardWisemanStartOfTurn(state, player, unit) {
  const names = new Set(
    player.trash
      .filter((c) => (c.def.type === 'pilot' || c.def.type === 'command') && (c.def.traits || []).includes('Cyclops Team'))
      .map((c) => c.def.name)
  );
  unit.grantedStatBonus = { ap: names.size };
}

// --- Rau Le Creuset (R+) GD03-091 (Pilot) ---
// [Burst] Add this card to your hand. [When Linked] Choose 1 (ZAFT) Base card from your trash. Add
// it to your hand. Same shape as Gundam Kimaris Trooper GD03-080's whenLinked.
function rauLeCreusetRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function rauLeCreusetRPlusWhenLinked(state, player, unit, context) {
  const candidates = player.trash.filter((c) => c.def.type === 'base' && (c.def.traits || []).includes('ZAFT'));
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}

// --- Carris Nautilus GD03-093 (Pilot) ---
// [Burst] Add this card to your hand. "While no enemy Base is in play, this Unit gets AP+1" --
// same startOfTurn grantedStatBonus shape as Bernard Wiseman above.
function carrisNautilusBurst(state, player, instance) {
  player.hand.push(instance);
}
function carrisNautilusStartOfTurn(state, player, unit) {
  const opponent = opponentOf(state, player);
  unit.grantedStatBonus = { ap: opponent.base ? 0 : 1 };
}

// --- Azee Gurumin GD03-095 (Pilot) ---
// [Burst] Add this card to your hand. [Once per Turn] When this Unit receives effect damage,
// choose 1 enemy Unit. It gets AP-1 during this turn.
function azeeGuruminBurst(state, player, instance) {
  player.hand.push(instance);
}
function azeeGuruminReceivesEffectDamage(state, player, unit, context) {
  if (unit.activationsUsed.azeeGuruminDebuff) return;
  unit.activationsUsed.azeeGuruminDebuff = true;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -1, scope: 'turn' });
}

// --- Jamil Neate GD03-096 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Attack] You may discard 1. If you do, draw 1.
// (Heuristic discard: cheapest hand card, same reasoning as Garrod & Tiffa GD02-094.)
function jamilNeateBurst(state, player, instance) {
  player.hand.push(instance);
}
function jamilNeateAttack(state, player, unit) {
  if (!unit.isLinkUnit) return;
  const discard = [...player.hand].sort((a, b) => (a.def.cost || 0) - (b.def.cost || 0))[0];
  if (!discard) return;
  player.hand.splice(player.hand.indexOf(discard), 1);
  player.trash.push(discard);
  drawCard(state, player);
}

// --- Wistario Afam GD03-097 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Once per Turn] During your turn, when this
// Unit destroys an enemy Unit with battle damage, look at the top 2 cards of your deck and return
// 1 to the top. Place the remaining card into your trash. Same shape as Minerva ST09-010's Deploy
// (heuristic: keep a Unit/Base card on top).
function wistarioAfamBurst(state, player, instance) {
  player.hand.push(instance);
}
function wistarioAfamDestroysEnemy(state, player, unit) {
  if (!unit.isLinkUnit) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  if (unit.activationsUsed.wistarioAfamPeek) return;
  unit.activationsUsed.wistarioAfamPeek = true;
  if (player.deck.length === 0) return;
  const top2 = player.deck.splice(0, 2);
  const keepIdx = top2.findIndex((c) => c.def.type === 'unit' || c.def.type === 'base');
  const keep = top2.splice(keepIdx === -1 ? 0 : keepIdx, 1)[0];
  player.deck.unshift(keep);
  for (const c of top2) player.trash.push(c);
}

// --- Graham Aker (R+) GD03-098 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] When this rested Unit is set as active by an
// effect, choose 1 enemy Unit with 3 or less HP. Return it to its owner's hand.
function grahamAkerRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function grahamAkerRPlusSetActiveByEffect(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Emma Sheen GD03-099 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Destroyed] If a friendly white Base is in
// play, choose 1 enemy Unit whose Lv. is equal to or lower than this Unit. Return it to its
// owner's hand.
function emmaSheenBurst(state, player, instance) {
  player.hand.push(instance);
}
function emmaSheenDestroyed(state, player, unit) {
  if (!unit.isLinkUnit) return;
  if (!player.base || player.base.def.color !== 'white') return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= (unit.def.level || 0));
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Soma Peries GD03-100 (Pilot) ---
// [Burst] Add this card to your hand. [Destroyed] Choose 1 enemy Unit. It gets AP-3 during this turn.
function somaPeriesBurst(state, player, instance) {
  player.hand.push(instance);
}
function somaPeriesDestroyed(state, player) {
  const opponent = opponentOf(state, player);
  const target = opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: -3, scope: 'turn' });
}

// --- A Healthy Curiosity (R+) GD03-101 (Command) ---
// [Main] Draw 1. Then, if there are 2 or more cards with "A Healthy Curiosity" in their card name
// in your trash, choose 1 enemy Unit with 4 or less HP. Rest it.
function aHealthyCuriosityRPlusCommand(state, player, instance, context) {
  drawCard(state, player);
  const count = player.trash.filter((c) => (c.def.name || '').includes('A Healthy Curiosity')).length;
  if (count < 2) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.rested = true;
}

// ==== GD03 batch 7 (GD03-102 through GD03-116) ====================================================

// --- Privileged Position GD03-102 (Command) ---
// [Burst] Draw 1. [Action] Choose 1 of your (Titans) Link Units battling an enemy Unit. Set it as
// active. Action-timing keyed to the current battle -- reads context.attacker/context.defender
// directly, same "call it explicitly" convention as Heart Set on Revenge GD02-118.
function privilegedPositionBurst(state, player) {
  drawCard(state, player);
}
function privilegedPositionCommand(state, player, instance, context) {
  const inBattle = [context && context.attacker, context && context.defender].filter(Boolean);
  const target = inBattle.find(
    (u) => player.battleArea.includes(u) && u.isLinkUnit && (u.def.traits || []).includes('Titans')
  );
  if (target) setActiveByEffect(state, player, target);
}

// --- Field Directive GD03-103 (Command) ---
// [Burst] Choose 1 enemy Unit with 2 or less HP. Rest it. [Main] If 3 or more enemy Units are in
// play, choose 1 rested enemy Unit. Deal 2 damage to it.
function fieldDirectiveBurst(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 2);
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) restEnemyByEffect(state, player, opponent, target);
}
function fieldDirectiveCommand(state, player) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length < 3) return;
  const candidates = opponent.battleArea.filter((u) => u.rested);
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealEffectDamage(state, player, opponent, target, 2);
  destroyAndFireEffect(state, opponent, target);
}

// --- Reccoa's Shadow GD03-104 (Command; pairable as Pilot [Reccoa Londe]) ---
// [Main] / [Action] Choose 1 enemy Unit with 3 or less HP. Rest it. If a friendly (Jupitris) Link
// Unit is in play, choose 1 to 2 enemy Units with 3 or less HP instead.
function reccoasShadowCommand(state, player) {
  const opponent = opponentOf(state, player);
  const hasJupitrisLink = player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('Jupitris'));
  const count = hasJupitrisLink ? 2 : 1;
  const candidates = opponent.battleArea
    .filter((u) => getRemainingHP(u) <= 3)
    .sort((a, b) => Number(a.rested) - Number(b.rested) || getAP(b) - getAP(a));
  for (const t of candidates.slice(0, count)) restEnemyByEffect(state, player, opponent, t);
}

// --- Bridge Crew (R+) GD03-105 (Command) ---
// [Burst] Add this card to your hand. [Main] Choose 1 friendly Unit. During this turn, it may choose
// an active enemy Unit that has no Pilot paired with it as an attack target (activeTargetNoPilot
// buff family, same shape as the activeTargetAPThreshold family read in heuristic.js).
function bridgeCrewRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function bridgeCrewRPlusCommand(state, player) {
  const target = player.battleArea.filter((u) => u.def.type === 'unit').sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ activeTargetNoPilot: true, scope: 'turn' });
}

// --- M.A.V. Tactics GD03-106 (Command) ---
// [Main] Deploy 1 rested [GQuuuuuuX (Omega Psycommu)] ((Clan) AP3/HP2) Unit token and 1 rested [Red
// Gundam] ((Clan) AP2/HP3) Unit token.
const GQUUUUUUX_OMEGA_PSYCOMMU_TOKEN = Object.freeze({
  number: 'TOKEN-GQUUUUUUX-OMEGA', name: 'GQuuuuuuX (Omega Psycommu)', type: 'unit', color: 'green',
  traits: ['Clan'], ap: 3, hp: 2, isToken: true
});
const RED_GUNDAM_TOKEN = Object.freeze({
  number: 'TOKEN-RED-GUNDAM', name: 'Red Gundam', type: 'unit', color: 'green', traits: ['Clan'], ap: 2, hp: 3, isToken: true
});
function mavTacticsCommand(state, player) {
  const t1 = deployUnit(state, player, GQUUUUUUX_OMEGA_PSYCOMMU_TOKEN);
  t1.rested = true;
  const t2 = deployUnit(state, player, RED_GUNDAM_TOKEN);
  t2.rested = true;
}

// --- Over the River and Through the Woods GD03-107 (Command; pairable as Pilot [Hardie Steiner]) ---
// [Main] Choose 1 enemy Unit that is Lv.5 or lower. Deal damage to it equal to the number of
// friendly Unit tokens in play.
function overTheRiverAndThroughTheWoodsCommand(state, player) {
  const tokenCount = player.battleArea.filter((u) => u.def.isToken).length;
  if (tokenCount === 0) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 5);
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealEffectDamage(state, player, opponent, target, tokenCount);
  destroyAndFireEffect(state, opponent, target);
}

// --- How Many Miles to the Battlefield? GD03-108 (Command; pairable as Pilot [Gabriel Ramirez Garcia]) ---
// [Main] Deploy 1 [Hy-Gogg] ((Cyclops Team) AP2/HP1) Unit token.
const HY_GOGG_TOKEN = Object.freeze({
  number: 'TOKEN-HY-GOGG', name: 'Hy-Gogg', type: 'unit', color: 'green', traits: ['Cyclops Team'], ap: 2, hp: 1, isToken: true
});
function howManyMilesToTheBattlefieldCommand(state, player) {
  deployUnit(state, player, HY_GOGG_TOKEN);
}

// --- Eliminate Target GD03-110 (Command) ---
// [Main] / [Action] Choose 1 Pilot paired with an enemy Unit that is Lv.5 or lower. Destroy it (the
// Pilot alone -- the Unit itself stays in play, unpaired).
function eliminateTargetCommand(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.pilot && (u.def.level || 0) <= 5);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  const pilot = target.pilot;
  target.pilot = null;
  sendToZone(opponent.trash, pilot);
}

// --- Infiltrator Present GD03-111 (Command; pairable as Pilot [Emeralda Zubin]) ---
// [Main] / [Action] Choose 1 friendly (Mafty) Unit. It gets AP+3 during this turn.
function infiltratorPresentCommand(state, player) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Mafty'));
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 3, scope: 'turn' });
}

// --- Warped Intent GD03-112 (Command) ---
// [Burst] Add this card to your hand. [Main] / [Action] During this turn, all Units paired with a
// Pilot get AP+2. Printed text has no "friendly"/"enemy" qualifier, so it's applied to both sides
// literally as written.
function warpedIntentBurst(state, player, instance) {
  player.hand.push(instance);
}
function warpedIntentCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  for (const u of [...player.battleArea, ...opponent.battleArea]) {
    if (u.pilot) u.buffs.push({ ap: 2, scope: 'turn' });
  }
}

// --- Human Karma GD03-113 (Command) ---
// [Main] / [Action] Choose 1 active friendly Unit. Rest it. If you do, choose 1 enemy Unit whose
// Lv. is equal to or lower than the Unit rested with this ability. Deal 3 damage to it.
function humanKarmaCommand(state, player) {
  const source = player.battleArea.filter((u) => !u.rested).sort((a, b) => (b.def.level || 0) - (a.def.level || 0))[0];
  if (!source) return;
  source.rested = true;
  const opponent = opponentOf(state, player);
  const eligible = opponent.battleArea.filter((u) => (u.def.level || 0) <= (source.def.level || 0));
  const target = eligible.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealEffectDamage(state, player, opponent, target, 3);
  destroyAndFireEffect(state, opponent, target);
}

// --- Look of Determination (R+) GD03-114 (Command) ---
// [Burst] Activate this card's [Action]. [Action] Choose 1 active enemy Unit that is Lv.2 or lower.
// Destroy it. If there are 10 or more cards in your trash, choose 1 active enemy Unit that is Lv.4
// or lower instead. Same direct-destroy-outside-battle shape as Gundam Flauros (Ryusei-Go) GD05-060.
function lookOfDeterminationCommand(state, player) {
  const opponent = opponentOf(state, player);
  const cap = player.trash.length >= 10 ? 4 : 2;
  const candidates = opponent.battleArea.filter((u) => !u.rested && (u.def.level || 0) <= cap && !isImmuneToEffectDestroy(u));
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Distant Reunion GD03-115 (Command; pairable as Pilot [Yurin L'Ciel]) ---
// [Action] Choose 1 friendly Unit paired with an (X-Rounder) Pilot. It can't receive battle damage
// from enemy Units with 2 or less AP during this battle. If you are Lv.7 or higher, it can't receive
// battle damage from enemy Units with 5 or less AP instead (lowAPEnemyDamageImmuneCap buff, new
// AP-capped sibling of combat.js's lowHPEnemyDamageImmuneCap).
function distantReunionCommand(state, player) {
  const target = player.battleArea.find((u) => u.pilot && (u.pilot.def.traits || []).includes('X-Rounder'));
  if (!target) return;
  const cap = player.resourceArea.length >= 7 ? 5 : 2;
  target.buffs.push({ lowAPEnemyDamageImmuneCap: cap, scope: 'battle' });
}

// --- Towards Destiny GD03-116 (Command) ---
// [Main] / [Action] Choose 1 friendly (Vagan) Unit and 1 enemy Unit. Deal 2 damage to them.
function towardsDestinyCommand(state, player) {
  const opponent = opponentOf(state, player);
  const friendlyTarget = player.battleArea
    .filter((u) => (u.def.traits || []).includes('Vagan'))
    .sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  const enemyTarget = opponent.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!friendlyTarget || !enemyTarget) return;
  dealEffectDamage(state, player, player, friendlyTarget, 2);
  destroyAndFireEffect(state, player, friendlyTarget);
  dealEffectDamage(state, player, opponent, enemyTarget, 2);
  destroyAndFireEffect(state, opponent, enemyTarget);
}

// ==== GD03 batch 8 (GD03-117 through GD03-132, excl. GD03-125 already present) =====================

// --- Orga's Order GD03-117 (Command) ---
// [Main] If 1 to 4 enemy Units are in play, deploy 1 [Graze Custom] ((Tekkadan) AP2/HP2) Unit token.
// If 5 or more are in play, deploy 1 [Gundam Barbatos 4th Form] ((Tekkadan) AP4/HP4) Unit token.
const GRAZE_CUSTOM_TOKEN = Object.freeze({
  number: 'TOKEN-GRAZE-CUSTOM', name: 'Graze Custom', type: 'unit', color: 'purple', traits: ['Tekkadan'], ap: 2, hp: 2, isToken: true
});
const GUNDAM_BARBATOS_4TH_FORM_TOKEN = Object.freeze({
  number: 'TOKEN-BARBATOS-4TH-FORM', name: 'Gundam Barbatos 4th Form', type: 'unit', color: 'purple', traits: ['Tekkadan'], ap: 4, hp: 4, isToken: true
});
function orgasOrderCommand(state, player) {
  const opponent = opponentOf(state, player);
  const count = opponent.battleArea.length;
  if (count === 0) return;
  deployUnit(state, player, count >= 5 ? GUNDAM_BARBATOS_4TH_FORM_TOKEN : GRAZE_CUSTOM_TOKEN);
}

// --- Awakened Potential (R+) GD03-118 (Command) ---
// [Burst] Add this card to your hand. [Action] Choose 1 rested enemy Unit that is Lv.4 or lower.
// Return it to its owner's hand. Then, if there are 2 or more cards with "Awakened Potential" in
// their card name in your trash, choose 1 friendly Unit. It gains <Blocker> during this turn. Same
// self-name-count-in-trash shape as Improved Technique GD03-109.
function awakenedPotentialRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function awakenedPotentialRPlusCommand(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested && (u.def.level || 0) <= 4);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
  const copiesInTrash = player.trash.filter((c) => (c.def.name || '').includes('Awakened Potential')).length;
  if (copiesInTrash < 2) return;
  const blockerTarget = player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (blockerTarget) blockerTarget.buffs.push({ keyword: 'blocker', scope: 'turn' });
}

// --- Awkward Approach GD03-119 (Command) ---
// [Main] Choose 1 rested friendly Base. Set it as active. If you do, all enemy Units get AP-1
// during this turn.
function awkwardApproachCommand(state, player) {
  if (!player.base || !player.base.rested) return;
  setActiveByEffect(state, player, player.base);
  const opponent = opponentOf(state, player);
  for (const u of opponent.battleArea) u.buffs.push({ ap: -1, scope: 'turn' });
}

// --- Immortal Colasour GD03-120 (Command; pairable as Pilot [Patrick Colasour]) ---
// [Main] During this turn, if a friendly (Superpower Bloc)/(UN) Unit destroys an enemy Unit with
// battle damage, choose 1 rested friendly (Superpower Bloc)/(UN) Unit. Set it as active. It can't
// attack during this turn. A delayed reaction from a Command that's trashed the instant it resolves,
// so it sets a player-level turn-scoped flag (read by combat.js's fireDestroysEnemy, cleared by
// effects.js's clearTurnBuffs) instead of living on any surviving instance.
function immortalColasourCommand(state, player) {
  player.onKillSetActiveTraits = ['Superpower Bloc', 'UN'];
}

// --- Unheralded Attack GD03-121 (Command; pairable as Pilot [Katz Kobayashi]) ---
// [Action] Choose 1 friendly Base and 1 enemy Unit with 3 or less HP. Rest them.
function unheraldedAttackCommand(state, player) {
  if (!player.base || player.base.rested) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  restBaseOrRedirect(player);
  restEnemyByEffect(state, player, opponent, target);
}

// --- Veteran Tactics GD03-122 (Command; pairable as Pilot [Sergei Smirnov]) ---
// [Action] Choose 1 enemy Unit that is Lv.3 or lower. Return it to its owner's hand.
function veteranTacticsCommand(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Jupitris GD03-123 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if a friendly
// (Jupitris) Unit is in play, choose 1 enemy Unit that is Lv.3 or lower. Rest it.
function jupitrisBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function jupitrisDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('Jupitris'))) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) restEnemyByEffect(state, player, opponent, target);
}

// --- Ribo Colony GD03-124 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Once per Turn] When you
// pair a Pilot that is Lv.3 or lower with one of your Units, choose 1 enemy Unit with 3 or less HP.
// Rest it. First consumer of the pre-existing allyPaired broadcast fired from pairPilot (actions.js).
function riboColonyBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function riboColonyDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}
function riboColonyAllyPaired(state, player, instance, context) {
  if (instance.activationsUsed.restEnemy) return;
  if ((context.pilot.def.level || 0) > 3) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  restEnemyByEffect(state, player, opponent, target);
  instance.activationsUsed.restEnemy = true;
}

// --- Cyclops Team GD03-126 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. All friendly Unit tokens
// get AP+1 during your opponent's turn -- live-toggled grantedStatBonus re-evaluated each
// startOfTurn, same shape as Gundam X (LR+) GD02-053's team aura, scoped to tokens instead of a trait.
function cyclopsTeamBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function cyclopsTeamDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}
function cyclopsTeamStartOfTurn(state, player) {
  const isOpponentTurn = state.players[state.activePlayerIdx] !== player;
  for (const u of player.battleArea) {
    if (!u.def.isToken) continue;
    u.grantedStatBonus = isOpponentTurn ? { ap: 1 } : {};
  }
}

// --- Jachin Due GD03-127 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 friendly
// (ZAFT) Unit. It gets AP+3 during this turn.
function jachinDueBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function jachinDueDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  const target = player.battleArea.filter((u) => (u.def.traits || []).includes('ZAFT')).sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 3, scope: 'turn' });
}

// --- Doritea GD03-128 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Once per Turn] During
// your opponent's turn, when one of your Units is rested by one of your opponent's effects, choose
// 1 enemy Unit. Deal 1 damage to it. The payoff for restEnemyByEffect's friendlyUnitRestedByEnemyEffect
// broadcast added in GD03 batch 7 specifically for this card.
function doriteaBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function doriteaDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}
function doriteaFriendlyUnitRestedByEnemyEffect(state, player, instance) {
  if (instance.activationsUsed.pingEnemy) return;
  if (state.players[state.activePlayerIdx] === player) return;
  const opponent = opponentOf(state, player);
  const target = opponent.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealEffectDamage(state, player, opponent, target, 1);
  destroyAndFireEffect(state, opponent, target);
  instance.activationsUsed.pingEnemy = true;
}

// --- Hotarubi GD03-129 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. During your turn, when one
// of your friendly (Tekkadan)/(Teiwaz) Units receives effect damage, you may rest this Base. If you
// do, place the top card of your deck into your trash. Reuses the pre-existing
// friendlyUnitReceivesEffectDamage broadcast (Gundam Gusion Rebake Full City GD03-053 precedent) --
// extended in effects.js's dealEffectDamage to include player.base since this is the first Base to
// listen for it.
function hotarubiBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function hotarubiDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}
function hotarubiFriendlyUnitReceivesEffectDamage(state, player, instance, context) {
  if (instance.rested) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  const traits = context.target.def.traits || [];
  if (!traits.includes('Tekkadan') && !traits.includes('Teiwaz')) return;
  instance.rested = true;
  if (player.deck.length > 0) player.trash.push(player.deck.shift());
}

// --- Downes GD03-130 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn,
// you may choose 1 (Vagan) Unit card that is Lv.4 or lower from your trash. Pay its cost to deploy
// it. Same trash-pay-cost-deploy shape as Awakened Power GD02-110 / Destiny Gundam GD04-050.
function downesBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function downesDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  if (state.players[state.activePlayerIdx] !== player) return;
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Vagan') && (c.def.level || 0) <= 4
      && canAfford(player, c.def, { fromTrash: true })
  );
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  payCost(player, target.def, { fromTrash: true });
  player.trash.splice(player.trash.indexOf(target), 1);
  deployUnit(state, player, target.def, undefined, { fromTrash: true });
}

// --- Eternal GD03-131 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if you have 2 or more
// (Triple Ship Alliance) Units in play, choose 1 enemy Unit that is Lv.4 or lower. Return it to its
// owner's hand.
function eternalBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function eternalDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  const tripleShipCount = player.battleArea.filter((u) => (u.def.traits || []).includes('Triple Ship Alliance')).length;
  if (tripleShipCount < 2) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Radish GD03-132 (Base) ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. [Destroyed] If you have an
// (AEUG) Link Unit in play, choose 1 enemy Unit with 4 or less HP. Rest it.
function radishBurst(state, player, instance) {
  becomeBase(state, player, instance);
}
function radishDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
}
function radishDestroyed(state, player, instance) {
  if (!player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('AEUG'))) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) restEnemyByEffect(state, player, opponent, target);
}

// --- GD04 batch 1 (GD04-004 through GD04-023, excl. GD04-001/002/003/005/006/008/010/011/012/014/016/017 which are vanilla or data-only) ---

// --- Psycho Gundam Mk-II GD04-004 ---
// [Repair 2] (data, see effects.js). [Once per Turn] When you pair a (Cyber-Newtype) Pilot with one
// of your blue Units, draw 1 -- reacts to ANY pairing the controller makes (not just its own), so it
// listens on the allyPaired broadcast pairPilot (actions.js) already fires to the whole field.
function psychoGundamMk2AllyPaired(state, player, instance, context) {
  if (instance.activationsUsed.drawOnPair) return;
  if (!(context.pilot.def.traits || []).includes('Cyber-Newtype')) return;
  if (context.pairedUnit.def.color !== 'blue') return;
  drawCard(state, player);
  instance.activationsUsed.drawOnPair = true;
}

// --- Victory Gundam Hexa GD04-007 ---
// [During Pair] [Attack] Deploy 1 [Parts] Unit token -- reuses the exact same PARTS_TOKEN Üso Ewin
// GD04-081 / Reineforce Jr. GD04-121 already deploy (identical (League Militaire) AP1/HP1 stats).
function victoryGundamHexaAttack(state, player, instance) {
  if (!instance.pilot) return;
  deployUnit(state, player, PARTS_TOKEN);
}

// --- Guncannon (108) & Guncannon (109) (R+) GD04-009 ---
// [When Linked] Choose 1 of your other (White Base Team) Units that is Lv.4 or higher. Set it as active.
function guncannon108109WhenLinked(state, player, instance) {
  const candidates = player.battleArea.filter(
    (u) => u !== instance && u.rested && (u.def.traits || []).includes('White Base Team') && (u.def.level || 0) >= 4
  );
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) setActiveByEffect(state, player, target);
}

// --- Core Fighter GD04-013 ---
// While this Unit is rested, all your (League Militaire) Unit tokens gain <Blocker> -- a team-wide
// aura targeting OTHER units (not itself), same startOfTurn-recompute shape Cyclops Team GD03-126 and
// Gaelio's Schwalbe Graze GD02-082 already use for live-toggled grants.
function coreFighterStartOfTurn(state, player, instance) {
  for (const u of player.battleArea) {
    if (!u.def.isToken || !(u.def.traits || []).includes('League Militaire')) continue;
    u.grantedKeywords.blocker = instance.rested;
  }
}

// --- Gundam Pharact (LR+) GD04-018 ---
// [Breach 5] (data). [Once per Turn] During your turn, when one of your other (Academy) Units
// receives damage from an enemy, place 1 EX Resource.
function gundamPharactFriendlyUnitReceivesEnemyDamage(state, player, instance, context) {
  if (instance.activationsUsed.placeExOnDamage) return;
  if (context.target === instance) return;
  if (!(context.target.def.traits || []).includes('Academy')) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  placeExResource(state, player);
  instance.activationsUsed.placeExOnDamage = true;
}

// --- GN Armor Type-D (Trans-Am) GD04-019 ---
// [Breach 3] (data). [Destroyed] Look at the top 3 cards of your deck. You may reveal 1 (CB) Unit
// card that is Lv.5 or lower among them and add it to your hand. Return the remaining cards randomly
// to the bottom of your deck -- same shape as Re-GZ GD05-019.
function gnArmorTypeDTransAmDestroyed(state, player) {
  const top3 = player.deck.splice(0, 3);
  const matchIdx = top3.findIndex(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('CB') && (c.def.level || 0) <= 5
  );
  if (matchIdx !== -1) {
    const [chosen] = top3.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// --- Gundam Lfrith Ur GD04-020 ---
// [Once per Turn] During your turn, when you play and activate a (Dawn of Fold) Command card using
// an EX Resource, draw 1 -- listens on the friendlyPlaysCommand broadcast playCommand (actions.js)
// fires to the whole field.
function gundamLfrithUrFriendlyPlaysCommand(state, player, instance, context) {
  if (instance.activationsUsed.drawOnCommand) return;
  if (!context.usedExResource) return;
  if (!(context.commandInstance.def.traits || []).includes('Dawn of Fold')) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  drawCard(state, player);
  instance.activationsUsed.drawOnCommand = true;
}

// --- Gundam Lfrith Thorn (R+) GD04-021 ---
// [Breach 3] (data). During your turn, when you play and activate a (Dawn of Fold) Command card
// using an EX Resource, you may pair that card from your trash with one of your Units with "Gundam
// Lfrith" in its card name -- same friendlyPlaysCommand broadcast as Lfrith Ur above, then
// pairPilotFromTrash (actions.js, Cyclone Punch GD05-121 precedent) on the just-trashed instance.
function gundamLfrithThornFriendlyPlaysCommand(state, player, instance, context) {
  if (!context.usedExResource) return;
  if (!(context.commandInstance.def.traits || []).includes('Dawn of Fold')) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  const target = player.battleArea.find((u) => !u.pilot && (u.def.name || '').includes('Gundam Lfrith'));
  if (!target) return;
  pairPilotFromTrash(state, player, target, context.commandInstance);
}

// --- Kikeroga (MS Mode) (GQ) (R+) GD04-022 ---
// All your Unit tokens gain <Breach 1> -- team-wide token aura, same startOfTurn-recompute shape as
// Core Fighter above, just unconditional instead of gated on being rested. [During Link] All Units
// that are Lv.3 or lower other than Unit tokens are deployed rested -- data-only (deployRestedAuraLvCap),
// read directly by deployUnit (actions.js) against both players' battle areas.
function kikerogaMsModeStartOfTurn(state, player) {
  for (const u of player.battleArea) {
    if (!u.def.isToken) continue;
    u.grantedKeywords.breach = 1;
  }
}

// --- Gundam Kyrios (Tail Booster) GD04-023 ---
// [Deploy] Choose 1 of your Units paired with a (Super Soldier) Pilot. During this turn, it may
// choose an active enemy Unit that is Lv.4 or lower as its attack target -- the activeTargetLevelCap
// buff shape (heuristic.js) Wing Gundam ST02-001 / Athrun Zala ST04-011 already use.
function gundamKyriosTailBoosterDeploy(state, player) {
  const target = player.battleArea.find((u) => u.pilot && (u.pilot.def.traits || []).includes('Super Soldier'));
  if (!target) return;
  target.buffs.push({ activeTargetLevelCap: 4, scope: 'turn' });
}

// === GD04 batch 2 (GD04-024 through GD04-039, excl. GD04-034 already present, GD04-027/031/032 vanilla) ===

// --- Gundam Aerial Rebuild GD04-024 ---
// [Deploy] Look at the top 3 cards of your deck. You may reveal 1 (Academy) Unit card/Command card
// among them and add it to your hand. Return the remaining cards randomly to the bottom of your deck
// (Char's Zaku II ST03-006 dig-and-shuffle-back pattern, reused directly).
function gundamAerialRebuildDeploy(state, player) {
  const top3 = player.deck.splice(0, 3);
  const idx = top3.findIndex((c) => (c.def.type === 'unit' || c.def.type === 'command') && (c.def.traits || []).includes('Academy'));
  if (idx !== -1) {
    const [chosen] = top3.splice(idx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// --- Gundvolva GD04-025 ---
// [Destroyed] During your turn, if you have another (Dawn of Fold) Unit in play, place 1 EX Resource
// (destroyCard has already removed Gundvolva itself from battleArea by the time this fires, so no
// self-exclusion filter is needed).
function gundvolvaDestroyed(state, player) {
  if (state.players[state.activePlayerIdx] !== player) return;
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('Dawn of Fold'))) return;
  placeExResource(state, player);
}

// --- Garma's Dopp GD04-026 ---
// [Deploy] Look at the top card of your deck. Return it to the top of your deck or place it into
// your trash (Kayra's Re-GZ GD05-... keep-or-bury heuristic, reused with trash as the bury target).
function garmasDoppDeploy(state, player) {
  if (player.deck.length === 0) return;
  const top = player.deck[0];
  const worthKeeping = top.def.type === 'unit' || top.def.type === 'base';
  if (!worthKeeping) {
    player.deck.shift();
    player.trash.push(top);
  }
}

// --- Zakrello GD04-028 ---
// [Attack] Choose 1 active enemy Unit. It gains <Blocker> during this turn. (Heuristic: the weakest
// active enemy Unit, least value if the opponent actually uses the redirect.)
function zakrelloAttack(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => !u.rested);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(a) - getAP(b))[0];
  if (target) target.buffs.push({ keyword: 'blocker', scope: 'turn' });
}

// --- Gundam Dynames (GN Full Shield) GD04-029 ---
// [Once per Turn] If you have a (CB) Pilot in play, when this Unit receives damage from an enemy,
// reduce it by 1 -- data-only (oncePerTurnEnemyDamageReduction), read by dealDamage (management.js).

// --- Chuchu's Demi Trainer GD04-030 ---
// [Attack] Choose 1 of your other (Academy) Units. During this turn, it may choose an active enemy
// Unit that is Lv.3 or lower as its attack target (activeTargetLevelCap buff family, reused directly).
function chuchusDemiTrainerGD04030Attack(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u !== instance && (u.def.traits || []).includes('Academy'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ activeTargetLevelCap: 3, scope: 'turn' });
}

/**
 * Neo Zeong (LR+) GD04-033's "[During Link] All your Units gain (Neo Zeon)" -- rather than a full
 * generic trait-injection system (no other implemented card reads a live/granted trait), this narrow
 * helper covers the one interaction that actually matters: Neo Zeong's own "one of your (Neo Zeon)
 * Units is deployed" trigger below, so a non-Neo-Zeon Unit deployed while Neo Zeong is linked still
 * counts.
 */
function hasEffectiveTrait(instance, player, trait) {
  if ((instance.def.traits || []).includes(trait)) return true;
  return player.battleArea.some((u) => u.isLinkUnit && u.def.duringLinkGrantsTraitToAllFriendly === trait);
}
// --- Neo Zeong (LR+) GD04-033 ---
// "When this Unit or one of your (Neo Zeon) Units is deployed, choose 1 enemy Unit. Deal 3 damage to
// it." A team-wide reaction to ANY qualifying Unit deploy (friendlyUnitDeployed broadcast, actions.js).
function neoZeongLRPlusFriendlyUnitDeployed(state, player, instance, context) {
  if (context.deployedUnit !== instance && !hasEffectiveTrait(context.deployedUnit, player, 'Neo Zeon')) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 3);
  destroyAndFireEffect(state, opponent, target);
}

// --- Xi Gundam GD04-035 ---
// [Deploy] Choose 1 of your (Mafty) Units. When it destroys an enemy Unit with battle damage during
// this turn, if you have 3 or less cards in your hand, draw 1 (onKillDrawIfHandAtMost buff, same
// scope/timing as the existing unconditional onKillDraw family -- see fireDestroysEnemy, combat.js).
function xiGundamDeploy(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Mafty'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ onKillDrawIfHandAtMost: 3, scope: 'turn' });
}

// --- Gundam Throne Eins (R+) GD04-036 ---
// [Deploy] You may choose 1 to 2 of your other active (CB) Units. Rest them. If you do, deal damage
// equal to the number of Units rested with this effect to all enemy Units that are Lv.6 or lower
// ("choose 1 to 2" default-slice pattern, reused directly).
function gundamThroneEinsDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = player.battleArea.filter((u) => u !== instance && !u.rested && (u.def.traits || []).includes('CB'));
  const chosen = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  if (chosen.length === 0) return;
  for (const u of chosen) u.rested = true;
  for (const u of opponent.battleArea.filter((u) => (u.def.level || 0) <= 6)) {
    dealDamage(u, chosen.length);
    destroyAndFireEffect(state, opponent, u);
  }
}

// --- Gundam Kyrios (Trans-Am) GD04-037 ---
// "While you have a red (Super Soldier) Pilot in play, this Unit gains <First Strike>. While you
// have a green (Super Soldier) Pilot in play, this Unit gains <Breach 3>." No player context exists
// inside getKeywords (management.js), so -- same as Cyclops Team GD03-126 / Kikeroga GD04-022 -- this
// is recomputed at the start of each turn into grantedKeywords rather than live-merged.
function gundamKyriosTransAmStartOfTurn(state, player, instance) {
  const hasRedSS = player.battleArea.some((u) => u.pilot && u.pilot.def.color === 'red' && (u.pilot.def.traits || []).includes('Super Soldier'));
  const hasGreenSS = player.battleArea.some((u) => u.pilot && u.pilot.def.color === 'green' && (u.pilot.def.traits || []).includes('Super Soldier'));
  instance.grantedKeywords.firstStrike = hasRedSS;
  instance.grantedKeywords.breach = hasGreenSS ? 3 : 0;
}

// --- Gundam Exia (GD04-038) ---
// [Deploy] If 2 or more enemy Units are in play, choose 1 enemy Unit that is Lv.2 or lower. Deal 2
// damage to it.
function gundamExia038Deploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length < 2) return;
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealDamage(target, 2);
  destroyAndFireEffect(state, opponent, target);
}

// --- Rozen Zulu GD04-039 ---
// Cost -4 while 8+ (Neo Zeon) cards in trash -- data-only (trashCostReduction.trait, cost.js).
// [Deploy] Choose 1 enemy Unit. Deal 1 damage to it. If it has <Repair>, deal 3 damage instead.
function rozenZuluDeploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  const amount = getKeywords(target).repair ? 3 : 1;
  dealDamage(target, amount);
  destroyAndFireEffect(state, opponentOf(state, player), target);
}

// === GD04 batch 3 (GD04-040 through GD04-055) ==============================

// --- Gundam Throne Drei GD04-041 ---
// [Once per Turn] When this Unit is rested by an effect, set it as active. Hooked to the existing
// restEnemyByEffect chokepoint (effects.js) rather than every `target.rested = true` site in the
// pool -- same forward-only scoping as Doritea GD03-128's own trigger, which restEnemyByEffect was
// built for; "an effect" collapses to "an opponent's effect" since a card resting its own Units is
// always a chosen cost, not something rested BY an effect in the rules' sense.
function gundamThroneDreiRestedByEnemyEffect(state, player, instance) {
  if (instance.activationsUsed.setActiveOnRest) return;
  instance.activationsUsed.setActiveOnRest = true;
  instance.rested = false;
}

// --- Psycho Gundam (GQ) (U+) GD04-042 ---
// [During Link][Once per Turn] When damage from one of your Units paired with a (Cyber-Newtype)
// Pilot destroys an enemy shield area card, choose 1 enemy Unit with 5 or less AP. Deal 2 damage to
// it. Reuses the existing friendlyUnitDestroysShield broadcast (combat.js's fireDestroysShield).
function psychoGundamGQUPlusFriendlyUnitDestroysShield(state, player, instance, context) {
  if (!instance.isLinkUnit) return;
  if (instance.activationsUsed.shieldKillDamage) return;
  const attacker = context.attacker;
  if (!attacker.pilot || !(attacker.pilot.def.traits || []).includes('Cyber-Newtype')) return;
  instance.activationsUsed.shieldKillDamage = true;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  dealDamage(target, 2, { isEnemyDamage: true, player: opponent });
  destroyAndFireEffect(state, opponent, target);
}

// --- Zssa (Sleeves) GD04-043 ---
// [Deploy] Choose 1 enemy Base. Deal 1 damage to it.
function zssaSleevesDeploy(state, player) {
  const opponent = opponentOf(state, player);
  if (!opponent.base) return;
  dealDamage(opponent.base, 1, { isEnemyDamage: true, player: opponent });
  destroyAndFireEffect(state, opponent, opponent.base);
}

// --- Gadeel GD04-044 ---
// [Attack] If you are attacking a damaged enemy Unit, this Unit gains <Breach 3> during this battle.
function gadeelAttack(state, player, unit, context) {
  if (context.target && context.target.type === 'unit' && context.target.instance.damage > 0) {
    unit.buffs.push({ breach: 3, scope: 'battle' });
  }
}

// --- Gundam Throne Zwei GD04-045 ---
// [When Linked] Choose 1 of your (CB) Units. During this turn, it may choose a damaged active enemy
// Unit as its attack target (new activeTargetIfDamaged buff, same family as activeTargetLevelCap/
// activeTargetAPCap/activeTargetNoPilot in heuristic.js's chooseAttackTarget).
function gundamThroneZweiWhenLinked(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('CB'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ activeTargetIfDamaged: true, scope: 'turn' });
}

// --- Gundam Dynames GD04-046 ---
// [Deploy] You may rest this Unit. If you do, choose 1 enemy Unit that is Lv.3 or lower. Deal 2
// damage to it. Heuristic: pay the optional rest cost whenever a legal target exists, same
// "trigger the bonus whenever it's live" convention as the discard-cost Deploys elsewhere.
function gundamDynamesDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  if (candidates.length === 0) return;
  instance.rested = true;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(target, 2, { isEnemyDamage: true, player: opponent });
  destroyAndFireEffect(state, opponent, target);
}

// --- Gundam DX (LR+) GD04-049 ---
// <Suppression> (data). [During Pair][Attack] If you are attacking the enemy player, you may choose
// 7 (Vulture) cards from your trash. Exile them. If you do, choose 1 enemy Unit/Base that is Lv.8 or
// lower. Destroy it. Same exile-from-trash shape as Zedas R GD03-059, scaled to a fixed 7-card cost.
function gundamDXLRPlusAttack(state, player, unit, context) {
  if (!unit.pilot) return;
  if (!context.target || context.target.type !== 'player') return;
  const vultureCards = player.trash.filter((c) => (c.def.traits || []).includes('Vulture'));
  if (vultureCards.length < 7) return;
  const toExile = context.hooks && context.hooks.chooseCards
    ? context.hooks.chooseCards(vultureCards, 7)
    : vultureCards.slice(0, 7);
  for (const c of toExile) {
    player.trash.splice(player.trash.indexOf(c), 1);
    player.removal.push(c);
  }
  const opponent = opponentOf(state, player);
  const candidates = [...opponent.battleArea, opponent.base].filter(Boolean).filter((u) => (u.def.level || 0) <= 8);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyCard(state, opponent, target);
  fireCardEffect(state, opponent, target, 'destroyed', { wasPaired: !!target.pilot });
}

// --- Gundam Leopard Destroy GD04-052 ---
// [During Pair][Attack] You may choose 1 enemy Unit. Deal 2 damage to it and this Unit.
function gundamLeopardDestroyAttack(state, player, unit, context) {
  if (!unit.pilot) return;
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  dealDamage(target, 2, { isEnemyDamage: true, player: opponent });
  dealDamage(unit, 2);
  destroyAndFireEffect(state, opponent, target);
  destroyAndFireEffect(state, player, unit);
}

// --- Gundam Virtue (Trans-Am) GD04-054 ---
// When this Unit deals battle damage to an enemy Unit, destroy that enemy Unit -- same "top up
// damage to lethal" shape as Gundam Virtue (R+) GD03-052/Gundam Exia Repair GD05-050, letting the
// existing post-damage destroyAndFireEffect call in combat.js do the actual removal exactly once.
function gundamVirtueTransAmDealsBattleDamage(state, player, unit, context) {
  const defender = context.defender;
  if (!defender) return;
  defender.damage = getHP(defender);
}

// === GD04 batch 4 (GD04-056 through GD04-072) ===

// --- Sword Impulse Gundam GD04-056 ---
// [Deploy] Deal 1 damage to this Unit. If you do, choose 1 enemy Unit with 3 or less AP. Rest it.
function swordImpulseGundamGD04Deploy(state, player, instance, context) {
  dealDamage(instance, 1);
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 3);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  restEnemyByEffect(state, player, opponent, target);
}

// --- Gundam Nadleeh GD04-057 ---
// [Deploy] Choose 1 enemy Unit that is Lv.6 or lower. During this turn, reduce its AP by an amount
// equal to the number of Unit cards with "Gundam Virtue" in their card names in your trash.
function gundamNadleehDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 6);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  const amount = player.trash.filter((c) => c.def.type === 'unit' && (c.def.name || '').includes('Gundam Virtue')).length;
  reduceEnemyAP(state, player, opponent, target, amount);
}

// --- Jamil's Gundam X GD04-058 ---
// [During Pair(Vulture) Pilot][Destroyed] If it is your turn, return this Unit's paired Pilot to
// its owner's hand -- same "splice out of trash, sendToZone to hand" shape as Unicorn Gundam
// (Unicorn Mode) GD03's destroyed handler.
function jamilsGundamXDestroyed(state, player, instance, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('Vulture')) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  const idx = player.trash.indexOf(pilot);
  if (idx !== -1) player.trash.splice(idx, 1);
  sendToZone(player.hand, pilot);
}

// --- Esperansa GD04-060 ---
// [Deploy] If you deploy this Unit from your trash, draw 1.
function esperansaDeploy(state, player, instance, context) {
  if (!context.fromTrash) return;
  drawCard(state, player);
}

// --- G-Falcon GD04-061 ---
// <Blocker> (data). "This Unit can't attack while there are 6 or less cards in your trash," read via
// def.attackRequiresTrashAtLeast in runAttacks (src/ai/heuristic.js).

// --- GN Armor Type-E GD04-063 ---
// [Deploy] Choose 1 enemy Unit that is Lv.1 or lower or has 1 or less AP. Destroy it.
function gnArmorTypeEDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => ((u.def.level || 0) <= 1 || getAP(u) <= 1) && !isImmuneToEffectDestroy(u));
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  destroyCard(state, opponent, target);
  fireCardEffect(state, opponent, target, 'destroyed', { wasPaired: !!target.pilot });
}

// --- Unicorn Gundam (Awakened) (LR+) GD04-066 ---
// <Suppression> (data). When you activate a Command's [Main]/[Action] effect, choose 1 enemy Unit.
// It gets AP-2 during this turn -- reuses the existing friendlyPlaysCommand broadcast (playCommand,
// src/rules/actions.js) unchanged.
function unicornGundamAwakenedLRPlusFriendlyPlaysCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea;
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  reduceEnemyAP(state, player, opponent, target, 2);
}

// --- Turn A Gundam (LR+) GD04-067 ---
// [ActivateMain][Once per Turn] (1): Choose 1 Unit card with [Repair]/[Breach]/[First Strike]/
// [Support]/[High-Maneuver]/[Suppression]/[Blocker] from any player's trash. During this turn, this
// Unit gets AP+1 and all of those keywords from that Unit card. (Engine-correct, but not wired into
// the AI's runActivations -- same "spending a resource for a judgement call" precedent as
// Archangel ST04-015/Zeta Gundam GD02-069 above; picking the best trash card to copy needs real
// board-state judgement.) Also calls payAbilityCost so Turn A Gundam GD04-069's reactive "paid (1)+
// for one of your other (Militia) Units' effects" trigger can observe this payment.
const TURN_A_GD04067_BOOLEAN_KEYWORDS = ['blocker', 'firstStrike', 'highManeuver', 'suppression'];
function turnAGundamLRPlusActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.copyKeyword) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  const target = context.target;
  if (!target || target.def.type !== 'unit') return false;
  if (!state.players.some((p) => p.trash.includes(target))) return false;
  const kw = target.def.keywords || {};
  const hasCopyableKeyword = TURN_A_GD04067_BOOLEAN_KEYWORDS.some((k) => kw[k]) || kw.repair || kw.breach || kw.support;
  if (!hasCopyableKeyword) return false;
  activeResources[0].rested = true;
  payAbilityCost(state, player, instance, 1);
  instance.activationsUsed.copyKeyword = true;
  instance.buffs.push({ ap: 1, scope: 'turn' });
  for (const k of TURN_A_GD04067_BOOLEAN_KEYWORDS) {
    if (kw[k]) instance.buffs.push({ keyword: k, scope: 'turn' });
  }
  if (kw.repair) instance.buffs.push({ repair: kw.repair, scope: 'turn' });
  if (kw.breach) instance.buffs.push({ breach: kw.breach, scope: 'turn' });
  if (kw.support) instance.buffs.push({ support: kw.support, scope: 'turn' });
  return true;
}

// --- Turn A Gundam GD04-069 ---
// <Blocker> (data). [During Link] At the end of a turn where you have paid (1) or more for one of
// your other (Militia)/(Dianna Counter) Units' effects, choose 1 of your (Militia) Units. Set it as
// active -- reads the payAbilityCost tracking added for this card (src/rules/effects.js).
function turnAGundamGD04069EndOfTurn(state, player, instance, context) {
  if (!instance.isLinkUnit) return;
  const paid = (player.abilityCostsPaidThisTurn || []).some(
    (p) => p.amount >= 1 && p.source !== instance && (p.source.def.traits || []).some((t) => t === 'Militia' || t === 'Dianna Counter')
  );
  if (!paid) return;
  // Only a rested candidate is ever a meaningful choice -- setActiveByEffect is a no-op on an
  // already-active Unit, so the default (no hooks) heuristic restricts to those.
  const candidates = player.battleArea.filter((u) => u.rested && (u.def.traits || []).includes('Militia'));
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  setActiveByEffect(state, player, target);
}

// --- Al-Saachez's AEU Enact Custom Moralia Development Experiment Type GD04-070 ---
// [Deploy] You may pair 1 Pilot card with "Ali al-Saachez" in its card name from your hand with
// this Unit -- same shape as Gundam Mk-II (AEUG) GD02-071's Deploy pairing. Matched against "Ali
// alSaachez" (no hyphen) to stay consistent with the spelling this project already uses for this
// same character's link-condition text (Gundam Throne Zwei GD04-045).
function alSaachezAEUEnactMoraliaDeploy(state, player, instance) {
  const candidates = player.hand.filter((c) => c.def.type === 'pilot' && (c.def.name || '').includes('Ali alSaachez'));
  if (candidates.length === 0) return;
  pairPilot(state, player, instance, candidates[0]);
}

// --- Graham's Union Flag Custom II (GN Flag) (R+) GD04-071 ---
// [Burst] If an enemy (CB) Unit is in play, add this card to your hand.
// [ActivateMain] Choose 1 (Superpower Bloc) card and 1 (UN) card from your trash. Exile them from
// the game. If you do, set this Unit as active. It can't attack during this turn.
function grahamsUnionFlagGNFlagRPlusBurst(state, player, instance) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.some((u) => (u.def.traits || []).includes('CB'))) player.hand.push(instance);
}
function grahamsUnionFlagGNFlagRPlusActivateMain(state, player, instance) {
  const superpowerCandidates = player.trash.filter((c) => (c.def.traits || []).includes('Superpower Bloc'));
  const unCandidates = player.trash.filter((c) => (c.def.traits || []).includes('UN'));
  if (superpowerCandidates.length === 0 || unCandidates.length === 0) return false;
  const superpower = superpowerCandidates[0];
  const un = unCandidates.find((c) => c !== superpower) || unCandidates[0];
  if (superpower === un) return false;
  player.trash.splice(player.trash.indexOf(superpower), 1);
  player.removal.push(superpower);
  player.trash.splice(player.trash.indexOf(un), 1);
  player.removal.push(un);
  setActiveByEffect(state, player, instance);
  instance.buffs.push({ cannotAttack: true, scope: 'turn' });
  return true;
}

// --- Unicorn Gundam 02 Banshee Norn (Unicorn Mode) GD04-072 ---
// [When Linked] Choose 1 enemy Unit with 3 or less HP. Return it to its owner's hand -- same
// removeFromField+sendToZone bounce shape as Strike Freedom Gundam GD05's/GD03's enemy-bounce effects.
function unicornGundam02BansheeNornWhenLinked(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- GD04 batch 5 --------------------------------------------------------

// --- Turn A Gundam (GD04-073) ---
// [ActivateMain][Once per Turn] (1): This Unit gets AP+2 during this turn. Also (Militia)-traited,
// so this is a second real payAbilityCost producer for Turn A Gundam GD04-069's "paid (1)+ for one
// of your other (Militia)/(Dianna Counter) Units' effects" check, same shape as GD04-067 (batch 4).
function turnAGundamGD04073ActivateMain(state, player, instance) {
  if (instance.activationsUsed.apBoost) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  activeResources[0].rested = true;
  payAbilityCost(state, player, instance, 1);
  instance.activationsUsed.apBoost = true;
  instance.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Kapool GD04-074 ---
// [Attack] You may pay (1). If you do, draw 1. Then, discard 1. (Heuristic: always pay if a
// resource is available -- looting is close to strictly good.)
function kapoolAttack(state, player, unit, context) {
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length === 0) return;
  activeResources[0].rested = true;
  drawCard(state, player);
  const discard = context.hooks && context.hooks.chooseDiscard
    ? context.hooks.chooseDiscard(player.hand)
    : player.hand[0];
  if (discard) {
    player.hand.splice(player.hand.indexOf(discard), 1);
    player.trash.push(discard);
  }
}

// --- GN-X GD04-075 ---
// data only: "Reduce the cost of this card in your hand by an amount equal to the number of
// (UN)/(Superpower Bloc) Command cards in your trash" (def.costReductionPerTrashCard, read by
// effectiveCost in src/rules/cost.js).

// --- Hipheavy GD04-076 / Borjarnon GD04-078 / Agrissa GD04-079 --- vanilla (no effectRefs).

// --- Alvatore GD04-080 ---
// [Destroyed] If you have another (UN)/(Superpower Bloc) Unit in play, deploy 1 rested [Alvaaron]
// ((UN)AP4HP1) Unit token -- destroyCard has already removed Alvatore itself from battleArea by the
// time this fires (GN Armor Type-E precedent, batch 4), so no self-exclusion filter is needed.
const ALVAARON_TOKEN = Object.freeze({
  number: 'TOKEN-ALVAARON', name: 'Alvaaron', type: 'unit', color: null,
  traits: ['UN'], ap: 4, hp: 1, isToken: true
});
function alvatoreDestroyed(state, player) {
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('UN') || (u.def.traits || []).includes('Superpower Bloc'))) return;
  deployUnit(state, player, ALVAARON_TOKEN).rested = true;
}

// --- Rosamia Badam GD04-082 (Pilot) ---
// [Burst] Add this card to your hand.
// [When Linked] Choose 1 rested Unit. Deal 1 damage to it. (No "enemy"/"your" qualifier in the
// printed text -- heuristic: prefer an enemy rested Unit when one exists, since that's always the
// better pick; only reach for a friendly rested Unit if no enemy one is legal, since the choice is
// mandatory.)
function rosamiaBadamBurst(state, player, instance) {
  player.hand.push(instance);
}
function rosamiaBadamWhenLinked(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const enemyCandidates = opponent.battleArea.filter((u) => u.rested);
  const useEnemy = enemyCandidates.length > 0;
  const candidates = useEnemy ? enemyCandidates : player.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => (useEnemy ? getRemainingHP(a) - getRemainingHP(b) : getRemainingHP(b) - getRemainingHP(a)))[0];
  dealEffectDamage(state, player, useEnemy ? opponent : player, target, 1);
}

// --- Marbet Fingerhat GD04-083 (Pilot) ---
// [Burst] Add this card to your hand.
// All your (League Militaire) Unit tokens get AP+1 -- no [During Link] bracket in the printed text,
// so it's active whenever paired (During Pair implicit), not gated on isLinkUnit. Same cross-unit
// grantedStatBonus aura shape as Gundam X (LR+) GD02-053's Vulture buff, recomputed every
// startOfTurn (fireCardEffect/triggerEvent already forward a paired Pilot's startOfTurn handler).
function marbetFingerhatBurst(state, player, instance) {
  player.hand.push(instance);
}
function marbetFingerhatStartOfTurn(state, player) {
  for (const u of player.battleArea) {
    if (u.def.isToken && (u.def.traits || []).includes('League Militaire')) {
      u.grantedStatBonus = { ap: 1 };
    }
  }
}

// --- Sleggar Law GD04-084 (Pilot) ---
// [Burst] Add this card to your hand.
// [Attack] Choose 1 of your (White Base Team) Units. It gets AP+1 during this turn. No [During
// Link] bracket, so it's active whenever paired (During Pair implicit).
function sleggarLawBurst(state, player, instance) {
  player.hand.push(instance);
}
function sleggarLawAttack(state, player) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('White Base Team'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: 1, scope: 'turn' });
}

// --- Suletta Mercury (R+) GD04-085 (Pilot) ---
// [Burst] Add this card to your hand.
// [During Link][Once per Turn] When you play and activate an (Academy) Command card using an EX
// Resource, if you have no remaining EX Resources, place 1 rested EX Resource -- same
// friendlyPlaysCommand/usedExResource broadcast as Gundam Lfrith Ur GD04-020 (batch 4's first use).
function sulettaMercuryRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function sulettaMercuryRPlusFriendlyPlaysCommand(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  if (unit.activationsUsed.placeExResource) return;
  if (!context.usedExResource) return;
  if (!(context.commandInstance.def.traits || []).includes('Academy')) return;
  if (player.resourceArea.some((r) => r.def.isToken)) return;
  unit.activationsUsed.placeExResource = true;
  placeExResource(state, player);
  player.resourceArea[player.resourceArea.length - 1].rested = true;
}

// --- Garma Zabi GD04-086 (Pilot) ---
// [Burst] Add this card to your hand.
// [During Link][Destroyed] If you have no EX Resources, place 1 EX Resource. A paired Pilot's own
// [Destroyed] ability previously couldn't fire at all -- fireCardEffect's instance.pilot forwarding
// runs after destroyCard has already nulled instance.pilot, so the check silently failed for every
// prior card (none needed it until now). Fixed at the source in src/rules/combat.js's
// destroyAndFireEffect, which already captured the pilot reference before nulling for the
// `wasPaired` context flag -- now it also fires that captured pilot's own destroyed handler.
function garmaZabiBurst(state, player, instance) {
  player.hand.push(instance);
}
function garmaZabiDestroyed(state, player, unit) {
  if (!unit.isLinkUnit) return;
  if (player.resourceArea.some((r) => r.def.isToken)) return;
  placeExResource(state, player);
}

// --- Elan Ceres (Enhanced Person Number 5) GD04-087 (Pilot) ---
// [Burst] Add this card to your hand.
// [During Link][Attack] You may choose 1 of your (Academy) Units. During this battle, battle damage
// this Unit would receive is dealt to that Unit instead -- a battle-scoped redirectDamageTarget buff
// consulted by src/rules/combat.js's new getBattleDamageRecipient at the two return-damage-to-
// attacker sites. Heuristic: redirect into the highest-remaining-HP other (Academy) ally, the best
// "tank" pick. Named with an Enhanced-Person suffix since Elan Ceres GD01-098 already owns the bare
// elanCeresBurst/elanCeresAttack names.
function elanCeresEnhancedPersonBurst(state, player, instance) {
  player.hand.push(instance);
}
function elanCeresEnhancedPersonAttack(state, player, unit) {
  if (!unit.isLinkUnit) return;
  const candidates = player.battleArea.filter((u) => u !== unit && (u.def.traits || []).includes('Academy'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  unit.buffs.push({ redirectDamageTarget: target, scope: 'battle' });
}

// --- Deux Murasame GD04-091 (Pilot) ---
// [Burst] Add this card to your hand.
// [Destroyed] Choose 1 undamaged enemy Unit. Deal 1 damage to it. No [During Link] bracket (During
// Pair implicit) -- fires via the same garmaZabiDestroyed-precedent fix above.
function deuxMurasameBurst(state, player, instance) {
  player.hand.push(instance);
}
function deuxMurasameDestroyed(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.damage === 0);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 1);
}

// --- Michael Trinity GD04-092 (Pilot) ---
// [Burst] Add this card to your hand.
// [When Linked] Choose 1 damaged enemy Unit. Deal 1 damage to it.
function michaelTrinityBurst(state, player, instance) {
  player.hand.push(instance);
}
function michaelTrinityWhenLinked(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.damage > 0);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealEffectDamage(state, player, opponent, target, 1);
}

// --- GD04 batch 6 --------------------------------------------------------

// --- Rey Za Burrel (R+) GD04-093 (Pilot) ---
// [Burst] Add this card to your hand.
// [When Linked] Choose 1 of your (ZAFT) Link Units. During this turn, reduce the next damage it
// receives by 2 -- new nextDamageReduction buff (src/rules/management.js's dealDamage), a one-shot
// reduction consumed by the very next damage event, unlike the persistent damageReduction family.
function reyZaBurrelRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function reyZaBurrelRPlusWhenLinked(state, player) {
  const candidates = player.battleArea.filter((u) => u.isLinkUnit && (u.def.traits || []).includes('ZAFT'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ nextDamageReduction: 2, scope: 'turn' });
}

// --- Pala Sys GD04-094 (Pilot) ---
// [Burst] Add this card to your hand.
// [When Linked] Choose 1 purple Unit card with <Suppression> from your trash. Add it to your hand.
function palaSysBurst(state, player, instance) {
  player.hand.push(instance);
}
function palaSysWhenLinked(state, player) {
  const candidates = player.trash.filter(
    (c) => c.def.type === 'unit' && c.def.color === 'purple' && c.def.keywords && c.def.keywords.suppression
  );
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.trash.splice(player.trash.indexOf(target), 1);
  player.hand.push(target);
}

// --- Lunamaria Hawke (U+) GD04-095 (Pilot) ---
// [Burst] Add this card to your hand.
// [When Linked] Choose 1 of your (Minerva Squad) Units. During this turn, battle damage it would
// receive is dealt to this Unit instead -- a turn-scoped redirectDamageTarget buff placed on the
// chosen ally, pointing at Lunamaria's own paired Unit ("this Unit" = `unit` below). Unlike Elan
// Ceres GD04-087 (attacker-only), this can matter on either side of a battle, so combat.js's
// resolveUnitBattleDamage was generalized this batch to consult getBattleDamageRecipient for the
// defender's role too. Heuristic: protect whichever (Minerva Squad) ally is lowest on remaining HP.
function lunamariaHawkeUPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function lunamariaHawkeUPlusWhenLinked(state, player, unit) {
  const candidates = player.battleArea.filter((u) => u !== unit && (u.def.traits || []).includes('Minerva Squad'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  target.buffs.push({ redirectDamageTarget: unit, scope: 'turn' });
}

// --- Ennil El GD04-096 (Pilot) ---
// [Burst] Add this card to your hand.
// [During Link] When this Unit deals battle damage to an enemy Unit that is Lv.5 or lower, destroy
// that enemy Unit -- same "top up damage to lethal" shape as Gundam Virtue (R+) GD03-052, fired from
// the dealsBattleDamage trigger (which runs before the defender's destroy-check, so setting its
// damage to max HP here is enough for the normal destroyAndFireEffect call right after to finish it).
function ennilElBurst(state, player, instance) {
  player.hand.push(instance);
}
function ennilElDealsBattleDamage(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  const defender = context.defender;
  if (!defender || (defender.def.level || 0) > 5) return;
  defender.damage = getHP(defender);
}

// --- Loran Cehack (R+) GD04-097 (Pilot) ---
// [Burst] Add this card to your hand.
// [When Linked] Choose 1 enemy Unit with 3 or less HP. Return it to its owner's hand.
function loranCehackRPlusBurst(state, player, instance) {
  player.hand.push(instance);
}
function loranCehackRPlusWhenLinked(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Ali al-Saachez GD04-099 (Pilot) ---
// [Burst] Add this card to your hand.
// [During Link][Attack] You may choose 1 enemy Pilot. Return it to its owner's hand -- same
// unpair-and-relocate shape as Eliminate Target GD03-110's Destroy, sent to hand instead of trash.
function aliAlSaachezBurst(state, player, instance) {
  player.hand.push(instance);
}
function aliAlSaachezAttack(state, player, unit) {
  if (!unit.isLinkUnit) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.pilot);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  const pilot = target.pilot;
  target.pilot = null;
  sendToZone(opponent.hand, pilot);
}

// --- Sochie Heim GD04-100 (Pilot) ---
// [Burst] Add this card to your hand.
// [Once per Turn] When you pay (1) or more cost for one of your Units' effects, you may increase
// this Unit's AP during this turn by an amount equal to the cost paid -- reactive off the new
// friendlyPaysAbilityCost broadcast added to src/rules/effects.js's payAbilityCost this batch.
function sochieHeimBurst(state, player, instance) {
  player.hand.push(instance);
}
function sochieHeimFriendlyPaysAbilityCost(state, player, unit, context) {
  if (unit.activationsUsed.apFromCost) return;
  if (context.amount < 1) return;
  unit.activationsUsed.apFromCost = true;
  unit.buffs.push({ ap: context.amount, scope: 'turn' });
}

// --- Moment of Rest (U+) GD04-102 (Command) ---
// [Burst] Draw 1.
// [Main] Choose 1 rested enemy Unit that is Lv.5 or lower. It won't be set as active during the
// start phase of your opponent's next turn -- reuses the existing skipNextUntap flag (Byarlant
// GD02-004 precedent) directly.
function momentOfRestUPlusBurst(state, player) {
  drawCard(state, player);
}
function momentOfRestUPlusCommand(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested && (u.def.level || 0) <= 5);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.skipNextUntap = true;
}

// --- Spiritual Support GD04-103 (Command) ---
// [Main] Choose 1 of your Units. It gains <Repair 2> during this turn -- the repair buff family
// (`b.repair`, read by applyRepairAtEndOfTurn) already supports a turn-scoped grant directly.
function spiritualSupportCommand(state, player) {
  if (player.battleArea.length === 0) return;
  const target = player.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  target.buffs.push({ repair: 2, scope: 'turn' });
}

// --- Shrike Team's Bulwark GD04-104 (Command; pairable as Pilot [Junko Jenko]) ---
// [Main] / [Action] Choose 1 to 2 enemy Units that are Lv.2 or lower. Rest them. (Intercept Orders
// GD01-099 "choose 1 to 2" default-slice pattern, reused directly.)
function shrikeTeamsBulwarkCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2);
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const t of targets) t.rested = true;
}

// --- Encounter (R+) GD04-105 (Command) ---
// [Main] Look at the top 5 cards of your deck. You may reveal 1 Pilot card among them and add it to
// your hand. Return the remaining cards randomly to the bottom of your deck (Re-GZ GD05-019's
// look-N/reveal-1/shuffle-rest pattern, reused directly with a Pilot-type filter).
function encounterRPlusCommand(state, player) {
  const top5 = player.deck.splice(0, 5);
  const matchIdx = top5.findIndex((c) => c.def.type === 'pilot');
  if (matchIdx !== -1) {
    const [chosen] = top5.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top5));
}

// --- Indiscriminate Violence GD04-106 (Command; pairable as Pilot [Norea Du Noc]) ---
// [Main] Choose 1 friendly (Academy) Unit. During this turn, it may choose an active enemy Unit
// with 5 or less AP as its attack target. If you use an EX Resource to play this card, choose 1 to 2
// friendly (Academy) Units instead -- activeTargetAPThreshold buff family (Kampfer GD03-017), plus
// the new usedExResource forwarding into the command handler's own context (src/rules/actions.js).
function indiscriminateViolenceCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Academy'));
  if (candidates.length === 0) return;
  const count = context.usedExResource ? 2 : 1;
  const targets = candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, count);
  for (const t of targets) t.buffs.push({ activeTargetAPThreshold: 5, scope: 'turn' });
}

// --- Destined Battle GD04-107 (Command) ---
// [Burst] Add this card to your hand.
// [Action] Choose 1 of your rested Units. During this turn, all enemy Units must choose that Unit as
// their attack target when attacking -- new forcedAttackTarget buff, read by the AI's
// getForcedAttackTargets alongside the existing pilot/trait-driven taunt sources.
function destinedBattleBurst(state, player, instance) {
  player.hand.push(instance);
}
function destinedBattleCommand(state, player) {
  const candidates = player.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  target.buffs.push({ forcedAttackTarget: true, scope: 'turn' });
}

// --- Witches from Earth GD04-108 (Command; pairable as Pilot [Sophie Pulone]) ---
// [Main] / [Action] Choose 1 friendly (Academy) Unit. During this turn, reduce the next damage it
// receives by 2. If you use an EX Resource to play this card, reduce by 4 instead -- same
// nextDamageReduction buff as Rey Za Burrel above.
function witchesFromEarthCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Academy'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  const amount = context.usedExResource ? 4 : 2;
  target.buffs.push({ nextDamageReduction: amount, scope: 'turn' });
}

// --- Financier (U+) GD04-110 (Command) ---
// [Main] / [Action] Deploy 1 EX Base -- deployBase already handles trashing whatever Base was there.
function financierUPlusCommand(state, player) {
  deployBase(state, player, EX_BASE_DEF);
}

// === GD04 batch 7 (final GD04 batch, GD04-111 through GD04-130) ===========

// --- Trinity GD04-111 (Command; pairable as Pilot [Johann Trinity]) ---
// [Main] / [Action] Choose 1 to 3 of your (CB) Units. They get AP+2 during this turn (Intercept
// Orders GD01-099 "choose N default-slice" pattern, extended to a 3-cap).
function trinityCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('CB'));
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a)).slice(0, 3);
  for (const t of targets) t.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Inspector GD04-112 (Command; pairable as Pilot [Gates Capa]) ---
// [Main] Deal 1 damage to all Units that are Lv.2 or lower (both players', same "All Units" reading
// as Widespread Annihilation GD05-114's board wipe above).
function inspectorCommand(state, player) {
  for (const p of state.players) {
    const targets = p.battleArea.filter((u) => (u.def.level || 0) <= 2);
    for (const unit of targets) {
      dealEffectDamage(state, player, p, unit, 1);
      destroyAndFireEffect(state, p, unit);
    }
  }
}

// --- Damage Control GD04-113 (Command) ---
// [Burst] Choose 1 enemy Unit. It gets AP-2 during this turn.
// [Action] Choose 1 of your Units. During this battle, reduce battle damage it receives by 3
// (damageReduction buff scoped to 'battle', same mechanism as GD04-096-adjacent precedent above).
function damageControlBurst(state, player) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  reduceEnemyAP(state, player, opponent, target, 2);
}
function damageControlCommand(state, player) {
  if (player.battleArea.length === 0) return;
  const target = [...player.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  target.buffs.push({ damageReduction: 3, scope: 'battle' });
}

// --- Reformationist (U+) GD04-114 (Command) ---
// [Burst] Choose 1 Unit card with "Trans-Am" in its card name from your trash. Add it to your hand.
// [Main] / [Action] Choose 1 of your Units and 1 enemy Unit. Deal 1 damage to them -- byte-identical
// text to Gundam Barbatos Adapt GD03-056/Mikazuki Augus ST05-010 above, same shape reused directly.
function reformationistUPlusBurst(state, player) {
  const candidates = player.trash.filter((c) => c.def.type === 'unit' && (c.def.name || '').includes('Trans-Am'));
  if (candidates.length === 0) return;
  const chosen = candidates.sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);
}
function reformationistUPlusCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const friendlyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : [...player.battleArea].sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  const enemyTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (friendlyTarget) dealDamage(friendlyTarget, 1);
  if (enemyTarget) dealDamage(enemyTarget, 1);
}

// --- Backup GD04-115 (Command) ---
// [Burst] Choose 1 enemy Unit. Deal 1 damage to it.
// [Main] Choose 1 of your Units. When it deals battle damage to an enemy Unit that is Lv.5 or lower
// during this turn, destroy that enemy Unit -- executeEnemyLevelCap buff, read by combat.js's
// fireDealsBattleDamage.
function backupBurst(state, player) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = [...opponent.battleArea].sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealEffectDamage(state, player, opponent, target, 1);
  destroyAndFireEffect(state, opponent, target);
}
function backupCommand(state, player) {
  if (player.battleArea.length === 0) return;
  const target = [...player.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ executeEnemyLevelCap: 5, scope: 'turn' });
}

// --- Reliable Big Brother GD04-116 (Command; pairable as Pilot [Heine Westenfluss]) ---
// [Main] Place the top 2 cards of your deck into your trash. If you do, choose 1 enemy Unit with 4
// or less AP. Deal an amount of damage equal to the number of (Minerva Squad) cards placed with this
// effect to that enemy Unit.
function reliableBigBrotherCommand(state, player) {
  const opponent = opponentOf(state, player);
  const milled = player.deck.splice(0, 2);
  player.trash.push(...milled);
  const minervaCount = milled.filter((c) => (c.def.traits || []).includes('Minerva Squad')).length;
  if (minervaCount === 0) return;
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 4);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealEffectDamage(state, player, opponent, target, minervaCount);
  destroyAndFireEffect(state, opponent, target);
}

// --- World Distortion GD04-118 (Command; pairable as Pilot [Alejandro Corner]) ---
// [Main] / [Action] If 2 or more friendly (UN) Units are in play, choose 1 enemy Unit with 5 or less
// HP. Return it to its owner's hand (Loran Cehack GD04-097 bounce shape, reused directly).
function worldDistortionCommand(state, player) {
  const unCount = player.battleArea.filter((u) => (u.def.traits || []).includes('UN')).length;
  if (unCount < 2) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 5);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Fighting Alone GD04-119 (Command; pairable as Pilot [Gael Chan]) ---
// [Main] / [Action] Choose 1 friendly Unit paired with a (Newtype) Pilot. It can't receive effect
// damage from enemy Units during this turn -- immuneToNonCommandEnemyEffectDamage buff, read by
// dealEffectDamage (src/rules/effects.js).
function fightingAloneCommand(state, player) {
  const candidates = player.battleArea.filter((u) => u.pilot && (u.pilot.def.traits || []).includes('Newtype'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ immuneToNonCommandEnemyEffectDamage: true, scope: 'turn' });
}

// --- Machine Doll Squad GD04-120 (Command; pairable as Pilot [Miashei Kune]) ---
// [Main] / [Action] Choose 1 friendly (Militia)/(Dianna Counter) Unit. It gets AP+2 during this turn.
function machineDollSquadCommand(state, player) {
  const candidates = player.battleArea.filter(
    (u) => (u.def.traits || []).includes('Militia') || (u.def.traits || []).includes('Dianna Counter')
  );
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- A Baoa Qu GD04-123 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield (Ptolemaios ST07-015 boilerplate).
// "While you have a rested (Zeon) Unit in play, this Base can't receive battle damage from enemy
// Units that are Lv.4 or lower" -- same static shape as Ptolemaios (lowLevelDamageImmuneCap), but
// with a (Zeon) trait and no Unit-token exclusion, so those are read from the Base's own def by
// combat.js's now-generalized isBaseImmuneToLowLevelDamage. Data-only otherwise.

// --- 9th Tactical Testing Sector GD04-124 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield.
// "When you place an EX Resource, choose 1 friendly (Academy) Unit. It gets AP+2 during this turn."
function ninthTacticalTestingSectorPlacesExResource(state, player) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Academy'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Trinity Warship GD04-125 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield.
// [Activate*Main][Once per Turn] (1), rest 1 friendly (CB) Unit: choose 1 enemy Unit that is Lv.5 or
// lower. Deal 1 damage to it (Jaburo GD04-122 shape, extended with a resource cost -- same reason
// Zeta Gundam GD02-069/V2 Gundam/Archangel's setActive abilities were left unwired from the AI's
// runActivations: a compound rest-a-unit-AND-pay-a-resource cost needs real judgement).
function trinityWarshipActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.pingCB) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  const { restUnit, target } = context;
  if (!restUnit || restUnit.rested || !(restUnit.def.traits || []).includes('CB')) return false;
  if (!target || (target.def.level || 0) > 5) return false;
  const opponent = opponentOf(state, player);
  activeResources[0].rested = true;
  payAbilityCost(state, player, instance, 1);
  restUnit.rested = true;
  instance.activationsUsed.pingCB = true;
  dealEffectDamage(state, player, opponent, target, 1);
  destroyAndFireEffect(state, opponent, target);
  return true;
}

// --- Izuma Colony GD04-126 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield.
// "When this Base receives battle damage from an enemy Unit with 3 or less AP, deal 1 damage to that
// Unit" -- new receivesBattleDamageFromEnemy chokepoint (combat.js's resolveDamageStep).
function izumaColonyReceivesBattleDamageFromEnemy(state, player, instance, context) {
  if (context.attackerAP > 3) return;
  const opponent = opponentOf(state, player);
  dealEffectDamage(state, player, opponent, context.attacker, 1);
  destroyAndFireEffect(state, opponent, context.attacker);
}

// --- Freeden II GD04-127 (Base) ---
// [Burst]: simpleBurstBase.
// [Deploy] Add 1 of your Shields to your hand. Then, if there are 7 or more (Vulture) cards in your
// trash, choose 1 enemy Unit with 2 or less AP. Destroy it.
function freedenIIDeploy(state, player) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  const vultureInTrash = player.trash.filter((c) => (c.def.traits || []).includes('Vulture')).length;
  if (vultureInTrash < 7) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 2);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Armory One GD04-128 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield.
// [Destroyed] All players draw 1.
function armoryOneDestroyed(state) {
  for (const p of state.players) drawCard(state, p);
}

// --- Willgem GD04-129 (Base) ---
// [Burst]: simpleBurstBase.
// [Deploy] Add 1 of your Shields to your hand. Then, deal 3 damage to this Base.
// [Once per Turn] During your turn, when you pay (1) or more for a friendly Unit's effect, this Base
// recovers 2 HP -- friendlyPaysAbilityCost broadcast (src/rules/effects.js), now generalized to
// include player.base as a consumer.
function willgemDeploy(state, player, instance) {
  if (player.shields.length > 0) player.hand.push(player.shields.shift());
  dealDamage(instance, 3);
}
function willgemFriendlyPaysAbilityCost(state, player, instance, context) {
  if (state.players[state.activePlayerIdx] !== player) return;
  if (instance.activationsUsed.hpRecoverOnCost) return;
  if (context.amount < 1) return;
  instance.activationsUsed.hpRecoverOnCost = true;
  recoverHP(instance, 2);
}

// --- Industrial 7 GD04-130 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield.
// [Activate*Main][Once per Turn] Exile 1 Command card from your trash: choose 1 enemy Unit. It gets
// AP-1 during this turn.
function industrial7ActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.debuffFromExile) return false;
  const commandsInTrash = player.trash.filter((c) => c.def.type === 'command');
  if (commandsInTrash.length === 0) return false;
  const { target } = context;
  const opponent = opponentOf(state, player);
  if (!target || !opponent.battleArea.includes(target)) return false;
  const toExile = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(commandsInTrash) : commandsInTrash[0];
  player.trash.splice(player.trash.indexOf(toExile), 1);
  player.removal.push(toExile);
  instance.activationsUsed.debuffFromExile = true;
  reduceEnemyAP(state, player, opponent, target, 1);
  return true;
}

// === GD05 batch 1 (GD05-004 through GD05-026) ============================

// --- Akatsuki (Oowashi) GD05-004 (Unit) ---
// Static hand Lv/cost reduction (data field handLevelAndCostReductionPerTrait, src/rules/cost.js).
// [When Linked] Choose 1 enemy Unit that is Lv.4 or lower. Return it to its owner's hand.
function akatsukiOowashiWhenLinked(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Calamity Gundam & Raider Gundam GD05-011 (Unit) ---
// [Deploy] You may choose 1 of your other active (Earth Alliance) Units. Rest it. If you do,
// choose 1 rested enemy Unit. Deal 2 damage to it. (Same "rest a friendly Unit as a cost" shape as
// Gundam Throne Eins GD04-036, single target instead of a 1-to-2 slice.)
function calamityRaiderGundamDeploy(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u !== instance && !u.rested && (u.def.traits || []).includes('Earth Alliance'));
  const restTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!restTarget) return;
  restTarget.rested = true;
  const opponent = opponentOf(state, player);
  const restedEnemies = opponent.battleArea.filter((u) => u.rested);
  const damageTarget = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(restedEnemies)
    : restedEnemies.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!damageTarget) return;
  dealDamage(damageTarget, 2);
  destroyAndFireEffect(state, opponent, damageTarget);
}

// --- Forbidden Gundam GD05-012 (Unit) ---
// [When Linked] Choose 1 rested enemy Unit that is Lv.3 or lower. Return it to its owner's hand.
function forbiddenGundamWhenLinked(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested && (u.def.level || 0) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Murasame GD05-016 (Unit) ---
// "When one of your (Orb) Units is deployed, this Unit gains <High-Maneuver> during this turn"
// (friendlyUnitDeployed broadcast, src/rules/actions.js -- same shape as Neo Zeong GD04-033; fires
// on Murasame's own deploy too, since it's itself (Orb)-traited and the text has no exclusion).
function murasameFriendlyUnitDeployed(state, player, instance, context) {
  if (!(context.deployedUnit.def.traits || []).includes('Orb')) return;
  instance.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Gundam Calibarn GD05-018 (Unit) ---
// [Deploy] Place 3 EX Resources. "When one of your EX Resources is exiled from the game, you may
// choose 1 of your Units. During this turn, when it receives enemy damage, reduce it by 3"
// (friendlyExResourceExiled broadcast, src/rules/cost.js's payCost).
function gundamCalibarnDeploy(state, player) {
  placeExResource(state, player);
  placeExResource(state, player);
  placeExResource(state, player);
}
function gundamCalibarnFriendlyExResourceExiled(state, player, instance, context) {
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  target.buffs.push({ damageReduction: 3, scope: 'turn' });
}

// --- Gundam AGE-2 Double Bullet GD05-021 (Unit) ---
// [Activate·Action][Once per Turn] (1): This Unit gets AP+4 during this battle (same cost-paying
// buff shape as Turn A Gundam GD04-073's Activate·Main, scope 'battle' instead of 'turn'). The
// second ability ("[Once per Turn] When this Unit receives enemy damage, if you have an (Earth
// Federation) Pilot in play, reduce it by 2") is data-only (oncePerTurnEnemyDamageReduction, an
// existing field read by management.js's dealDamage).
function gundamAge2DoubleBulletActivateAction(state, player, instance) {
  if (instance.activationsUsed.apBoost) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 1) return false;
  activeResources[0].rested = true;
  payAbilityCost(state, player, instance, 1);
  instance.activationsUsed.apBoost = true;
  instance.buffs.push({ ap: 4, scope: 'battle' });
  return true;
}

// --- Gundam Schwarzette GD05-022 (Unit) ---
// <Breach 3> (data). [Activate·Action] Exile 2 Command cards in your trash from the game: during
// this battle, when this Unit receives enemy damage, reduce it by 2 (exile-2-from-trash cost, same
// shape as Industrial 7 GD04-130's exile-1 cost, granting a damageReduction buff scope:'battle').
function gundamSchwarzetteActivateAction(state, player, instance) {
  if (instance.activationsUsed.damageReduction) return false;
  const commandsInTrash = player.trash.filter((c) => c.def.type === 'command');
  if (commandsInTrash.length < 2) return false;
  const toExile = commandsInTrash.slice(0, 2);
  for (const c of toExile) {
    player.trash.splice(player.trash.indexOf(c), 1);
    player.removal.push(c);
  }
  instance.activationsUsed.damageReduction = true;
  instance.buffs.push({ damageReduction: 2, scope: 'battle' });
  return true;
}

// --- Re-GZ BWS GD05-023 (Unit) ---
// [Deploy] Place 1 EX Resource.
function reGZBWSDeploy(state, player) {
  placeExResource(state, player);
}

// --- Demi Barding GD05-025 (Unit) ---
// [Deploy] Look at the top 3 cards of your deck. You may reveal 1 Command card among them and add
// it to your hand. Return the remaining cards randomly to the bottom of your deck (same "look at
// top 3, reveal matching type" shape as Garrod Ran & Tiffa Adill GD02-094, Command instead of a
// (Vulture) Unit, no discard cost).
function demiBardingDeploy(state, player) {
  const top3 = player.deck.splice(0, 3);
  const idx = top3.findIndex((c) => c.def.type === 'command');
  if (idx !== -1) {
    const [chosen] = top3.splice(idx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// --- Gundam Aerial Rebuild GD05-026 (Unit) ---
// (data-only comment, no function; uses deployRestedAuraNameIncludesAny, src/rules/actions.js)

// === GD05 batch 2 (missing-number sweep, sourced from tcgcsv.com rules text) ===

// --- Kayra's Jegan GD05-028 (Unit) ---
// [Deploy] Choose 1 of your (Londo Bell) Units. During this turn, it may choose an active enemy
// Unit with 4 or less AP as its attack target -- reuses the activeTargetAPThreshold buff shape
// Kämpfer GD03-017's team-wide grant already established, just Deploy-targeted at one chosen Unit.
function kayrasJeganDeploy(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Londo Bell'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ activeTargetAPThreshold: 4, scope: 'turn' });
}

// --- Michaelis GD05-030 (Unit) ---
// (data-only comment, no function; uses attackOnDeployRestedOnly, src/ai/heuristic.js, same shape
// as Gundam Deathscythe Hell (EW) GD05-078)

// --- Guel's Dilanza GD05-031 (Unit) / Desultor GD05-032 (Unit) ---
// (data-only comments, no functions; vanilla stat sticks with trait-based Link conditions)

// --- Gaia Gundam (LR+) GD05-034 (Unit) ---
// [During Pair][Once per Turn] When this Unit destroys an enemy shield area card with battle
// damage, that enemy player may discard 1. If they don't discard with this effect, you may deploy
// 1 (Phantom Pain) Unit card that is Lv.4 or lower from your hand. (Heuristic: the enemy always
// discards their cheapest card, since giving up any one card is normally worth less than letting
// the Gaia player deploy a Unit for free -- same "always take the beneficial line" default as
// Garrod Ran & Tiffa Adill GD02-094's own-side discard.)
function gaiaGundamLRPlusDestroysShield(state, player, instance, context) {
  if (!instance.pilot) return;
  if (instance.activationsUsed.discardOrDeploy) return;
  instance.activationsUsed.discardOrDeploy = true;
  const opponent = opponentOf(state, player);
  const discard = [...opponent.hand].sort((a, b) => (a.def.cost || 0) - (b.def.cost || 0))[0];
  if (discard) {
    forceEnemyDiscard(player, opponent, discard);
    return;
  }
  const candidates = player.hand.filter(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Phantom Pain') && (c.def.level || 0) <= 4
  );
  const chosen = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : [...candidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (!chosen) return;
  player.hand.splice(player.hand.indexOf(chosen), 1);
  deployUnit(state, player, chosen.def);
}

// --- Destroy Gundam (R+) GD05-037 (Unit) ---
// (data-only comment, no function; uses enemyTrashLevelAndCostReduction, src/rules/cost.js, and
// duringLinkKeywords.breach, src/rules/management.js)

// --- Chaos Gundam GD05-039 (Unit) ---
// [Attack] Choose 1 of your (Phantom Pain) Linked Units. It gains <High-Maneuver> during this turn.
function chaosGundamAttack(state, player, instance) {
  const candidates = player.battleArea.filter((u) => u.isLinkUnit && (u.def.traits || []).includes('Phantom Pain'));
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Abyss Gundam GD05-040 (Unit) ---
// (data-only comment, no function; keywords.support, same generic <Support> rule as Buster Gundam
// GD01-046 -- not wired into any AI activation path yet, same scoping note as that card.)

// --- Gaia Gundam (MA Mode) (U+) GD05-041 (Unit) ---
// (data-only comment, no function; uses costReductionIfEnemyDiscardedByEffect, src/rules/cost.js)

// --- Neros Gundam GD05-043 (Unit) ---
// (data-only comment, no function; vanilla stat stick, no Link condition)

// --- Gundam Rose GD05-044 (Unit) ---
// [During Link][Attack] Activate Main on the card paired with this Unit -- same "forward to the
// paired Pilot's own Activate-Main" shape as Gundam Maxter GD01-XXX's gundamMaxterAttack (a no-op
// unless the paired Pilot actually has one).
function gundamRoseAttack(state, player, unit) {
  if (!unit.isLinkUnit || !unit.pilot) return;
  const pilotActivateMain = unit.pilot.def.effects && unit.pilot.def.effects.activateMain;
  if (pilotActivateMain) pilotActivateMain(state, player, unit.pilot, {});
}

// --- Chaos Gundam (MA Mode) GD05-045 (Unit) ---
// (data-only comment, no function; keywords.breach, flat 3, no During Link gate)

// --- Abyss Gundam (MA Mode) GD05-046 (Unit) ---
// [When Paired • (Phantom Pain) Pilot] Choose 1 enemy player with 4 or more cards in their hand.
// They discard 1. (Only one enemy player exists in this 1v1 engine, so "choose" collapses to a
// straight condition check.)
function abyssGundamMAModeWhenPaired(state, player, instance, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('Phantom Pain')) return;
  const opponent = opponentOf(state, player);
  if (opponent.hand.length < 4) return;
  const discard = [...opponent.hand].sort((a, b) => (a.def.cost || 0) - (b.def.cost || 0))[0];
  forceEnemyDiscard(player, opponent, discard);
}

// --- Exass GD05-047 (Unit) ---
// (data-only comment, no function; vanilla stat stick with a trait-based Link condition)

// --- Gundam Kyrios (Flight Mode) (C+) GD05-048 (Unit) ---
// (data-only comment, no function; uses attackOnDeployRestedOnly, same shape as Michaelis GD05-030
// above / Gundam Deathscythe Hell (EW) GD05-078)

// === GD05 batch 3 (missing-number sweep, sourced from tcgcsv.com rules text) ===

// --- Gundam Barbatos Lupus Rex (LR+) GD05-051 (Unit) ---
// Increase this Unit's AP by an amount equal to the amount of damage it has received (data-only;
// apBonusEqualToDamage, src/rules/management.js). [End of Turn] You may choose 1 of your (Tekkadan)
// Units. Deal 1 damage to it. Set it as active. (Default targets a rested (Tekkadan) ally to get the
// real benefit of the reactivation -- setActiveByEffect is a no-op on an already-active Unit, same
// reasoning Turn A Gundam GD04-069's endOfTurn already uses -- falling back to itself otherwise,
// since the AP-scaling side of the card still benefits from the self-damage.)
function gundamBarbatosLupusRexEndOfTurn(state, player, instance, context) {
  if (state.players[state.activePlayerIdx] !== player) return;
  const tekkadanUnits = player.battleArea.filter((u) => (u.def.traits || []).includes('Tekkadan'));
  const restedCandidates = tekkadanUnits.filter((u) => u.rested);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(restedCandidates.length > 0 ? restedCandidates : tekkadanUnits)
    : restedCandidates.sort((a, b) => a.damage - b.damage)[0] || (tekkadanUnits.includes(instance) ? instance : tekkadanUnits[0]);
  if (!target) return;
  dealDamage(target, 1);
  setActiveByEffect(state, player, target);
}

// --- Sazabi (R+) GD05-052 (Unit) ---
// [Deploy] You may choose 1 of your other Units. Destroy it. If you do, place the top 3 cards of
// your deck into your trash. Add 1 (Neo Zeon) Unit card you placed from your deck with this effect
// to your hand.
function sazabiRPlusDeploy(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u !== instance);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(a) - getAP(b))[0];
  if (!target) return;
  destroyFriendlyByEffect(state, player, instance, target);
  const top3 = player.deck.splice(0, 3);
  const idx = top3.findIndex((c) => c.def.type === 'unit' && (c.def.traits || []).includes('Neo Zeon'));
  if (idx !== -1) {
    const [chosen] = top3.splice(idx, 1);
    player.hand.push(chosen);
  }
  player.trash.push(...top3);
}

// --- Quess's Jagd Doga (R+) (Link Rare) GD05-053 (Unit) ---
// [Destroyed] If this Unit is destroyed by one of your (Neo Zeon) card's effects, add it from your
// trash to your hand.
function quessJagdDogaRPlusDestroyed(state, player, instance) {
  if (!player.neoZeonSelfDestroyThisTurn) return;
  const idx = player.trash.indexOf(instance);
  if (idx === -1) return;
  player.trash.splice(idx, 1);
  player.hand.push(instance);
}

// --- Alpha Azieru GD05-054 (Unit) ---
// <Blocker> (data). [Once per Turn] When one of your Units is destroyed by an effect, draw 1.
function alphaAzieruFriendlyUnitDestroyedByEffect(state, player, instance) {
  if (instance.activationsUsed.destroyedByEffectDraw) return;
  instance.activationsUsed.destroyedByEffectDraw = true;
  drawCard(state, player);
}

// --- Rezin's Geara Doga GD05-056 (Unit) ---
// (data-only comment, no function; vanilla stat stick with a trait-based Link condition)

// --- Gyunei's Jagd Doga GD05-057 (Unit) ---
// [Activate • Main][Once per Turn] Choose 1 of your other Units. Destroy it. If you do, set this
// Unit as active. It can't choose the enemy player as its attack target during this turn. (Not
// AI-wired -- a compound-cost judgement call, same precedent as Char's Gelgoog GD01-023; engine-
// correct and directly testable.)
function gyuneisJagdDogaGD05057ActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.selfDestroyRefresh) return false;
  const candidates = player.battleArea.filter((u) => u !== instance);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(a) - getAP(b))[0];
  if (!target) return false;
  instance.activationsUsed.selfDestroyRefresh = true;
  destroyFriendlyByEffect(state, player, instance, target);
  setActiveByEffect(state, player, instance);
  instance.buffs.push({ cannotAttackPlayer: true, scope: 'turn' });
  return true;
}

// --- Gundam Barbatos Lupus (U+) (Link Rare) GD05-059 (Unit) ---
// [Attack] Choose 1 of your active (Gjallarhorn) Units. Rest it. If you do, draw 1. This Unit gains
// <High-Maneuver> during this turn.
function gundamBarbatosLupusUPlusAttack(state, player, instance) {
  const candidates = player.battleArea.filter((u) => u !== instance && !u.rested && (u.def.traits || []).includes('Gjallarhorn'));
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) {
    target.rested = true;
    drawCard(state, player);
  }
  instance.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Geara Doga GD05-061 (Unit) ---
// While you have another (Neo Zeon) Unit in play, this Unit gains <Blocker> -- same live-toggle
// shape as Gaelio's Schwalbe Graze GD02-082.
function gearaDogaGD05061StartOfTurn(state, player, instance) {
  instance.grantedKeywords.blocker = player.battleArea.some(
    (u) => u !== instance && (u.def.traits || []).includes('Neo Zeon')
  );
}

// --- Hobby Hizack GD05-062 (Unit) / Gyunei's Jagd Doga GD05-063 (Unit) ---
// (data-only comments, no functions; vanilla stat sticks, GD05-063 with a trait-based Link condition)

// --- Force Impulse Gundam (C+) (Link Rare) GD05-064 (Unit) ---
// [Deploy] If you deploy this Unit from your trash, choose 1 Pilot card with "Shinn Asuka" in its
// card name from your trash. Add it to your hand. Same context.fromTrash-gated shape as Sword
// Impulse Gundam ST09-006.
function forceImpulseGundamGD05064Deploy(state, player, instance, context) {
  if (!context.fromTrash) return;
  const candidates = player.trash.filter((c) => c.def.type === 'pilot' && (c.def.name || '').includes('Shinn Asuka'));
  const chosen = context.hooks && context.hooks.chooseCard ? context.hooks.chooseCard(candidates) : candidates[0];
  if (!chosen) return;
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);
}

// --- Landman Rodi GD05-065 (Unit) ---
// [During Link] This Unit gets AP+2 during your turn -- a turn-scoped buff granted at the start of
// each of the controller's own turns (cleared automatically by the normal end-of-turn sweep),
// distinct from the unconditional-every-turn duringLinkAp field since this only applies on the
// controller's own turn.
function landmanRodiStartOfTurn(state, player, instance) {
  if (!instance.isLinkUnit) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  instance.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Tallgeese III (R+) GD05-070 (Unit) ---
// [Once per Turn] During your turn, when this Unit destroys an enemy Unit with battle damage, choose
// 1 of your rested (Preventer)/(G Team) Link Units. Set it as active. It can't attack during this
// turn. ("During your turn" collapses to always-true here, same reasoning as Carta's Graze Ritter in
// combat.js -- destroysEnemy only ever fires while this player is the attacker.)
function tallgeeseIIIDestroysEnemy(state, player, instance) {
  if (instance.activationsUsed.setActiveOnKill) return;
  const candidates = player.battleArea.filter(
    (u) => u.rested && u.isLinkUnit && (u.def.traits || []).some((t) => t === 'Preventer' || t === 'G Team')
  );
  if (candidates.length === 0) return;
  instance.activationsUsed.setActiveOnKill = true;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  setActiveByEffect(state, player, target);
  target.buffs.push({ cannotAttack: true, scope: 'turn' });
}

// --- Gundam Sandrock Custom (EW) (R+) (Link Rare) GD05-071 (Unit) ---
// [Attack] If you have another (G Team)/(Preventer) Unit in play, choose 1 enemy Unit. It gets AP-2
// during this turn.
function gundamSandrockCustomEWAttack(state, player, instance) {
  const hasAlly = player.battleArea.some((u) => u !== instance && (u.def.traits || []).some((t) => t === 'G Team' || t === 'Preventer'));
  if (!hasAlly) return;
  const opponent = opponentOf(state, player);
  const target = opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ ap: -2, scope: 'turn' });
}

// --- Altron Gundam (EW) GD05-073 (Unit) ---
// [Deploy] Choose 1 rested enemy Unit. It won't be set as active during the start phase of your
// opponent's next turn -- reuses the existing skipNextUntap flag (Byarlant GD02-004 precedent).
function altronGundamEWDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.skipNextUntap = true;
}

// === GD05 batch 4 (missing-number sweep, sourced from tcgcsv.com rules text) ===

// Shared one-line body reused by every Pilot's "[Burst] Add this card to your hand" (identical
// shape to amuroRayBurst/etc. above, just referenced by name instead of duplicated per card).
function addSelfToHandBurst(state, player, instance) {
  player.hand.push(instance);
}

// --- Noin's Taurus GD05-074 (Unit) ---
// [Destroyed] Draw 1. Then, discard 1. (Heuristic default discard: the highest-cost card in hand,
// matching every other "discard 1" site's convention.)
function noinsTaurusDestroyed(state, player) {
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Bolt Gundam GD05-076 (Unit) ---
// (data-only: reuses gundamRoseAttack GD05-045's identical "[During Link][Attack] Activate [Main]
// on the card paired with this Unit" shape.)

// --- Leo GD05-077 (Unit) ---
// (data-only, vanilla.)

// --- Gundam Heavyarms Custom (EW) (C+) GD05-079 (Unit) ---
// [Activate*Main][Once per Turn] If you have another (G Team)/(Preventer) Unit in play, choose 1
// enemy Unit that is Lv.4 or lower. It gets AP-1 during this turn.
function gundamHeavyarmsCustomEWActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.debuffEnemy) return false;
  const hasAlly = player.battleArea.some(
    (u) => u !== instance && (u.def.traits || []).some((t) => t === 'G Team' || t === 'Preventer')
  );
  if (!hasAlly) return false;
  const candidates = opponentOf(state, player).battleArea.filter((u) => (u.def.level || 0) <= 4);
  const target = context.target || (context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0]);
  if (!target) return false;
  instance.activationsUsed.debuffEnemy = true;
  target.buffs.push({ ap: -1, scope: 'turn' });
  return true;
}

// --- Gavane's Borjarnon GD05-080 (Unit) ---
// (data-only, vanilla.)

// --- Cagalli Yula Athha GD05-083 (Pilot) ---
// [Burst] Add this card to your hand. [When Paired] Choose 1 enemy Unit with 1 HP. Return it to
// its owner's hand.
function cagalliYulaAthhaGD05WhenPaired(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) === 1);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Odelo Henrik GD05-084 (Pilot) ---
// [Burst] Add this card to your hand. When one of your (League Militaire) Unit tokens receives
// enemy effect damage, reduce it by 1 (data field `auraReduceTokenEffectDamage`, read by
// management.js's dealDamage).

// --- Kayra Su GD05-086 (Pilot) ---
// [Burst] Add this card to your hand. [During Link] Enemy Units other than Link Units choose this
// rested Unit as their attack target if possible when attacking (data field `duringLinkTaunt`,
// read by the AI's getForcedAttackTargets).

// --- Lauda Neill GD05-087 (Pilot) ---
// [Burst] Add this card to your hand. While this Unit is (Academy), it gains <High-Maneuver> (data
// field `keywordIfUnitTrait`, read by management.js's getKeywords).

// --- Prospera Mercury GD05-088 (Pilot) ---
// [Burst] Add this card to your hand. This Unit and all your Units with "Gundam Lfrith" or
// "Gundnode" in their card name get AP+1 -- re-evaluated each start of turn onto a dedicated field
// (instance.prosperaApBonus, read by management.js's getAP) so it doesn't collide with any target
// unit's own unrelated grantedStatBonus recompute.
function prosperaMercuryStartOfTurn(state, player, instance) {
  for (const u of player.battleArea) {
    const name = u.def.name || '';
    u.prosperaApBonus = u === instance || name.includes('Gundam Lfrith') || name.includes('Gundnode') ? 1 : 0;
  }
}

// --- Stellar Loussier (R+) GD05-090 (Pilot) ---
// [Burst] Add this card to your hand. [Destroyed] Look at the top card of your deck. If it is a
// (Phantom Pain) card, you may reveal it and add it to your hand. Return any remaining card to the
// bottom of your deck.
function stellarLoussierRPlusDestroyed(state, player) {
  const top = player.deck.shift();
  if (!top) return;
  if ((top.def.traits || []).includes('Phantom Pain')) player.hand.push(top);
  else player.deck.push(top);
}

// --- Sting Oakley GD05-091 (Pilot) ---
// [Burst] Add this card to your hand. While an enemy player has 7 or more cards in their trash,
// this Unit gets AP+1 and HP+1 -- re-evaluated each start of turn like Michaelis/M1 Astray above.
function stingOakleyStartOfTurn(state, player, instance) {
  const opponent = opponentOf(state, player);
  instance.grantedStatBonus = opponent.trash.length >= 7 ? { ap: 1, hp: 1 } : {};
}

// --- Auel Neider GD05-092 (Pilot) ---
// [Burst] Add this card to your hand. [During Link][Attack] If you are attacking the enemy player,
// this Unit gets AP+2 during this battle.
function auelNeiderAttack(state, player, unit, context) {
  if (!unit.isLinkUnit) return;
  if (!context.target || context.target.type !== 'player') return;
  unit.buffs.push({ ap: 2, scope: 'battle' });
}

// --- Quess Paraya GD05-094 (Pilot) ---
// [Burst] Add this card to your hand. [Destroyed] Choose 1 of your (Neo Zeon) Units. During this
// turn, when it receives enemy battle damage, reduce it by 2 (a chosen-target, turn-scoped
// `battleDamageReduction` buff, read by management.js's dealDamage).
function quessParayaDestroyed(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Neo Zeon'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ battleDamageReduction: 2, scope: 'turn' });
}

// --- Gyunei Guss GD05-095 (Pilot) ---
// [Burst] Add this card to your hand. While this Unit is (Neo Zeon), it gains <Blocker> (data field
// `keywordIfUnitTrait`, read by management.js's getKeywords).

// === GD05 batch 5 (missing-number sweep, sourced from tcgcsv.com rules text) ===

// --- Chad Chadan GD05-096 (Pilot) ---
// [Burst] Add this card to your hand. [Attack] You may deal 1 damage to this Unit. If you do, choose
// 1 of your other (Tekkadan) Units. It recovers 1 HP. Heuristic: only self-damages when there's a
// valid ally to heal, since the "may" is otherwise pure downside.
function chadChadanAttack(state, player, unit) {
  const candidates = player.battleArea.filter((u) => u !== unit && (u.def.traits || []).includes('Tekkadan'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  dealDamage(unit, 1);
  recoverHP(target, 1);
}

// --- Trowa Barton GD05-099 (Pilot) ---
// [Burst] Add this card to your hand. During your turn, when this Unit destroys an enemy Unit with
// battle damage, draw 1. Then, discard 1.
function trowaBartonGD05DestroysEnemy(state, player) {
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Quatre Raberba Winner GD05-100 (Pilot) ---
// [Burst] Add this card to your hand. [When Paired] Choose 1 enemy Unit that is Lv.5 or lower. Rest it.
function quatreRaberbaWinnerGD05WhenPaired(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  restEnemyByEffect(state, player, opponent, target);
}

// --- Gavane Goonny GD05-101 (Pilot) ---
// [Burst] Add this card to your hand. [Once per Turn] When you pay (1) or more for one of your
// Unit's effects, if this is a (Militia) Unit, it may recover 2 HP -- friendlyPaysAbilityCost
// broadcast (Sochie Heim GD04-100/Willgem GD04-129 precedent), affecting context.source rather than
// the broadcast-receiving instance itself.
function gavaneGoonnyGD05FriendlyPaysAbilityCost(state, player, unit, context) {
  if (unit.activationsUsed.militiaHealFromCost) return;
  if (context.amount < 1) return;
  if (!(context.source.def.traits || []).includes('Militia')) return;
  unit.activationsUsed.militiaHealFromCost = true;
  recoverHP(context.source, 2);
}

// --- Wings of Light (R+) GD05-102 (Command) ---
// [Action] Choose 1 of the following: bounce 1 enemy Unit with 5 or less HP, or heal 1 Unit 3 HP.
// Heuristic: bounce if a valid target exists (better tempo), else heal the most-damaged friendly.
function wingsOfLightRPlusCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const bounceCandidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 5);
  if (bounceCandidates.length > 0) {
    const target = context.hooks && context.hooks.chooseUnit
      ? context.hooks.chooseUnit(bounceCandidates)
      : bounceCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
    removeFromField(opponent, target, opponent.hand);
    sendToZone(opponent.hand, target);
    return;
  }
  const healCandidates = [...player.battleArea, player.base].filter(Boolean);
  const healTarget = healCandidates.sort((a, b) => b.damage - a.damage)[0];
  if (healTarget && healTarget.damage > 0) recoverHP(healTarget, 3);
}

// --- Not with Scattershot! GD05-103 (Command, pilotMode: Buran Blutarch) ---
// [Main]/[Action] Choose 1 friendly Unit. It recovers 1 HP and gets AP+2 during this turn.
function notWithScattershotCommand(state, player, instance, context) {
  const candidates = player.battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : [...candidates].sort((a, b) => b.damage - a.damage)[0];
  if (!target) return;
  recoverHP(target, 1);
  target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- At the Risk of One's Life GD05-104 (Command, pilotMode: Helen Jackson) ---
// [Action] Choose 1 friendly (Shrike Team) Unit. It gains the following effect during this turn:
// [During Link][Destroyed] Choose 1 friendly (League Militaire) Unit. Set it as active. Implemented
// via the new generic grantedEffect buff (fireCardEffect, src/rules/effects.js).
function atTheRiskOfOnesLifeDestroyedHandler(state, player, instance) {
  if (!instance.isLinkUnit) return;
  const candidates = player.battleArea.filter((u) => u.rested && (u.def.traits || []).includes('League Militaire'));
  if (candidates.length === 0) return;
  setActiveByEffect(state, player, candidates[0]);
}
function atTheRiskOfOnesLifeCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Shrike Team'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates[0];
  if (!target) return;
  target.buffs.push({ grantedEffect: { eventName: 'destroyed', fn: atTheRiskOfOnesLifeDestroyedHandler }, scope: 'turn' });
}

// --- Exclusively Defense-Oriented Policy GD05-105 (Command) ---
// [Burst] Activate this card's [Main]. [Main]/[Action] Choose 1 enemy Unit that is Lv.3 or lower.
// Return it to its owner's hand.
function exclusivelyDefenseOrientedPolicyCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}
function exclusivelyDefenseOrientedPolicyBurst(state, player, instance) {
  exclusivelyDefenseOrientedPolicyCommand(state, player, instance, {});
}

// --- Mutual Attraction (R+) GD05-106 (Command) ---
// [Main] Choose 1 of the following: place 1 rested Resource, or retrieve 1 Lv.5+ Pilot from trash.
// Heuristic: prefer retrieving a Pilot when one's available (bigger tempo swing), else ramp.
function mutualAttractionRPlusCommand(state, player, instance, context) {
  const pilotCandidates = player.trash.filter((c) => c.def.type === 'pilot' && (c.def.level || 0) >= 5);
  if (pilotCandidates.length > 0) {
    const chosen = context.hooks && context.hooks.chooseCard
      ? context.hooks.chooseCard(pilotCandidates)
      : pilotCandidates.sort((a, b) => (b.def.apBonus || 0) - (a.def.apBonus || 0))[0];
    player.trash.splice(player.trash.indexOf(chosen), 1);
    player.hand.push(chosen);
    return;
  }
  if (player.resourceDeck.length > 0) {
    const resource = player.resourceDeck.shift();
    resource.rested = true;
    player.resourceArea.push(resource);
  }
}

// --- Interwoven Blessings GD05-107 (Command) ---
// [Burst] Place 1 EX Resource. [Main] Choose 1 enemy player. Destroy the first 2 cards in that
// player's shield area (a direct shield-area destroy, unlike Breach, so it can't reuse applyBreach --
// that redirects into a Base if present, whereas this always hits the shield area itself).
function interwovenBlessingsBurst(state, player) {
  placeExResource(state, player);
}
function interwovenBlessingsCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  for (let i = 0; i < 2 && opponent.shields.length > 0; i++) {
    const shield = destroyTopShield(opponent);
    resolveBurst(state, opponent, shield, context.hooks || {});
  }
}

// --- Overcoming Hardships GD05-108 (Command, pilotMode: Guel Jeturk) ---
// [Action] Choose 1 friendly rested (Academy) Unit. Change a battling enemy Unit's attack target to
// it. Implemented via the existing redirectDamageTarget mechanism (Elan Ceres GD04-087/Lunamaria
// Hawke GD04-095 precedent) onto context.target, the friendly Unit/Base currently under attack.
// Engine-correct but not AI-wired: this engine has no currentBattle state outside resolveAttack's
// own local scope, so nothing yet threads context.target in from an ongoing battle when a Command is
// played (same "not wired into AI" gap as other judgment-timed Activate abilities).
function overcomingHardshipsCommand(state, player, instance, context) {
  const underAttack = context.target;
  if (!underAttack) return;
  const candidates = player.battleArea.filter((u) => u.rested && (u.def.traits || []).includes('Academy'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(b) - getRemainingHP(a))[0];
  if (!target) return;
  underAttack.buffs.push({ redirectDamageTarget: target, scope: 'battle' });
}

// --- Felsi's Plea GD05-109 (Command, pilotMode: Felsi Rollo) ---
// [Action] Choose 1 friendly (Academy) Unit. It recovers 2 HP. Then, if it is paired with a Pilot
// that is Lv.3 or lower, draw 1.
function felsisPleaCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Academy'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : [...candidates].sort((a, b) => b.damage - a.damage)[0];
  if (!target) return;
  recoverHP(target, 2);
  if (target.pilot && (target.pilot.def.level || 0) <= 3) drawCard(state, player);
}

// --- Rose Screamer GD05-113 (Command, pilotMode: George de Sand; pairableFromTrash: MF) ---
// [Main] Choose 1 of your (MF) Units with 4 or less AP. It gets AP+2 during this turn. After
// activating this card's [Main], you may pair this card from your trash with one of your (MF) Units
// (the pairing itself is handled generically by the AI's runCommands via def.pairableFromTrash, same
// as Cyclone Punch GD05-121).
function roseScreamerCommand(state, player, instance, context) {
  player.specialMoveActivatedThisTurn = true;
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('MF') && getAP(u) <= 4);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Newtype Labs Director GD05-115 (Command) ---
// [Burst] Draw 1. [Main] Choose 1 (Neo Zeon) Pilot card from your trash. Add it to your hand.
function newtypeLabsDirectorBurst(state, player) {
  drawCard(state, player);
}
function newtypeLabsDirectorCommand(state, player, instance, context) {
  const candidates = player.trash.filter((c) => c.def.type === 'pilot' && (c.def.traits || []).includes('Neo Zeon'));
  const chosen = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : candidates.sort((a, b) => (b.def.apBonus || 0) - (a.def.apBonus || 0))[0];
  if (!chosen) return;
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);
}

// --- Veteran's Pride GD05-116 (Command, pilotMode: Rezin Schnyder) ---
// [Main]/[Action] Choose 1 enemy Unit that is Lv.2 or lower. Destroy it (Gundam Flauros (Ryusei-Go)
// GD05-060 precedent).
function veteransPrideCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// --- Become a Shield GD05-117 (Command, pilotMode: Ride Mass) ---
// (data-only: byte-identical text to Gundam Barbatos Adapt GD03-056/Mikazuki Augus ST05-010, "Choose
// 1 of your Units and 1 enemy Unit. Deal 1 damage to them" -- reuses gundamBarbatosAdaptDeploy directly.)

// --- Incendiary Spark GD05-118 (Command) ---
// [Main] Choose 1 enemy Unit. It gets AP-2 during this turn. If you use an EX Resource to play this
// card, rest the enemy Unit.
function incendiarySparkCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  reduceEnemyAP(state, player, opponent, target, 2, 'turn');
  if (context.usedExResource) restEnemyByEffect(state, player, opponent, target);
}

// --- A Wind Against Fires (R+) GD05-119 (Command, pilotMode: Zechs Merquise) ---
// [Action] Choose 1 enemy Unit that is battling one of your Units that is Lv.5 or higher. It gets
// AP-3 during this battle. Engine-correct but not AI-wired for the same reason as Overcoming
// Hardships GD05-108 above: no currentBattle state outside resolveAttack's local scope for a Command
// played mid-battle to read which enemy Unit is currently attacking.
function aWindAgainstFiresRPlusCommand(state, player, instance, context) {
  const target = context.target;
  if (!target) return;
  target.buffs.push({ ap: -3, scope: 'battle' });
}

// --- Archangel GD05-123 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield. "During your opponent's turn,
// friendly (Orb) Units can't receive 2 or less enemy effect damage" -- data-only
// (orbEffectDamageImmuneThreshold), read by src/rules/effects.js's dealEffectDamage.

// --- White Ark GD05-124 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield. "During your turn, when you would
// rest a Unit with a friendly (League Militaire) Unit's effect, you may rest this Base instead" --
// an alternative-cost-payment redirect. Not implemented: this engine has no generic "rest a friendly
// Unit as a cost" hook (existing Rest-as-cost abilities like Byarlant GD02-004/Landman Rodi resolve
// the chosen restUnit directly via AI-supplied context, not through a shared payment site this could
// intercept), so there's nowhere for the redirect to plug in without bespoke plumbing at every such
// site for the sake of one card.

// --- Quiet Zero GD05-126 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield. [Activate*Main][Once per Turn] (2): If
// you have a Unit with "Gundam Aerial" in its card name that is Lv.5+ in play, deploy 1 [Gundnode]
// ((Quiet Zero) AP2 HP2 Breach 1) Unit token.
const GUNDNODE_TOKEN = Object.freeze({
  number: 'TOKEN-GUNDNODE', name: 'Gundnode', type: 'unit', color: 'green',
  traits: ['Quiet Zero'], ap: 2, hp: 2, isToken: true, keywords: { breach: 1 }
});
function quietZeroActivateMain(state, player, instance) {
  if (instance.activationsUsed.deployGundnode) return false;
  const active = player.resourceArea.filter((r) => !r.rested);
  if (active.length < 2) return false;
  const hasGundamAerial = player.battleArea.some(
    (u) => (u.def.name || '').includes('Gundam Aerial') && (u.def.level || 0) >= 5
  );
  if (!hasGundamAerial) return false;
  active[0].rested = true;
  active[1].rested = true;
  payAbilityCost(state, player, instance, 2);
  instance.activationsUsed.deployGundnode = true;
  deployUnit(state, player, GUNDNODE_TOKEN);
  return true;
}

// --- Girty Lue GD05-127 (Base) ---
// [Burst]/[Deploy]: simpleBurstBase/simpleBaseDeployAddShield. [Once per Turn] When a friendly
// (Phantom Pain) Unit links, choose 1 enemy Unit. It can't activate [Blocker] during this turn --
// reuses the allyPaired broadcast (fires after isLinkUnit is set), gated to only fire on an actual
// link. New cannotBlock buff checked by heuristic.js's chooseBlocker.
function girtyLueAllyPaired(state, player, instance, context) {
  if (instance.activationsUsed.disableBlocker) return;
  if (!context.pairedUnit.isLinkUnit) return;
  if (!(context.pairedUnit.def.traits || []).includes('Phantom Pain')) return;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  instance.activationsUsed.disableBlocker = true;
  target.buffs.push({ cannotBlock: true, scope: 'turn' });
}

// === EB01 batch 1 (EB01-001 to EB01-020, sourced from tcgcsv.com rules text) ===

// --- Gundam Astray Red Frame Custom (EX) EB01-001 ---
// [ActivateMain][Once per Turn] Exile 2 Command cards from your trash from the game: Choose 1
// damaged enemy Unit that is Lv.7 or lower. Rest it. It won't be set as active during the start
// phase of your opponent's next turn.
function gundamAstrayRedFrameCustomEXActivateMain(state, player, instance) {
  if (instance.activationsUsed.exileCommandsRest) return;
  const commands = player.trash.filter((c) => c.def.type === 'command');
  if (commands.length < 2) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.damage > 0 && (u.def.level || 0) <= 7);
  if (candidates.length === 0) return;
  for (const c of commands.slice(0, 2)) player.trash.splice(player.trash.indexOf(c), 1);
  instance.activationsUsed.exileCommandsRest = true;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  restEnemyByEffect(state, player, opponent, target);
  target.skipNextUntap = true;
}

// --- Hi-Nu Gundam (EX) EB01-002 ---
// [Deploy] If another friendly (G Generation) Unit is in play, choose 1 Unit belonging to each
// enemy player. Rest them.
// [During Link][Attack][Once per Turn] If 3 or more other rested Units are in play, set this Unit
// as active. ("in play" read as both players' fields, same convention as Kikeroga's board-wide text.)
function hiNuGundamEXDeploy(state, player, instance) {
  const others = player.battleArea.filter((u) => u !== instance && (u.def.traits || []).includes('G Generation'));
  if (others.length === 0) return;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  restEnemyByEffect(state, player, opponent, target);
}
function hiNuGundamEXAttack(state, player, instance) {
  if (!instance.isLinkUnit) return;
  if (instance.activationsUsed.setActiveOnAttack) return;
  const opponent = opponentOf(state, player);
  const restedElsewhere = [...player.battleArea, ...opponent.battleArea].filter(
    (u) => u !== instance && u.rested
  ).length;
  if (restedElsewhere < 3) return;
  instance.activationsUsed.setActiveOnAttack = true;
  setActiveByEffect(state, player, instance);
}

// --- Narrative Gundam A-Packs (EX) EB01-003 ---
// <Repair 2> (data). At the end of your turn, if this Unit is rested, rest all Units. If this
// effect rested 3 or more Units, draw 1.
function narrativeGundamAPacksEXEndOfTurn(state, player, instance) {
  if (state.players[state.activePlayerIdx] !== player) return;
  if (!instance.rested) return;
  const opponent = opponentOf(state, player);
  let restedCount = 0;
  for (const u of player.battleArea) {
    if (!u.rested) {
      u.rested = true;
      restedCount++;
    }
  }
  for (const u of opponent.battleArea) {
    if (!u.rested) {
      restEnemyByEffect(state, player, opponent, u);
      restedCount++;
    }
  }
  if (restedCount >= 3) drawCard(state, player);
}

// --- Gundam Barbatos Lupus Rex (EX) EB01-004 ---
// <Repair 2> (data). [Once per Turn] During your turn, when this Unit recovers HP, choose 1 rested
// enemy Unit. Deal 1 damage to it. (Fired via applyRepairAtEndOfTurn's recoversHP event, same shape
// as Four Murasame GD02-085.)
function gundamBarbatosLupusRexEXRecoversHP(state, player, unit) {
  if (unit.activationsUsed.recoverHPDamage) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  unit.activationsUsed.recoverHPDamage = true;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 1);
}

// --- Zeta Gundam III P2 Type EB01-005 ---
// [Deploy] Choose 1 rested Unit belonging to another player. Set it as active. Draw 1.
function zetaGundamIIIP2TypeDeploy(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length > 0) {
    const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
    setActiveByEffect(state, opponent, target);
  }
  drawCard(state, player);
}

// --- Gundam Astray Gold Frame Amatsu EB01-006 ---
// [Deploy] Choose 1 of your Units. It gains [Repair 1] during this turn.
function gundamAstrayGoldFrameAmatsuDeploy(state, player) {
  if (player.battleArea.length === 0) return;
  const target = player.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  target.buffs.push({ repair: 1, scope: 'turn' });
}

// --- Gundam Delta Kai EB01-008 ---
// [Deploy • Development 1] You may exile the specified number of (G Generation) cards in your trash
// from the game. If you do: Choose 1 friendly Unit. It recovers 2 HP.
function gundamDeltaKaiDeploy(state, player) {
  const damaged = player.battleArea.filter((u) => u.damage > 0);
  if (damaged.length === 0) return;
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length === 0) return;
  player.trash.splice(player.trash.indexOf(ggenCards[0]), 1);
  const target = damaged.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  recoverHP(target, 2);
}

// --- Gundam Full Armor (Thunderbolt) (EX) EB01-009 ---
// [Deploy] All enemy players each choose 1 of their active Units. Rest them.
function gundamFullArmorThunderboltEXDeploy(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => !u.rested);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  restEnemyByEffect(state, player, opponent, target);
}

// --- Gundam Barbatos 6th Form EB01-010 ---
// [Deploy • Development 3] You may exile the specified number of (G Generation) cards in your trash
// from the game. If you do: Choose 1 rested enemy Unit. Deal 2 damage to it.
function gundamBarbatos6thFormDeploy(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length < 3) return;
  for (const c of ggenCards.slice(0, 3)) player.trash.splice(player.trash.indexOf(c), 1);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 2);
}

// --- Red Gundam(0085) EB01-013 ---
// [Attack] If an enemy player has 6 or more cards in their hand, this Unit gets AP+2 during this turn.
function redGundam0085Attack(state, player, unit) {
  const opponent = opponentOf(state, player);
  if (opponent.hand.length >= 6) unit.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Gouf Vijayanta EB01-014 ---
// "During your opponent's turn, this Unit can't receive effect damage from enemy Units that are
// Lv.5 or lower." Not implemented: dealEffectDamage is only ever called with the damage's source
// PLAYER, not the specific source Unit instance, so there's no way to check the source's level here
// without threading a new parameter through every existing call site -- left as a documented
// simplification, same shape as White Ark GD05-124's un-plumbed alternative-cost text.

// --- Prototype Asshimar TR-3 "Kehaar" EB01-015 ---
// [Destroyed] If there are 2 or more other rested Units in play, choose 1 rested enemy Unit. Deal 1
// damage to it. ("in play" read as both players' fields, same as Hi-Nu Gundam EB01-002 above.)
function prototypeAsshimarTR3Destroyed(state, player, instance) {
  const opponent = opponentOf(state, player);
  const restedElsewhere = [...player.battleArea, ...opponent.battleArea].filter(
    (u) => u !== instance && u.rested
  ).length;
  if (restedElsewhere < 2) return;
  const candidates = opponent.battleArea.filter((u) => u.rested);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 1);
}

// --- Haro EB01-017 ---
// [Destroyed] If this Unit is destroyed with battle damage, you and the player who destroyed this
// Unit draw 1. (viaBattleDamage is a new destroyAndFireEffect extraContext flag, set only at its
// real battle-damage call sites in combat.js -- registry.js's own effect-damage destroys leave it
// unset, so this correctly only fires on an actual battle kill.)
function haroDestroyed(state, player, instance, context) {
  if (!context.viaBattleDamage) return;
  drawCard(state, player);
  drawCard(state, opponentOf(state, player));
}

// --- Gundam Astray Blue Frame Second L EB01-018 ---
// [Attack] Choose 1 friendly Unit. It recovers 1 HP.
function gundamAstrayBlueFrameSecondLAttack(state, player) {
  const damaged = player.battleArea.filter((u) => u.damage > 0);
  if (damaged.length === 0) return;
  const target = damaged.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  recoverHP(target, 1);
}

// --- Gundam Pixy EB01-019 ---
// [Attack] If there are 2 or more other rested Units in play, this Unit gains [High-Maneuver] during
// this battle. ("in play" read as both players' fields, same as EB01-002/EB01-015 above.)
function gundamPixyAttack(state, player, unit) {
  const opponent = opponentOf(state, player);
  const restedElsewhere = [...player.battleArea, ...opponent.battleArea].filter(
    (u) => u !== unit && u.rested
  ).length;
  if (restedElsewhere < 2) return;
  unit.buffs.push({ keyword: 'highManeuver', scope: 'battle' });
}

// --- Gundam Mk-III EB01-020 ---
// [During Link][Activate·Action][Once per Turn] Choose 1 Unit. It recovers 1 HP. Byte-identical text
// to G-Sky Easy GD01-014, so its function (gSkyEasyActivateAction, also engine-correct-but-not-AI-
// wired) is reused directly rather than duplicated.

// === EB01 batch 2 (EB01-021 to EB01-040, sourced from tcgcsv.com rules text) ===

// --- Build Strike Gundam (Full Package) (EX) EB01-021 ---
// <Breach 4> (data). [When Paired(G Generation) Pilot] If there are 2 or more (G Generation) Unit
// cards in your trash, place 1 rested Resource. Same shape as Gundam Deathscythe GD01-025's paired
// resource-placement.
function buildStrikeGundamFullPackageEXWhenPaired(state, player, unit, context) {
  const pilot = context.pilot;
  if (!pilot || !(pilot.def.traits || []).includes('G Generation')) return;
  const ggenInTrash = player.trash.filter((c) => (c.def.traits || []).includes('G Generation')).length;
  if (ggenInTrash < 2) return;
  if (player.resourceDeck.length) {
    const resource = player.resourceDeck.shift();
    resource.rested = true;
    player.resourceArea.push(resource);
  }
}

// --- Gundam Exia (EX) EB01-022 ---
const GUNDAM_EXIA_TOKEN = Object.freeze({
  number: 'TOKEN-GUNDAM-EXIA',
  name: 'Gundam Exia',
  type: 'unit',
  traits: ['G Generation'],
  ap: 2,
  hp: 2,
  isToken: true
});
// <Breach 5> (data). [During Pair(G Generation) Pilot] At the end of your turn, you may destroy
// this Unit. If you do, deploy 3 [Gundam Exia] ((G Generation) AP2 HP2) Unit tokens. (Heuristic
// default: always take it -- 3 bodies for 1 reads as value-positive.)
function gundamExiaEXEndOfTurn(state, player, instance) {
  if (state.players[state.activePlayerIdx] !== player) return;
  if (!instance.pilot || !(instance.pilot.def.traits || []).includes('G Generation')) return;
  destroyOutrightAndFireEffect(state, player, instance);
  for (let i = 0; i < 3; i++) deployUnit(state, player, GUNDAM_EXIA_TOKEN);
}

// --- Le Cygne (EX) EB01-023 ---
// [Attack] All players each look at the top card of their deck. If it is a card that is Lv.5 or
// higher, they may reveal it and add it to their hand. They return any remaining card to the top or
// bottom of their deck. (Heuristic default: always take a Lv.5+ hit; a non-match just stays on top,
// so "return to top" is a no-op.)
function leCygneEXAttack(state, player) {
  const opponent = opponentOf(state, player);
  for (const p of [player, opponent]) {
    if (p.deck.length === 0) continue;
    const top = p.deck[0];
    if ((top.def.level || 0) >= 5) {
      p.deck.shift();
      p.hand.push(top);
    }
  }
}

// --- GQuuuuuuX (Omega Psycommu) EB01-024 ---
// <Breach 3> (data). [Attack] Choose 1 enemy Unit with [Blocker] that is Lv.5 or lower. Deal 2
// damage to it.
function gQuuuuuuXOmegaPsycommuAttack(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getKeywords(u).blocker && (u.def.level || 0) <= 5);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  dealEffectDamage(state, player, opponent, target, 2);
}

// --- Tallgeese II EB01-025 ---
// [Deploy • Development 2] You may exile the specified number of (G Generation) cards in your trash
// from the game. If you do: All players place 1 EX Resource. [During Pair] While your opponent has
// an EX Resource, this Unit can't receive battle damage from enemy Units that are Lv.5 or lower (data
// field duringPairLowLevelEnemyDamageImmuneCapIfOpponentEX, read by combat.js's
// isImmuneToLowLevelEnemyDamageWhilePaired).
function tallgeeseIIDeploy(state, player) {
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length < 2) return;
  for (const c of ggenCards.slice(0, 2)) player.trash.splice(player.trash.indexOf(c), 1);
  placeExResource(state, player);
  placeExResource(state, opponentOf(state, player));
}

// --- Tallgeese EB01-027 ---
// [Deploy • Development 2] You may exile the specified number of (G Generation) cards in your trash
// from the game. If you do: Choose 1 friendly (G Generation) Unit. It gains [Breach 1] during this
// turn.
function tallgeeseDeploy(state, player) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('G Generation'));
  if (candidates.length === 0) return;
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length < 2) return;
  for (const c of ggenCards.slice(0, 2)) player.trash.splice(player.trash.indexOf(c), 1);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ breach: 1, scope: 'turn' });
}

// --- Gundam Plutone EB01-028 ---
// [Once per Turn] When another Unit attacks an enemy Unit, if this Unit is rested, the attacking
// Unit gains [Breach 2] during this battle. (allyAttack broadcast, same shape as The-O GD03-002.)
function gundamPlutoneAllyAttack(state, player, instance, context) {
  if (instance.activationsUsed.grantBreach) return;
  if (!instance.rested) return;
  if (context.target.type !== 'unit') return;
  instance.activationsUsed.grantBreach = true;
  context.attacker.buffs.push({ breach: 2, scope: 'battle' });
}

// --- Gundam Astaroth Rinascimento (EX) EB01-029 ---
// [Deploy] If 5 or more enemy Units are in play, deal 2 damage to all Units with [Blocker] that are
// Lv.4 or lower. ("all Units" read as both players' fields, same convention as EB01-002/015/019.)
function gundamAstarothRinascimentoEXDeploy(state, player) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length < 5) return;
  const targets = [...player.battleArea, ...opponent.battleArea].filter(
    (u) => getKeywords(u).blocker && (u.def.level || 0) <= 4
  );
  for (const u of targets) {
    const owner = player.battleArea.includes(u) ? player : opponent;
    dealEffectDamage(state, player, owner, u, 2);
  }
}

// --- Big-Rang EB01-030 / Gundam Lfrith Ur EB01-034 ---
// Both: "Look at the top 3 cards of your deck. You may reveal 1 (G Generation) Unit card that is
// Lv.3 among them and add it to your hand. Return the remaining cards randomly to the bottom of
// your deck." -- byte-identical text (Big-Rang on Deploy, Gundam Lfrith Ur on When Linked), so
// shared as one helper.
function lookTop3RevealGGenerationLv3(state, player) {
  const top3 = player.deck.splice(0, 3);
  const matchIdx = top3.findIndex(
    (c) => c.def.type === 'unit' && (c.def.traits || []).includes('G Generation') && (c.def.level || 0) === 3
  );
  if (matchIdx !== -1) {
    const [chosen] = top3.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}
function bigRangDeploy(state, player) {
  lookTop3RevealGGenerationLv3(state, player);
}
function gundamLfrithUrWhenLinked(state, player) {
  lookTop3RevealGGenerationLv3(state, player);
}

// --- Oggo EB01-031 ---
// This Unit may choose an active enemy Unit that is Lv.3 or lower as its attack target (data field
// `activeTargetLevelCap`, read by the AI's chooseAttackTarget -- same shape as Wing Gundam ST02-001).

// --- Taurus (Sanc Kingdom) EB01-033 ---
// [Activate·Action][Once per Turn] (1): Choose 1 other Unit that is being attacked. It gets AP+1
// during this battle. (Engine-correct, not wired into the AI -- Activate·Action abilities aren't
// modeled by runActivations, same known simplification as G-Sky Easy GD01-014.)
function taurusSancKingdomActivateAction(state, player, instance, context) {
  const target = context.target;
  if (!target || target === instance) return;
  target.buffs.push({ ap: 1, scope: 'battle' });
}

// --- Gundam Lfrith Thorn EB01-035 ---
// When another friendly (G Generation) Unit that is Lv.3 is deployed, this Unit gains [Breach 1]
// during this turn.
function gundamLfrithThornFriendlyUnitDeployed(state, player, instance, context) {
  const deployed = context.deployedUnit;
  if (!deployed || deployed === instance) return;
  if (!(deployed.def.traits || []).includes('G Generation') || (deployed.def.level || 0) !== 3) return;
  instance.buffs.push({ breach: 1, scope: 'turn' });
}

// --- Darilbalde EB01-036 ---
// During your turn, all other (G Generation) Units that are Lv.3 get AP+1. Re-granted as a
// turn-scoped buff each of the controller's own startOfTurn (same live-recompute philosophy as
// Jerid Messa GD02-086's grantedStatBonus, but via a plain scope:'turn' AP buff since it targets
// other Units, not itself).
function darilbaldeStartOfTurn(state, player, instance) {
  if (state.players[state.activePlayerIdx] !== player) return;
  const targets = player.battleArea.filter(
    (u) => u !== instance && (u.def.traits || []).includes('G Generation') && (u.def.level || 0) === 3
  );
  for (const u of targets) u.buffs.push({ ap: 1, scope: 'turn' });
}

// --- Zudah Unit 1 EB01-037 ---
// During your turn, while this Unit is battling an enemy Unit with [Blocker], this Unit can't
// receive battle damage (data field `immuneToBattleDamageWhileBattlingBlocker`, read by combat.js's
// isImmuneWhileBattlingBlocker).

// --- G-Self EB01-038 ---
// [Deploy] Place 1 EX Resource. Byte-identical text to Wing Gundam (Bird Mode) ST02-002, whose
// function is reused directly.

// --- Rising Freedom Gundam EB01-039 ---
// "When playing this card from your hand, if 3 or more enemy Units are in play, play it as if it
// has 3 Lv. and cost." Not implemented: an alternate-cost-on-condition mechanic with no existing
// plumbing into the deploy-from-hand cost/level resolution (src/rules/cost.js, actions.js) -- left
// as a documented simplification, same shape as White Ark GD05-124's un-plumbed alternative cost.

// --- Gundam Epyon EB01-040 ---
// "[Deploy] If there are 2 or more enemy players, choose 1 to 3 friendly Units. They gain [Breach 3]
// during this turn." This engine is strictly 2-player, so "2 or more enemy players" is never true --
// correctly a permanent no-op here, not a simplification.

// === EB01 batch 3 (EB01-041 to EB01-060, sourced from tcgcsv.com rules text) ===

// --- Strike Freedom Gundam (EX) EB01-041 ---
// <High-Maneuver> (data). [Deploy] Choose 1 Unit with 4 or less HP belonging to each enemy player.
// Return them to their owners' hands.
function strikeFreedomGundamEXDeploy(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Psycho Haro (EX) EB01-042 ---
// "While this Unit is rested, all Units gain [Blocker]" (data field `grantsBlockerToAllWhileRested`,
// read by the AI's chooseBlocker -- see heuristic.js). [Attack] Units that are Lv.7 or lower can't
// activate [Blocker] during this battle -- reuses the existing cannotBlock buff (Girty Lue GD05-127).
function psychoHaroEXAttack(state, player, instance) {
  const opponent = opponentOf(state, player);
  for (const u of opponent.battleArea) {
    if ((u.def.level || 0) <= 7) u.buffs.push({ cannotBlock: true, scope: 'battle' });
  }
}

// --- Blue Destiny Unit-1 (EX) EB01-043 ---
// [Attack] If a friendly Unit with [Blocker] is in play, choose 1 enemy Unit that is Lv.5 or lower.
// It gets AP-2 during this battle.
function blueDestinyUnit1EXAttack(state, player) {
  if (!player.battleArea.some((u) => getKeywords(u).blocker)) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 5);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  reduceEnemyAP(state, player, opponent, target, 2, 'battle');
}

// --- Justice Gundam (EX) EB01-044 ---
// <Blocker> (data). "[Deploy] If there are 2 or more enemy players, choose 1 Unit belonging to an
// enemy player with the most Units. Return it to its owner's hand." Always false in this strictly
// 2-player engine, same as Gundam Epyon EB01-040 above.

// --- Psycho Zaku (EX) EB01-045 ---
// <Suppression> (data). [When Paired] Choose 1 enemy Unit with [Repair]. Return it to its owner's
// hand.
function psychoZakuEXWhenPaired(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getKeywords(u).repair);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Striker Custom (EX) EB01-046 ---
// [During Pair][Attack] Choose 1 enemy Unit that is Lv.4 or higher. It gets AP-2 during this battle.
function strikerCustomEXAttack(state, player, unit) {
  if (!unit.pilot) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) >= 4);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  reduceEnemyAP(state, player, opponent, target, 2, 'battle');
}

// --- Casval's Gundam EB01-047 ---
// [When Paired • Development 1] You may exile the specified number of (G Generation) cards in your
// trash from the game. If you do: This Unit gains [High-Maneuver] during this turn.
function casvalsGundamWhenPaired(state, player, unit) {
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length === 0) return;
  player.trash.splice(player.trash.indexOf(ggenCards[0]), 1);
  unit.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Pale Rider (Ground Heavy Equipment Type) EB01-049 ---
// While a friendly (G Generation) Unit with [Blocker] is in play, this Unit gains [Suppression] --
// re-evaluated at the start of every turn via grantedKeywords, same turn-granularity approximation
// as Freedom Gundam ST09-004's Base-conditioned Suppression grant.
function paleRiderGroundHeavyEquipmentTypeStartOfTurn(state, player, instance) {
  instance.grantedKeywords.suppression = player.battleArea.some(
    (u) => u !== instance && (u.def.traits || []).includes('G Generation') && getKeywords(u).blocker
  );
}

// --- Saikoro Gundam EB01-050 ---
// [Attack] Place the top card of your deck into your trash. If you placed a card that is Lv.3 or
// higher with this effect, choose 1 enemy Unit. It gets AP-2 during this battle.
function saikoroGundamAttack(state, player) {
  if (player.deck.length === 0) return;
  const card = player.deck.shift();
  player.trash.push(card);
  if ((card.def.level || 0) < 3) return;
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length === 0) return;
  const target = opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  reduceEnemyAP(state, player, opponent, target, 2, 'battle');
}

// --- Hildolfr EB01-052 ---
// [Deploy] If 3 or more enemy Units are in play, choose 1 enemy Unit with 2 or less HP. Return it to
// its owner's hand.
function hildolfrDeploy(state, player) {
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length < 3) return;
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 2);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Dom Gross Beil EB01-055 ---
// "If there are 2 or more enemy players and this Unit is rested, friendly Shields can't receive
// battle damage from enemy Units." Always false in this strictly 2-player engine, same as Gundam
// Epyon EB01-040 above.

// --- Gundam Geminass 02 EB01-057 ---
// [Deploy] You may choose 1 active friendly Unit that is Lv.3. Rest it. If you do, choose 1 enemy
// Unit that is Lv.2 or lower. Return it to its owner's hand.
function gundamGeminass02Deploy(state, player) {
  const opponent = opponentOf(state, player);
  const enemyCandidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 2);
  if (enemyCandidates.length === 0) return;
  const restCandidates = player.battleArea.filter((u) => !u.rested && (u.def.level || 0) === 3);
  if (restCandidates.length === 0) return;
  restCandidates[0].rested = true;
  const target = enemyCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Extreme Gundam EB01-058 ---
// "If there are 2 or more enemy players, this Unit gains [Blocker]." Always false in this strictly
// 2-player engine, same as Gundam Epyon EB01-040 above.

// --- Psycho Zaku EB01-059 ---
// [During Link][Attack][Once per Turn] All players each choose 1 of their Resources. Set them as
// active.
function psychoZakuAttack(state, player, instance) {
  if (!instance.isLinkUnit) return;
  if (instance.activationsUsed.setResourceActive) return;
  instance.activationsUsed.setResourceActive = true;
  const opponent = opponentOf(state, player);
  for (const p of [player, opponent]) {
    const rested = p.resourceArea.find((r) => r.rested);
    if (rested) rested.rested = false;
  }
}

// --- Gundam Aquarius EB01-060 ---
// [When Paired • Development 3] You may exile the specified number of (G Generation) cards in your
// trash from the game. If you do: Choose 1 enemy Unit that is Lv.4 or lower. Return it to its
// owner's hand.
function gundamAquariusWhenPaired(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  if (candidates.length === 0) return;
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length < 3) return;
  for (const c of ggenCards.slice(0, 3)) player.trash.splice(player.trash.indexOf(c), 1);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// === EB01 batch 4 (EB01-061 to EB01-072, pilots, sourced from tcgcsv.com rules text) ===

// --- Ellis Claude EB01-061 ---
// [Burst] Add this card to your hand. [When Paired] If a friendly (G Generation) Unit is in play,
// choose 1 enemy Unit that is Lv.3 or lower. Rest it.
function ellisClaudeWhenPaired(state, player) {
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('G Generation'))) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  restEnemyByEffect(state, player, opponent, target);
}

// --- Jona Basta EB01-062 ---
// [Burst] Add this card to your hand. [Attack][Once per Turn] Choose 1 enemy player. They may draw
// 1. If they draw with this effect, draw 1. (Heuristic default: the opponent always takes a free
// draw when offered, since it has no stated downside.)
function jonaBastaAttack(state, player, unit) {
  if (unit.activationsUsed.offerDraw) return;
  unit.activationsUsed.offerDraw = true;
  const opponent = opponentOf(state, player);
  if (opponent.deck.length > 0) {
    drawCard(state, opponent);
    drawCard(state, player);
  }
}

// --- Io Fleming EB01-063 ---
// [Burst] Add this card to your hand. If there are 2 or more other rested Units in play, this Unit
// gains [Repair 2]. Live-recomputed each startOfTurn via grantedKeywords (also read by
// applyRepairAtEndOfTurn), same turn-granularity approximation as Freedom Gundam ST09-004.
function ioFlemingStartOfTurn(state, player, unit) {
  const opponent = opponentOf(state, player);
  const restedElsewhere = [...player.battleArea, ...opponent.battleArea].filter(
    (u) => u !== unit && u.rested
  ).length;
  unit.grantedKeywords.repair = restedElsewhere >= 2 ? 2 : 0;
}

// --- Rondo Gina Sahaku EB01-064 ---
// [Burst] Add this card to your hand. While this Unit has [Repair], it gains [Breach 1]. Same
// live-recompute shape as Io Fleming EB01-063 above.
function rondoGinaSahakuStartOfTurn(state, player, unit) {
  unit.grantedKeywords.breach = getKeywords(unit).repair ? 1 : 0;
}

// --- Meir Siva EB01-065 ---
// [Burst] Add this card to your hand. [When Linked] Choose 1 friendly (G Generation) Unit. It gains
// [Breach 1] during this turn.
function meirSivaWhenLinked(state, player) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('G Generation'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ breach: 1, scope: 'turn' });
}

// --- Reiji EB01-066 ---
// [Burst] Add this card to your hand. [When Paired] Choose 1 friendly (G Generation) Unit. During
// this turn, it may choose an active enemy Unit with [Blocker] as its attack target (new
// `activeTargetIfKeyword` buff, read by the AI's chooseAttackTarget alongside the existing
// activeTargetLevelCap/activeTargetAPCap family).
function reijiWhenPaired(state, player) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('G Generation'));
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ activeTargetIfKeyword: 'blocker', scope: 'turn' });
}

// --- Asuna Elmarit EB01-067 ---
// [Burst] Add this card to your hand. [When Paired] Look at the top 3 cards of your deck. You may
// reveal 1 (G Generation) Unit card among them and return it to the top of your deck. Return the
// remaining cards randomly to the bottom of your deck.
function asunaElmaritWhenPaired(state, player) {
  const top3 = player.deck.splice(0, 3);
  const matchIdx = top3.findIndex((c) => c.def.type === 'unit' && (c.def.traits || []).includes('G Generation'));
  let chosen = null;
  if (matchIdx !== -1) [chosen] = top3.splice(matchIdx, 1);
  player.deck.push(...shuffle(top3));
  if (chosen) player.deck.unshift(chosen);
}

// --- Chall Acustica EB01-068 ---
// [Burst] Add this card to your hand. [During Link][Destroyed] You may return the card paired with
// this Unit to the top of its owner's deck. (context.pilot is this card itself, already moved to
// trash by destroyCard by the time 'destroyed' fires -- same timing as every other Destroyed handler
// reading context.pilot.)
function challAcusticaDestroyed(state, player, instance, context) {
  if (!instance.isLinkUnit || !context.pilot) return;
  const idx = player.trash.indexOf(context.pilot);
  if (idx === -1) return;
  player.trash.splice(idx, 1);
  player.deck.unshift(context.pilot);
}

// --- Beside Pain EB01-069 ---
// [Burst] Add this card to your hand. [Attack] Choose 1 friendly Unit with [Blocker]. It gets AP+2
// during this turn.
function besidePainAttack(state, player) {
  const candidates = player.battleArea.filter((u) => getKeywords(u).blocker);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Daryl Lorenz EB01-070 ---
// [Burst] Add this card to your hand. [During Link][Activate·Action][Once per Turn] (1): If it is
// your opponent's turn, choose 1 Unit. It gets AP+1 during this battle. (Engine-correct, not wired
// into the AI -- Activate·Action abilities aren't modeled by runActivations, same known
// simplification as G-Sky Easy GD01-014/Taurus (Sanc Kingdom) EB01-033.)
function darylLorenzActivateAction(state, player, instance, context) {
  if (state.players[state.activePlayerIdx] === player) return;
  const target = context.target;
  if (!target) return;
  target.buffs.push({ ap: 1, scope: 'battle' });
}

// --- Ittou Tsurugi EB01-071 ---
// [Burst] Add this card to your hand. [During Link] This Unit gets AP+1 (data field `duringLinkAp`,
// already read by getAP -- no registry function needed).

// --- Yuu Kajima EB01-072 ---
// [Burst] Add this card to your hand. [When Paired] Choose 1 active friendly Unit with [Blocker] and
// 1 enemy Unit that is Lv.4 or lower. Rest them. (Each half resolved independently if only one has a
// valid candidate, same lenient "choose 1 X and 1 Y" reading used throughout this set.)
function yuuKajimaWhenPaired(state, player) {
  const friendlyCandidates = player.battleArea.filter((u) => !u.rested && getKeywords(u).blocker);
  if (friendlyCandidates.length > 0) {
    friendlyCandidates.sort((a, b) => getAP(b) - getAP(a))[0].rested = true;
  }
  const opponent = opponentOf(state, player);
  const enemyCandidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 4);
  if (enemyCandidates.length > 0) {
    const target = enemyCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
    restEnemyByEffect(state, player, opponent, target);
  }
}

// === EB01 batch 5 (EB01-073 to EB01-084, commands, sourced from tcgcsv.com rules text) ===

// --- Character Requests EB01-073 ---
// [Burst] Draw 1. [Main] If there are 6 or more rested Units in play, draw 2. ("in play" read as
// both players' fields, same convention used throughout this set.)
function characterRequestsBurst(state, player) {
  drawCard(state, player);
}
function characterRequestsCommand(state, player) {
  const opponent = opponentOf(state, player);
  const restedInPlay = [...player.battleArea, ...opponent.battleArea].filter((u) => u.rested).length;
  if (restedInPlay < 6) return;
  drawCard(state, player);
  drawCard(state, player);
}

// --- Eternal Road EB01-074 ---
// [Burst] Choose 1 enemy Unit with 3 or less HP. Rest it. [Main]/[Action] Choose 1 active friendly
// (G Generation) Unit. Rest it. If you do, all enemy players each choose 1 of their active Units.
// Rest them.
function eternalRoadBurst(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  restEnemyByEffect(state, player, opponent, target);
}
function eternalRoadCommand(state, player) {
  const candidates = player.battleArea.filter((u) => !u.rested && (u.def.traits || []).includes('G Generation'));
  if (candidates.length === 0) return;
  candidates[0].rested = true;
  const opponent = opponentOf(state, player);
  const enemyCandidates = opponent.battleArea.filter((u) => !u.rested);
  if (enemyCandidates.length > 0) {
    const target = enemyCandidates.sort((a, b) => getAP(b) - getAP(a))[0];
    restEnemyByEffect(state, player, opponent, target);
  }
}

// --- Fierce Enemy Assault EB01-075 ---
// [Main]/[Action] Choose 1 to 2 enemy Units with 2 or less HP. Rest them.
function fierceEnemyAssaultCommand(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 2).sort((a, b) => getAP(b) - getAP(a));
  for (const target of candidates.slice(0, 2)) restEnemyByEffect(state, player, opponent, target);
}

// --- Gerbera Straight EB01-076 ---
// [Main]/[Action] Choose 1 friendly (G Generation) Unit. It recovers 3 HP. [Pilot] [Lowe Guele]
function gerberaStraightCommand(state, player) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('G Generation') && u.damage > 0);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  recoverHP(target, 3);
}

// --- Master League Begins EB01-077 ---
// [Burst] Add this card to your hand. [Action] Choose 1 rested friendly (G Generation) Unit. Change
// a battling enemy Unit's attack target to it. Engine-correct given a `context.battleTarget`
// {type,instance} reference, but not AI-wired -- there's no hooks.actionStep plumbing offering the
// AI a Command-play opportunity mid-battle, same known simplification as every other Action-timing
// reactive card in this set (SP Conversion Chips EB01-083, Daryl Lorenz EB01-070).
function masterLeagueBeginsBurst(state, player, instance) {
  player.hand.push(instance);
}
function masterLeagueBeginsCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.rested && (u.def.traits || []).includes('G Generation'));
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (!target || !context.battleTarget) return;
  context.battleTarget.type = 'unit';
  context.battleTarget.instance = target;
}

// --- Premium Unit Assembly EB01-078 ---
// [Main] All players each look at the top card of their deck. If it is a Unit card, they may reveal
// it and add it to their hand. They return any remaining card to the top or bottom of their deck.
function premiumUnitAssemblyCommand(state, player) {
  const opponent = opponentOf(state, player);
  for (const p of [player, opponent]) {
    if (p.deck.length === 0) continue;
    const top = p.deck[0];
    if (top.def.type === 'unit') {
      p.deck.shift();
      p.hand.push(top);
    }
  }
}

// --- Modification EB01-079 ---
// [Main] Choose 1 friendly (G Generation) Unit. It can't receive battle damage from enemy Units that
// are Lv.3 or lower during this turn (new lowLevelEnemyDamageImmuneCap buff, read by combat.js's
// isImmuneToLowLevelEnemyDamage on both sides of resolveUnitBattleDamage).
function modificationCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('G Generation'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  target.buffs.push({ lowLevelEnemyDamageImmuneCap: 3, scope: 'turn' });
}

// --- Sturm Faust EB01-080 ---
// [Main]/[Action] Choose 1 (G Generation) Unit. During this turn, it may choose an active enemy Unit
// as its attack target. [Pilot] [Jean Luc Duvall]. Reuses the existing activeTargetLevelCap field
// (chooseAttackTarget) with an uncapped value rather than adding a new "any active enemy" field.
function sturmFaustCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('G Generation'));
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (!target) return;
  target.buffs.push({ activeTargetLevelCap: Infinity, scope: 'turn' });
}

// --- MAP Weapon EB01-081 ---
// [Burst] Add this card to your hand. [Main]/[Action] Choose 1 to 2 enemy Units with 2 or less HP.
// Return them to their owners' hands.
function mapWeaponBurst(state, player, instance) {
  player.hand.push(instance);
}
function mapWeaponCommand(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 2).sort((a, b) => getAP(b) - getAP(a));
  for (const target of candidates.slice(0, 2)) {
    removeFromField(opponent, target, opponent.hand);
    sendToZone(opponent.hand, target);
  }
}

// --- Warship Cruise EB01-082 ---
// [Burst] Activate this card's [Action]. [Action] Choose 1 Unit that is Lv.3 or lower belonging to
// each enemy player. Return them to their owners' hands. Burst-aliases-Action, same shape as
// Exclusively Defense-Oriented Policy GD05-105.
function warshipCruiseCommand(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}
function warshipCruiseBurst(state, player, instance, context) {
  warshipCruiseCommand(state, player, instance, context);
}

// --- SP Conversion Chips EB01-083 ---
// [Action] If it is your opponent's turn, choose 1 Unit. It gets AP+3 during this turn.
// Engine-correct given a context.target, not AI-wired (see Master League Begins EB01-077 above).
function spConversionChipsCommand(state, player, instance, context) {
  if (state.players[state.activePlayerIdx] === player) return;
  const target = context.target;
  if (!target) return;
  target.buffs.push({ ap: 3, scope: 'turn' });
}

// --- 30cm Cannon (APFSDS Round) EB01-084 ---
// [Main]/[Action] Choose 1 Unit with [Blocker]. Set it as active. It can't attack during this turn.
// [Pilot] [Demeziere Sonnen]
function cm30CannonAPFSDSRoundCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = [...player.battleArea, ...opponent.battleArea].filter((u) => getKeywords(u).blocker);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  const owner = player.battleArea.includes(target) ? player : opponent;
  setActiveByEffect(state, owner, target);
  target.buffs.push({ cannotAttack: true, scope: 'turn' });
}

// === EB01 batch 6 (EB01-085 to EB01-090, bases, sourced from tcgcsv.com rules text) ===

// --- Kudelia Aina Bernstein & Isaribi EB01-085 ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, you may choose 1
// active friendly blue (G Generation) Unit and 1 enemy Unit. Rest them.
function kudeliaAinaBernsteinIsaribiDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  const friendlyCandidates = player.battleArea.filter(
    (u) => !u.rested && u.def.color === 'blue' && (u.def.traits || []).includes('G Generation')
  );
  if (friendlyCandidates.length > 0) {
    friendlyCandidates.sort((a, b) => getAP(b) - getAP(a))[0].rested = true;
  }
  const opponent = opponentOf(state, player);
  if (opponent.battleArea.length > 0) {
    const target = opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
    restEnemyByEffect(state, player, opponent, target);
  }
}

// --- Kycilia Zabi & Gwazine EB01-086 ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Once per Turn] When a friendly (G Generation) Unit links, it gains [Repair 2] during this turn
// (allyPaired broadcast, gated on context.pairedUnit.isLinkUnit same as Girty Lue GD05-127).
function kyciliaZabiGwazineAllyPaired(state, player, instance, context) {
  if (instance.activationsUsed.grantRepair) return;
  if (!context.pairedUnit.isLinkUnit) return;
  if (!(context.pairedUnit.def.traits || []).includes('G Generation')) return;
  instance.activationsUsed.grantRepair = true;
  context.pairedUnit.buffs.push({ repair: 2, scope: 'turn' });
}

// --- Marina Ismail & Ptolemaios 2 EB01-087 ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners).
// [Once per Turn] During your turn, when a friendly green (G Generation) Unit destroys an enemy Unit
// with battle damage, choose 1 friendly Unit. It recovers 2 HP. friendlyUnitDestroysEnemy only ever
// fires from the attacking player's own battle-damage kill, so "during your turn" collapses to a
// flat grant (same reasoning as Carta's Graze Ritter's attackerGainsFirstStrike).
function marinaIsmailPtolemaios2FriendlyUnitDestroysEnemy(state, player, instance, context) {
  if (instance.activationsUsed.healOnKill) return;
  if (context.attacker.def.color !== 'green' || !(context.attacker.def.traits || []).includes('G Generation')) return;
  const candidates = player.battleArea.filter((u) => u.damage > 0);
  if (candidates.length === 0) return;
  instance.activationsUsed.healOnKill = true;
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  recoverHP(target, 2);
}

// --- Miorine Rembran & Academy Ship EB01-088 ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand (shared one-liners). All
// friendly (G Generation) Units that are Lv.3 get AP+1 during your opponent's turn -- re-granted as
// a turn-scoped buff at the start of each of the OPPONENT's turns (inverse of Darilbalde EB01-036's
// own-turn version).
function miorineRembranAcademyShipStartOfTurn(state, player, instance) {
  if (state.players[state.activePlayerIdx] === player) return;
  const targets = player.battleArea.filter(
    (u) => (u.def.traits || []).includes('G Generation') && (u.def.level || 0) === 3
  );
  for (const u of targets) u.buffs.push({ ap: 1, scope: 'turn' });
}

// --- Lacus Clyne & Eternal EB01-089 ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, choose 1 rested
// friendly white (G Generation) Unit. Set it as active. It can't attack during this turn.
function lacusClyneEternalDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  const candidates = player.battleArea.filter(
    (u) => u.rested && u.def.color === 'white' && (u.def.traits || []).includes('G Generation')
  );
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  setActiveByEffect(state, player, target);
  target.buffs.push({ cannotAttack: true, scope: 'turn' });
}

// --- Tiffa Adill & Freeden EB01-090 ---
// [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your hand. Then, if it is your turn,
// choose 1 Unit with 2 or less HP belonging to each enemy player. Return them to their owners'
// hands. Deploy only ever resolves on its controller's own turn, so "if it is your turn" collapses
// to a flat grant, same reasoning as Marina Ismail & Ptolemaios 2 EB01-087 above.
function tiffaAdillFreedenDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 2);
  if (candidates.length === 0) return;
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// === ST01 batch ===

// --- Gundam (MA Form) ST01-002 --- Link Condition [Amuro Ray]. [When Paired] Draw 1.
function gundamMAFormWhenPaired(state, player) {
  drawCard(state, player);
}

// --- Guntank ST01-004 --- [Deploy] Choose 1 enemy Unit with 2 or less HP. Rest it.
// (Same text/shape as Guncannon GD01-004's When Paired above, just Deploy-triggered here.)
function guntankST01004Deploy(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => getRemainingHP(u) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.rested = true;
}

// --- Gundam Aerial (Permet Score Six) ST01-006 --- Link Condition [Suletta Mercury]. [When Paired]
// Choose 1 enemy Unit that is Lv.5 or lower. It gets AP-3 during this turn.
function gundamAerialPermetScoreSixWhenPaired(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  reduceEnemyAP(state, player, opponent, target, 3);
}

// --- Suletta Mercury ST01-011 --- [Burst] Add this card to your hand. [Attack][Once per Turn]
// Choose 1 of your Resources. Set it as active.
function sulettaMercuryAttack(state, player, instance) {
  if (instance.activationsUsed.sulettaMercuryAttack) return;
  const rested = player.resourceArea.filter((r) => r.rested);
  if (rested.length === 0) return;
  instance.activationsUsed.sulettaMercuryAttack = true;
  setActiveByEffect(state, player, rested[0]);
}

// --- Thoroughly Damaged ST01-012 (Command, pilotMode: Hayato Kobayashi) ---
// [Main] Choose 1 rested enemy Unit. Deal 1 damage to it.
function thoroughlyDamagedCommand(state, player, instance, context) {
  const candidates = opponentOf(state, player).battleArea.filter((u) => u.rested);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  dealEffectDamage(state, player, opponentOf(state, player), target, 1);
}

// --- Kai's Resolve ST01-013 (Command, pilotMode: Kai Shiden) ---
// [Main] Choose 1 friendly Unit. It recovers 3 HP.
function kaisResolveCommand(state, player, instance, context) {
  const candidates = player.battleArea;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  recoverHP(target, 3);
}

// --- Asticassia School of Technology, Earth House ST01-016 --- [Burst] Deploy this card.
// [Deploy] Add 1 of your Shields to your hand. [Activate Main] Rest this Base: all friendly Link
// Units get AP+1 during this turn. (isaribiActivateMain EB01 precedent for the self-rest gate.)
function asticassiaEarthHouseActivateMain(state, player, instance) {
  if (instance.rested) return false;
  instance.rested = true;
  for (const u of player.battleArea.filter((u) => u.isLinkUnit)) u.buffs.push({ ap: 1, scope: 'turn' });
  return true;
}

// === ST02 batch ===

// --- Gundam Heavyarms ST02-003 --- Link Condition [Trowa Barton]. [During Pair] During your turn,
// when this Unit destroys an enemy Unit with battle damage, deal 1 damage to all enemy Units that
// are Lv.3 or lower. (destroysEnemy only ever fires on the attacker's own battle-damage kill, so
// "During Pair" here just needs instance.pilot -- no separate viaBattleDamage check required.)
function gundamHeavyarmsST02003DestroysEnemy(state, player, instance) {
  if (!instance.pilot) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  const opponent = opponentOf(state, player);
  for (const u of opponent.battleArea.filter((u) => (u.def.level || 0) <= 3)) dealDamage(u, 1);
}

// --- Tallgeese ST02-006 --- [Activate Main][Once per Turn](4) Set this Unit as active.
function tallgeeseST02006ActivateMain(state, player, instance) {
  if (instance.activationsUsed.setActive) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 4) return false;
  for (let i = 0; i < 4; i++) activeResources[i].rested = true;
  instance.activationsUsed.setActive = true;
  setActiveByEffect(state, player, instance);
  return true;
}

// --- Zechs Merquise ST02-011 --- [Burst] Add this card to your hand. [During Link] During your
// turn, when this Unit destroys an enemy Unit with battle damage, draw 1.
function zechsMerquiseDestroysEnemy(state, player, unit) {
  if (!unit.isLinkUnit) return;
  if (state.players[state.activePlayerIdx] !== player) return;
  drawCard(state, player);
}

// --- Simultaneous Fire ST02-012 (Command, pilotMode: Trowa Barton) ---
// [Main] Choose 1 of your Units. It gains [Breach 3] during this turn.
function simultaneousFireCommand(state, player, instance, context) {
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  target.buffs.push({ breach: 3, scope: 'turn' });
}

// --- Peaceful Timbre ST02-013 (Command, pilotMode: Quatre Raberba Winner) ---
// [Action] During this battle, your shield area cards can't receive damage from enemy Units that
// are Lv.4 or lower. (whiteWolfCommand GD02-106 precedent.)
function peacefulTimbreCommand(state, player) {
  player.shieldDamageImmuneLevelCap = 4;
}

// --- Siege Ploy ST02-014 --- [Burst] Activate this card's Main. [Main]/[Action] Choose 1 enemy
// Unit with 5 or less HP. Rest it.
function siegePloyCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) restEnemyByEffect(state, player, opponent, target);
}
function siegePloyBurst(state, player, instance, context) {
  siegePloyCommand(state, player, instance, context);
}

// --- Saint Gabriel Institute ST02-015 --- [Burst] Deploy this card. [Deploy] Add 1 of your
// Shields to your hand. Then, look at the top 2 cards of your deck and return 1 to the top and 1
// to the bottom. (Heuristic: keep a Unit/Base card on top, matching the other top-2-look
// precedents' choice of what's worth keeping accessible.)
function saintGabrielInstituteDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  if (player.deck.length === 0) return;
  const top2 = player.deck.splice(0, 2);
  const keepIdx = top2.findIndex((c) => c.def.type === 'unit' || c.def.type === 'base');
  const keep = top2.splice(keepIdx === -1 ? 0 : keepIdx, 1)[0];
  player.deck.unshift(keep);
  if (top2[0]) player.deck.push(top2[0]);
}

// === ST03 batch ===

// --- Sinanju ST03-001 --- Link Condition [Full Frontal]. duringPairKeywords: {highManeuver} (data).
// During your turn, when this Unit destroys an enemy shield area card with battle damage, choose 1
// enemy Unit. Deal 2 damage to it. (destroysShield only ever fires from the attacker's own turn.)
function sinanjuST03001DestroysShield(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 2);
}

const ZAKU_II_TOKEN = Object.freeze({
  number: 'TOKEN-ZAKU-II',
  name: 'Zaku II',
  type: 'unit',
  color: 'green',
  traits: ['Zeon'],
  ap: 1,
  hp: 1,
  isToken: true,
  keywords: {}
});

// --- Gouf ST03-009 --- Link Condition [Ramba Ral]. [Deploy] Deploy 1 rested [Zaku II] ((Zeon)
// AP1/HP1) Unit token.
function goufST03009Deploy(state, player) {
  const token = deployUnit(state, player, ZAKU_II_TOKEN);
  token.rested = true;
}

// --- Full Frontal ST03-010 (Pilot) --- [Burst] Add this card to your hand. [When Paired] You may
// deploy 1 (Neo Zeon)/(Zeon) Unit card that is Lv.4 or lower from your hand.
function fullFrontalWhenPaired(state, player, unit, context) {
  const candidates = player.hand.filter(
    (c) => c.def.type === 'unit' && ((c.def.traits || []).includes('Neo Zeon') || (c.def.traits || []).includes('Zeon')) && (c.def.level || 0) <= 4
  );
  if (candidates.length === 0) return;
  const chosen = context.hooks && context.hooks.chooseCard
    ? context.hooks.chooseCard(candidates)
    : [...candidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.hand.splice(player.hand.indexOf(chosen), 1);
  deployUnit(state, player, chosen.def);
}

// --- Indignation ST03-012 (Command, pilotMode: Angelo Sauper) ---
// [Main]/[Action] Choose 1 friendly Unit. It gets AP+2 during this turn.
function indignationCommand(state, player, instance, context) {
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- The Blue Giant ST03-014 (Command, pilotMode: Ramba Ral) --- [Action] Choose 1 friendly Unit.
// It can't receive battle damage from enemy Units with 2 or less AP during this battle.
// (isImmuneToLowAPEnemyDamage / lowAPEnemyDamageImmuneCap, Yurin L'Ciel GD03-115 precedent --
// already wired into all of resolveUnitBattleDamage's damage-condition blocks in combat.js.)
function theBlueGiantST03014Command(state, player, instance, context) {
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) target.buffs.push({ lowAPEnemyDamageImmuneCap: 2, scope: 'battle' });
}

// --- Falmel ST03-016 (Base) --- [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your
// hand. Then, if it is your turn, deploy 1 rested [Char's Zaku II] ((Zeon) AP3/HP1) Unit token.
function falmelDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  if (state.players[state.activePlayerIdx] !== player) return;
  const token = deployUnit(state, player, CHARS_ZAKU_TOKEN);
  token.rested = true;
}

// === ST04 batch ===

// --- Strike Gundam ST04-002 --- Link Condition [Kira Yamato]. [Deploy] Draw 1. Then, discard 1.
// (noinsTaurusDestroyed precedent: default discard is the highest-cost card in hand.)
function strikeGundamST04002Deploy(state, player) {
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Miguel's Ginn ST04-009 --- Link Condition [Miguel Ayman]. [During Pair][Destroyed] If you
// have another Link Unit in play, draw 1.
function miguelsGinnST04009Destroyed(state, player, instance, context) {
  if (!context.wasPaired) return;
  if (!player.battleArea.some((u) => u !== instance && u.isLinkUnit)) return;
  drawCard(state, player);
}

// --- Hawk of Endymion ST04-013 (Command, pilotMode: Mu La Flaga) ---
// [Main]/[Action] Choose 1 enemy Unit with 3 or less HP. Return it to its owner's hand.
function hawkOfEndymionCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- The Magic Bullet of Dusk ST04-014 (Command, pilotMode: Miguel Ayman) ---
// [Main]/[Action] Choose 1 friendly Unit that is Lv.2 or lower. It gains [First Strike] during
// this turn.
function theMagicBulletOfDuskCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.level || 0) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ keyword: 'firstStrike', scope: 'turn' });
}

// --- Vesalius ST04-016 (Base) --- [Activate Main] Rest this Base: choose 1 friendly Unit. It gets
// AP+1 during this turn. (isaribiActivateMain self-rest-gate precedent.)
function vesaliusActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return false;
  instance.rested = true;
  target.buffs.push({ ap: 1, scope: 'turn' });
  return true;
}

// === ST05 batch ===

// --- Gundam Barbatos 4th Form ST05-001 --- Link Condition [Mikazuki Augus]. keywordWhileDamaged:
// "suppression" (data, management.js getKeywords). [Deploy] Choose 1 of your other Units. Deal 1
// damage to it. It gets AP+1 during this turn.
function gundamBarbatos4thFormDeploy(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u !== instance);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  dealDamage(target, 1);
  target.buffs.push({ ap: 1, scope: 'turn' });
}

// --- CGS Mobile Worker ST05-003 --- [Activate Main] Rest this Unit: choose 1 of your Units. Deal
// 1 damage to it. It gets AP+1 during this turn.
function cgsMobileWorkerActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return false;
  instance.rested = true;
  dealDamage(target, 1);
  target.buffs.push({ ap: 1, scope: 'turn' });
  return true;
}

// --- Gundam Gusion Rebake ST05-005 --- Link Condition [Akihiro Altland]. [Destroyed] Choose 1
// enemy Unit with 4 or less AP. Rest it.
function gundamGusionRebakeST05005Destroyed(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getAP(u) <= 4);
  const target = candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) restEnemyByEffect(state, player, opponent, target);
}

// --- McGillis' Schwalbe Graze ST05-007 --- <Blocker> (data). Link Condition [McGillis Fareed].
// [When Paired] Choose 1 enemy Unit that is Lv.3 or lower. It gets AP-2 during this turn.
function mcgillisSchwalbeGrazeWhenPaired(state, player, unit, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  reduceEnemyAP(state, player, opponent, target, 2);
}

// --- McGillis Fareed ST05-012 (Pilot) --- [Burst] Add this card to your hand. [When Paired] If
// you have 2 or more other (Gjallarhorn)/(Tekkadan) Units in play, choose 1 enemy Unit with 3 or
// less HP. Rest it.
function mcgillisFareedWhenPaired(state, player, unit, context) {
  const otherCount = player.battleArea.filter(
    (u) => u !== unit && ((u.def.traits || []).includes('Gjallarhorn') || (u.def.traits || []).includes('Tekkadan'))
  ).length;
  if (otherCount < 2) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) restEnemyByEffect(state, player, opponent, target);
}

// --- With Iron and Blood ST05-013 --- [Main]/[Action] Choose 1 of your Units. Deal 1 damage to
// it. It gets AP+3 during this turn.
function withIronAndBloodCommand(state, player, instance, context) {
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  dealDamage(target, 1);
  target.buffs.push({ ap: 3, scope: 'turn' });
}

// --- Fatal Strike ST05-014 --- [Burst] Choose 1 enemy Unit. Deal 1 damage to it.
// [Main] Choose 1 enemy Unit that is Lv.3 or lower. Destroy it.
// (gundamFlaurosRyuseiGoDestroy GD05-060 precedent for the outright-destroy shape.)
function fatalStrikeCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 3 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}
function fatalStrikeBurst(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) dealDamage(target, 1);
}

// === ST06 batch ===

// --- Ruthless Tactics ST06-011 (Command, pilotMode: Gaia (GQ)) ---
// [Main]/[Action] Choose 1 to 2 friendly (Clan) Units. They get AP+2 during this turn.
function ruthlessTacticsCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Clan'));
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : [...candidates].sort((a, b) => getAP(b) - getAP(a)).slice(0, 2);
  for (const t of targets) t.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Fierce Unity ST06-013 (Command, pilotMode: Ortega (GQ)) --- [Action] Choose 1 to 2 friendly
// (Clan) Units. They can't receive battle damage from enemy Units that are Lv.2 or lower during
// this turn. (lowLevelEnemyDamageImmuneCap, Modification EB01-079 precedent.)
function fierceUnityCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Clan'));
  const targets = context.hooks && context.hooks.chooseUnits
    ? context.hooks.chooseUnits(candidates)
    : [...candidates].sort((a, b) => getRemainingHP(a) - getRemainingHP(b)).slice(0, 2);
  for (const t of targets) t.buffs.push({ lowLevelEnemyDamageImmuneCap: 2, scope: 'turn' });
}

// --- Clan Battle ST06-014 (Base) --- [Activate Main] Rest this Base: if a friendly (Clan) Link
// Unit is in play, choose 1 friendly Unit. It gets AP+2 during this turn.
function clanBattleActivateMain(state, player, instance, context) {
  if (instance.rested) return false;
  const hasClanLink = player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('Clan'));
  if (!hasClanLink) return false;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return false;
  instance.rested = true;
  target.buffs.push({ ap: 2, scope: 'turn' });
  return true;
}

// --- Kaneban Co., Ltd. ST06-015 (Base) --- [Once per Turn] When a friendly (Clan) Unit links, it
// gains [Breach 3] during this turn. (allyPaired fires on ANY pairing; context.pairedUnit.isLinkUnit
// distinguishes an actual link, EB01 Kycilia Zabi & Gwazine precedent.)
function kanebanCoLtdAllyPaired(state, player, instance, context) {
  if (instance.activationsUsed.grantBreach) return;
  if (!context.pairedUnit.isLinkUnit) return;
  if (!(context.pairedUnit.def.traits || []).includes('Clan')) return;
  instance.activationsUsed.grantBreach = true;
  context.pairedUnit.buffs.push({ breach: 3, scope: 'turn' });
}

// === ST07 batch ===

// --- Gundam Dynames (LR) ST07-005 --- Link Condition [Lockon Stratos]. duringLinkAp: 2 (data).
// During your turn, when this Unit destroys an enemy Unit with battle damage, this Unit recovers 2
// HP. (destroysEnemy only ever fires on the attacker's own turn, so no separate gate is needed.)
function gundamDynamesLRDestroysEnemy(state, player, instance) {
  recoverHP(instance, 2);
}

// --- Gundam Kyrios (ST07-007) --- Link Condition [Allelujah Haptism]/[Hallelujah Haptism]. During
// your turn, while you have a (CB) Pilot in play, this Unit gets AP+2. (Re-granted each of its own
// startOfTurn -- the turn-scoped buff auto-expires at end of turn via clearTurnBuffs, so it's
// naturally off during the opponent's turn.)
function gundamKyriosST07007StartOfTurn(state, player, instance) {
  if (state.players[state.activePlayerIdx] !== player) return;
  const hasCBPilot = player.battleArea.some((u) => u.pilot && (u.pilot.def.traits || []).includes('CB'));
  if (hasCBPilot) instance.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Tieria Erde ST07-010 (Pilot) --- [Burst] Add this card to your hand. [Destroyed] If it is
// your opponent's turn and this is a (CB) Unit, draw 1. (destroyAndFireEffect forwards the paired
// Unit's own 'destroyed' to the Pilot's handler with `instance` = the destroyed Unit.)
function tieriaErdeST07010Destroyed(state, player, instance) {
  if (state.players[state.activePlayerIdx] === player) return;
  if (!(instance.def.traits || []).includes('CB')) return;
  drawCard(state, player);
}

// --- Lockon Stratos (Neil) ST07-011 (Pilot) --- [Burst] Add this card to your hand. [When Paired]
// If this is a (CB) Unit, it may choose an active enemy Unit whose Lv. is equal to or lower than
// this Unit as its attack target during this turn. (activeTargetLevelCap buff, Oggo EB01 precedent
// -- capped at the paired Unit's own printed level, which doesn't change mid-turn.)
function lockonStratosNeilWhenPaired(state, player, unit) {
  if (!(unit.def.traits || []).includes('CB')) return;
  unit.buffs.push({ activeTargetLevelCap: unit.def.level || 0, scope: 'turn' });
}

// --- Allelujah Haptism ST07-012 (Pilot) --- [Burst] Add this card to your hand. During your turn,
// while you have a (CB) Link Unit in play, this Unit can't receive battle damage from enemy Units
// with 3 or less AP. (Re-granted each of its own startOfTurn, same shape as Gundam Kyrios above;
// `instance` here is the paired Unit, per fireCardEffect's pilot-forwarding.)
function allelujahHaptismStartOfTurn(state, player, instance) {
  if (state.players[state.activePlayerIdx] !== player) return;
  const hasCBLink = player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('CB'));
  if (hasCBLink) instance.buffs.push({ lowAPEnemyDamageImmuneCap: 3, scope: 'turn' });
}

// --- Armed Intervention ST07-013 --- [Burst] Draw 1. [Action] Choose 1 rested friendly (CB) Unit.
// Change the attack target of the battling enemy Unit to it. (masterLeagueBeginsCommand EB01-077
// precedent -- a reactive mid-battle redirect, not AI-wired since no hooks.actionStep producer
// exists yet, same documented gap.)
function armedInterventionBurst(state, player) {
  drawCard(state, player);
}
function armedInterventionCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.rested && (u.def.traits || []).includes('CB'));
  const target = context.hooks && context.hooks.chooseUnit ? context.hooks.chooseUnit(candidates) : candidates[0];
  if (!target || !context.battleTarget) return;
  context.battleTarget.type = 'unit';
  context.battleTarget.instance = target;
}

// --- Tactical Visionary ST07-014 --- [Main] Look at the top 3 cards of your deck. You may reveal
// 1 (CB) Unit card/Pilot card among them and add it to your hand. Return the remaining cards
// randomly to the bottom of your deck.
function tacticalVisionaryCommand(state, player) {
  const top3 = player.deck.splice(0, 3);
  const matchIdx = top3.findIndex(
    (c) => (c.def.type === 'unit' || c.def.type === 'pilot') && (c.def.traits || []).includes('CB')
  );
  if (matchIdx !== -1) {
    const [chosen] = top3.splice(matchIdx, 1);
    player.hand.push(chosen);
  }
  player.deck.push(...shuffle(top3));
}

// === ST08 batch ===

// --- Xi Gundam (LR) ST08-001 --- Link Condition [Hathaway Noa]. handLevelAndCostReductionPerEnemyUnit
// (data, src/rules/cost.js). [When Paired] Choose 1 enemy Unit with the highest Lv. Deal 3 damage
// to it.
function xiGundamST08001WhenPaired(state, player) {
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => (b.def.level || 0) - (a.def.level || 0))[0];
  if (target) dealDamage(target, 3);
}

// --- Xi Gundam (ST08-002) --- Link Condition [Hathaway Noa]. [Deploy] Choose 1 enemy Unit. Deal 1
// damage to it.
function xiGundamST08002Deploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 1);
}

// --- Messer Type-F01 ST08-004 --- Link Condition [Mafty]. [Attack] If this Unit is attacking an
// enemy Unit, choose 1 enemy Unit. Deal 1 damage to it.
function messerTypeF01Attack(state, player, instance, context) {
  if (!context.target || context.target.type !== 'unit') return;
  const opponent = opponentOf(state, player);
  const target = opponent.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (target) dealDamage(target, 1);
}

// --- Penelope (LR) ST08-006 --- Link Condition [Lane Aim]. [During Pair][Attack][Once per Turn]
// If this Unit is attacking the enemy player, reveal 1 (Earth Federation) Unit card from your
// hand. Return it to the bottom of your deck. If you do, draw 2.
function penelopeLRAttack(state, player, instance, context) {
  if (!instance.pilot) return;
  if (instance.activationsUsed.recycleForCards) return;
  if (!context.target || context.target.type !== 'player') return;
  const revealed = player.hand.find((c) => c.def.type === 'unit' && (c.def.traits || []).includes('Earth Federation'));
  if (!revealed) return;
  instance.activationsUsed.recycleForCards = true;
  player.hand.splice(player.hand.indexOf(revealed), 1);
  player.deck.push(revealed);
  drawCard(state, player);
  drawCard(state, player);
}

// --- Gustav Karl Type-00 ST08-008 --- blockerWhileEnemyUnitCountAtLeast: 3 (data, checked directly
// in heuristic.js's chooseBlocker against the new attackingPlayer param -- no function needed.)

// --- Jegan Ground Type-A (Man Hunter) ST08-009 --- [Deploy] Choose 1 rested enemy Unit that is
// Lv.2 or lower. It won't be set as active during the start phase of your opponent's next turn.
// (skipNextUntap, Byarlant GD02-004 precedent.)
function jeganGroundTypeAManHunterDeploy(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => u.rested && (u.def.level || 0) <= 2);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.skipNextUntap = true;
}

// --- Hathaway Noa ST08-010 (Pilot) --- [Burst] Add this card to your hand. [When Paired] If this
// is a (Mafty) Unit, choose 1 of your (Mafty) Units. During this turn, it may choose a damaged
// active enemy Unit as its attack target. (activeTargetIfDamaged, Gundam Throne Zwei GD04-045
// precedent.)
function hathawayNoaWhenPaired(state, player, unit, context) {
  if (!(unit.def.traits || []).includes('Mafty')) return;
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('Mafty'));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ activeTargetIfDamaged: true, scope: 'turn' });
}

// --- Lane Aim ST08-011 (Pilot) --- [Burst] Add this card to your hand. When you draw with an
// effect, if this is a blue Unit, it gains [High Maneuver] during this turn. (New drawnByEffect
// broadcast, phases.js's drawCard -- see there for the isPhaseDraw gate.)
function laneAimDrawnByEffect(state, player, unit) {
  if (unit.def.color === 'blue') unit.buffs.push({ keyword: 'highManeuver', scope: 'turn' });
}

// --- Words for Hathaway ST08-012 (Command, pilotMode: Gawman Nobile) ---
// [Main] Choose 1 friendly Link Unit. It gains [Breach 1] during this turn.
function wordsForHathawayCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => u.isLinkUnit);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ breach: 1, scope: 'turn' });
}

// --- Lady Luck ST08-013 --- [Main]/[Action] Choose 1 enemy Unit. Deal 1 damage to it. If a
// friendly (Mafty) Link Unit is in play, deal 2 damage instead.
function ladyLuckCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(opponent.battleArea)
    : opponent.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  const hasMaftyLink = player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('Mafty'));
  dealDamage(target, hasMaftyLink ? 2 : 1);
}

// --- Valiant ST08-014 (Base) --- [Burst] Deploy this card. [Deploy] Add 1 of your Shields to your
// hand. Then, choose 1 of your Units. It gets AP+2 during this turn.
function valiantDeploy(state, player, instance, context) {
  simpleBaseDeployAddShield(state, player);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Davao ST08-015 (Base) --- [Activate Main][Once per Turn](2) Choose 1 of your Units. It
// recovers 2 HP.
function davaoActivateMain(state, player, instance, context) {
  if (instance.activationsUsed.recoverUnit) return false;
  const activeResources = player.resourceArea.filter((r) => !r.rested);
  if (activeResources.length < 2) return false;
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(player.battleArea)
    : player.battleArea.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return false;
  activeResources[0].rested = true;
  activeResources[1].rested = true;
  instance.activationsUsed.recoverUnit = true;
  recoverHP(target, 2);
  return true;
}

// === ST09 batch ===

// --- Saviour Gundam ST09-003 --- <Breach 3> (data). Link Condition [Athrun Zala]. [When Linked]
// If there are 5 or more purple cards in your trash, deal 2 damage to all Units with 5 or less AP.
// ("all Units" unqualified reads as both players' fields, Kikeroga precedent.)
function saviourGundamWhenLinked(state, player) {
  const purpleInTrash = player.trash.filter((c) => c.def.color === 'purple').length;
  if (purpleInTrash < 5) return;
  const opponent = opponentOf(state, player);
  for (const u of [...player.battleArea, ...opponent.battleArea]) {
    if (getAP(u) <= 5) dealDamage(u, 2);
  }
}

// --- Giant Killing ST09-009 --- [Main]/[Action] Choose 1 active enemy Unit with 4 or less AP.
// Destroy it. (gundamFlaurosRyuseiGoDestroy GD05-060 precedent for the outright-destroy shape.)
function giantKillingCommand(state, player, instance, context) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => !u.rested && getAP(u) <= 4 && !isImmuneToEffectDestroy(u));
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  destroyOutrightAndFireEffect(state, opponent, target);
}

// === ST10 batch ===

// --- Zeta Gundam (EX) ST10-001 --- Link Condition [Kamille Bidan]. When this Unit destroys an
// enemy shield area card with battle damage, set it as active. It can't choose the same enemy
// player or enemy team as its attack target during this turn. (Strictly a 2-player engine, so "the
// same enemy player or enemy team" is just the one opponent -- reuses the existing cannotAttackPlayer
// turn-buff field.)
function zetaGundamEXST10001DestroysShield(state, player, instance) {
  setActiveByEffect(state, player, instance);
  instance.buffs.push({ cannotAttackPlayer: true, scope: 'turn' });
}

// --- Zeta Gundam ST10-002 --- Link Condition (Support)/[Kamille Bidan]. [Deploy • Development 2]
// You may exile 2 (G Generation) cards from your trash. If you do, choose 1 enemy Unit with 4 or
// less HP. Rest it. (Gundam Barbatos 6th Form EB01-010 precedent for the exile-count shape.)
function zetaGundamST10002Deploy(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4);
  if (candidates.length === 0) return;
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length < 2) return;
  for (const c of ggenCards.slice(0, 2)) player.trash.splice(player.trash.indexOf(c), 1);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  restEnemyByEffect(state, player, opponent, target);
}

// --- Phoenix Gundam (Power Unleashed) (EX) ST10-006 --- Link Condition [Mark Guilder]. [During
// Pair] During your turn, when this Unit destroys an enemy Unit with battle damage, choose 1 enemy
// Unit with 3 or less HP. Return it to its owner's hand. (destroysEnemy only ever fires on the
// attacker's own battle-damage kill, so "During Pair" here just needs instance.pilot.)
function phoenixGundamPowerUnleashedEXDestroysEnemy(state, player, instance) {
  if (!instance.pilot) return;
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => getRemainingHP(u) <= 3);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return;
  removeFromField(opponent, target, opponent.hand);
  sendToZone(opponent.hand, target);
}

// --- Gundam Barbatos 4th Form ST10-007 --- Link Condition (G Generation) Trait. [When Linked •
// Development 2] You may exile 2 (G Generation) cards from your trash. If you do, choose 1
// Command card that is Lv.4 or lower from your trash. Add it to your hand.
function gundamBarbatos4thFormST10007WhenLinked(state, player) {
  const commandCandidates = player.trash.filter((c) => c.def.type === 'command' && (c.def.level || 0) <= 4);
  if (commandCandidates.length === 0) return;
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length < 2) return;
  for (const c of ggenCards.slice(0, 2)) {
    const idx = player.trash.indexOf(c);
    if (idx !== -1) player.trash.splice(idx, 1);
  }
  const chosen = [...commandCandidates].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  player.trash.splice(player.trash.indexOf(chosen), 1);
  player.hand.push(chosen);
}

// --- Gundam Barbatos 1st Form ST10-008 --- Link Condition (G Generation) Trait. [Deploy •
// Development 2] You may exile 2 (G Generation) cards from your trash. If you do, draw a number of
// cards equal to the number of enemy players. Then, discard the same number of cards you drew.
// (Strictly a 2-player engine, so "the number of enemy players" is always 1 -- draw 1, discard 1,
// noinsTaurusDestroyed's highest-cost-in-hand default discard.)
function gundamBarbatos1stFormST10008Deploy(state, player) {
  const ggenCards = player.trash.filter((c) => (c.def.traits || []).includes('G Generation'));
  if (ggenCards.length < 2) return;
  for (const c of ggenCards.slice(0, 2)) player.trash.splice(player.trash.indexOf(c), 1);
  drawCard(state, player);
  const toDiscard = [...player.hand].sort((a, b) => (b.def.cost || 0) - (a.def.cost || 0))[0];
  if (toDiscard) {
    discardFromHand(player, toDiscard);
  }
}

// --- Kamille Bidan ST10-011 (Pilot) --- [Burst] Add this card to your hand. [When Linked] If 2 or
// more rested Units are in play, choose 1 enemy Unit whose Lv. is equal to or lower than this
// Unit. Rest it. ("in play" reads as both players' fields, Kikeroga precedent.)
function kamilleBidanWhenLinked(state, player, unit) {
  const opponent = opponentOf(state, player);
  const restedCount = [...player.battleArea, ...opponent.battleArea].filter((u) => u.rested).length;
  if (restedCount < 2) return;
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= (unit.def.level || 0));
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) restEnemyByEffect(state, player, opponent, target);
}

// --- Mark Guilder ST10-012 (Pilot) --- [Burst] Add this card to your hand. [When Paired] Choose 1
// enemy Unit that is Lv.5 or lower. It gets AP-2 during this turn.
function markGuilderWhenPaired(state, player) {
  const opponent = opponentOf(state, player);
  const candidates = opponent.battleArea.filter((u) => (u.def.level || 0) <= 5);
  const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) reduceEnemyAP(state, player, opponent, target, 2);
}

// --- Tactical Training ST10-013 --- [Burst] Add this card to your hand. [Main]/[Action] Choose 1
// (G Generation) Unit that is Lv.5 or higher. It recovers 2 HP and gets AP+2 during this turn.
function tacticalTrainingBurst(state, player, instance) {
  player.hand.push(instance);
}
function tacticalTrainingCommand(state, player, instance, context) {
  const candidates = player.battleArea.filter((u) => (u.def.traits || []).includes('G Generation') && (u.def.level || 0) >= 5);
  const target = context.hooks && context.hooks.chooseUnit
    ? context.hooks.chooseUnit(candidates)
    : candidates.sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
  if (!target) return;
  recoverHP(target, 2);
  target.buffs.push({ ap: 2, scope: 'turn' });
}

// --- Unlocking the Development Diagram ST10-014 --- [Main] Draw 2.
// "When playing this card from your hand, you may discard 1 (G Generation) Unit card. If you do,
// play this card as if it has 2 Lv. and cost." Not implemented: an alternate-cost-on-discard
// mechanic with no existing plumbing into the deploy-from-hand cost/level resolution
// (src/rules/cost.js, actions.js) -- left as a documented simplification, same shape as Rising
// Freedom Gundam EB01-039's un-plumbed alternative cost.
function unlockingTheDevelopmentDiagramCommand(state, player) {
  drawCard(state, player);
  drawCard(state, player);
}

// --- Diffuse Beam Cannon ST10-015 (Command, pilotMode: Claire Heathrow) --- [Action] If a
// friendly (G Generation) Unit is in play, choose 1 enemy Unit. It gets AP-3 during this battle.
function diffuseBeamCannonCommand(state, player) {
  if (!player.battleArea.some((u) => (u.def.traits || []).includes('G Generation'))) return;
  const opponent = opponentOf(state, player);
  const target = [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
  if (target) reduceEnemyAP(state, player, opponent, target, 3, 'battle');
}

// --- Luna Mana & Carry Base ST10-016 (Base) --- [Burst] Deploy this card. [Deploy] Add 1 of your
// Shields to your hand. Then, all friendly (G Generation) Units recover 1 HP.
function lunaManaCarryBaseDeploy(state, player) {
  simpleBaseDeployAddShield(state, player);
  for (const u of player.battleArea.filter((u) => (u.def.traits || []).includes('G Generation'))) recoverHP(u, 1);
}

module.exports = {
  addSelfToHandBurst,
  noinsTaurusDestroyed,
  gundamHeavyarmsCustomEWActivateMain,
  cagalliYulaAthhaGD05WhenPaired,
  prosperaMercuryStartOfTurn,
  stellarLoussierRPlusDestroyed,
  stingOakleyStartOfTurn,
  auelNeiderAttack,
  quessParayaDestroyed,
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
  zeongDestroyed,
  kayrasRegzDeploy,
  regzDestroyed,
  gundamAge2Destroyed,
  nuGundam020Deploy,
  nuGundam017WhenPaired,
  amuroRay085Burst,
  amuroRay085DestroysEnemy,
  raCailumBurst,
  raCailumDeploy,
  raCailumActivateMain,
  corsicaBaseBurst,
  corsicaBaseDeploy,
  overflowingAffectionCommand,
  aileStrikeGundamWhenPaired,
  strikeFreedomDeploy,
  strikeFreedomAttack,
  kiraYamatoST04010Burst,
  kiraYamatoST04010Attack,
  kiraYamatoGD05081Burst,
  kiraYamatoGD05081WhenLinked,
  victoryGundamGD04003Attack,
  vDashGundamActivateMain,
  usoEwinBurst,
  usoEwinWhenPaired,
  reineforceJrBurst,
  reineforceJrDeploy,
  airframeSeizureCommand,
  darknessFingerCommand,
  darknessFingerBurst,
  gundamMaxterDestroysEnemy,
  gundamMaxterAttack,
  risingGundamWhenLinked,
  shiningGundam066Deploy,
  shiningGundam066Attack,
  masterGundamAttack,
  domonKasshuBurst,
  domonKasshuWhenPaired,
  victoryGundamGD04011Destroyed,
  unforeseenIncidentCommand,
  unforeseenIncidentBurst,
  masterAsiaBurst,
  masterAsiaAttack,
  cyclonePunchCommand,
  shiningFingerBurst,
  shiningFingerCommand,
  gundamFightBurst,
  gundamFightDeploy,
  gundamFightActivateMain,
  gundamExiaRepairDealsBattleDamage,
  gundamExiaRepairDestroyed,
  gundamBarbatos1stFormAttack,
  gundamBarbatosAdaptDeploy,
  mikazukiAugusBurst,
  mikazukiAugusWhenPaired,
  widespreadAnnihilationCommand,
  swordStrikeGundamAttack,
  simpleBurstBase,
  simpleBaseDeployAddShield,
  gunEZDeploy,
  v2GundamActivateMain,
  gracefulDemeanorCommand,
  gracefulDemeanorBurst,
  silverBulletDeploy,
  freedomGundamStartOfTurn,
  strikerPackBurst,
  strikerPackCommand,
  archangelActivateMain,
  gundamNT1WhenPaired,
  penelopeFlightFormStartOfTurn,
  penelopeFlightFormDeploy,
  shiningGundamSuperModeAttack,
  sazabiAttack,
  charAznableGD05093Burst,
  charAznableGD05093WhenLinked,
  ryuseiGoDeploy,
  gundamBarbatosLupusActivateMain,
  kshatriyaWhenPaired,
  unicornBansheeDestroyModeAttack,
  maridaCruzBurst,
  maridaCruzAttack,
  closeCombatCommand,
  closeCombatBurst,
  wingGundamBirdModeDeploy,
  wingGundamZeroGD01024Deploy,
  wingGundamZeroEWStartOfTurn,
  wingGundamZeroEWAttack,
  heeroYuy098Burst,
  heeroYuy098DestroysShield,
  heeroYuy010Burst,
  navalBombardmentBurst,
  navalBombardmentCommand,
  peacemillionBurst,
  peacemillionDeploy,
  peacemillionFriendlyUnitDestroysEnemy,
  kindheartedCommand,
  kindheartedBurst,
  m1AstrayShrikeDeploy,
  isaribiBurst,
  isaribiDeploy,
  isaribiActivateMain,
  haowGundamWhenPaired,
  whiteBaseActivateMain,
  battleOfAcesBurst,
  battleOfAcesCommand,
  improvedTechniqueCommand,
  improvedTechniqueBurst,
  rewloolaDeploy,
  axisActivateMain,
  waldfeldsMurasameDestroyed,
  hashmalDestroysEnemy,
  andrewWaldfeldBurst,
  roueiDeploy,
  gundamFlaurosRyuseiGoDestroy,
  akihiroAltlandDestroysEnemy,
  shenlongGundamAttack,
  altronGundamAttack,
  riddheMarcenasBurst,
  unicornBansheeNormActivateMain,
  unicornBansheeNormAttack,
  presidentialOfficeDestroyed,
  argamaDeploy,
  hokaKyotenJuzetsujinCommand,
  gravitonHammerCommand,
  dragonGundamDestroysShield,
  aegisGundamAttack,
  gfredActivateMain,
  gfredWhenLinked,
  justiceGundamDeploy,
  justiceGundamAttack,
  gquuuuuuxOmegaPsycommuDeploy,
  athrunZalaST04011Burst,
  athrunZalaST04011WhenLinked,
  nyaanBurst,
  nyaanWhenLinked,
  changWufeiBurst,
  hyGoggWhenLinked,
  kampferBurst,
  kampferWhenPaired,
  mikhailKaminskyBurst,
  mikhailKaminskyAttack,
  tokwanBurst,
  impulseGundamActivateMain,
  swordImpulseGundamDeploy,
  forceImpulseGundamDestroyed,
  destinyGundamGD04050Attack,
  shinnAsukaST09008Burst,
  shinnAsukaST09008Attack,
  zeheartGaletteBurst,
  zeheartGaletteWhenPaired,
  awakenedPowerCommand,
  minervaBurst,
  minervaDeploy,
  gundamExiaST07001WhenPaired,
  gundamExiaST07001EndOfTurn,
  gundamVirtueStartOfTurn,
  setsunaFSeieiST07009Burst,
  setsunaFSeieiST07009Attack,
  gundamExiaTransAmDestroysShield,
  gundamKyriosAttack,
  nenaTrinityBurst,
  nenaTrinityActivateMain,
  hallelujahHaptismBurst,
  hallelujahHaptismDestroysEnemy,
  overwhelmingPressureCommand,
  gundamThroneEinsWhenLinked,
  gundamThroneEinsActivateMain,
  gquuuuuuxST06001WhenLinked,
  gquuuuuuxST06002Deploy,
  redGundamST06005Attack,
  ortegasRickDomDeploy,
  amateYuzurihaMachuBurst,
  amateYuzurihaMachuWhenLinked,
  shujiItoBurst,
  shujiItoAttack,
  schoolgirlAndSmugglerCommand,
  gquuuuuuxGD02038Deploy,
  shujisHideoutDestroyed,
  redGundamGD03039Deploy,
  gundamGD01001WhenPaired,
  unicornGundamDestroyModeAttack,
  guncannonGD01004WhenPaired,
  unicornGundamUnicornModeDestroyed,
  noinsAriesDestroyed,
  gFighterDeploy,
  unicornBansheeGD01010WhenPaired,
  zechsLeoWhenPaired,
  gSkyEasyActivateAction,
  ballGD01015Attack,
  byarlantCustomStartOfTurn,
  charsGelgoogActivateMain,
  gundamDeathscytheGD01025WhenPaired,
  bigZamGD01027Deploy,
  gundamSandrockDeploy,
  gyanGD01032WhenPaired,
  adzamGD01038Deploy,
  rasidsManagacGD01043Deploy,
  duelGundamGD01045WhenPaired,
  shambloGD01047Attack,
  zakuISniperGD01048Deploy,
  blitzGundamGD01049Deploy,
  lagoweGD01050Attack,
  gearaZuluGD01052Deploy,
  gearaDogaGD01053ActivateMain,
  gearaDogaGD01056Destroyed,
  gallussKGD01058ActivateAction,
  zeeZuluGD01059Attack,
  znoGD01063Attack,
  freedomGundamGD01065AllyPaired,
  gundamAerialRebuildWhenPaired,
  perfectStrikeGundamDeploy,
  strikeRougeActivateMain,
  gundamPharactAttack,
  chuchusDemiTrainerAttack,
  michaelisStartOfTurn,
  mistralDeploy,
  cagallisSkygrasperDestroyed,
  m1AstrayStartOfTurn,
  gundamAerialGD01082ActivateAction,
  saylaMassBurst,
  banagherLinksGD01088Burst,
  banagherLinksGD01088WhenLinked,
  riddheMarcenasBurst,
  duoMaxwellGD01090Burst,
  mQuveBurst,
  yzakJuleBurst,
  yzakJuleDestroysEnemy,
  dearkaElthmanBurst,
  dearkaElthmanWhenLinked,
  cagalliYulaAthhaBurst,
  guelJeturkBurst,
  guelJeturkActivateMain,
  elanCeresBurst,
  elanCeresActivateAction,
  interceptOrdersBurst,
  interceptOrdersCommand,
  deepDevotionCommand,
  securingTheSupplyLineCommand,
  theStubbornCogCommand,
  signsOfARevolutionBurst,
  signsOfARevolutionCommand,
  citizensTakeAStandBurst,
  citizensTakeAStandCommand,
  fortressDefenseCommand,
  firstContactBurst,
  firstContactCommand,
  strategicArmsCommand,
  thePathToVictoryOrDefeatCommand,
  rasidsOrdersCommand,
  extremeHatredCommand,
  theDesertTigerCommand,
  assaultOnTorringtonBaseCommand,
  zeonRemnantForcesCommand,
  stealthStratagemCommand,
  theWitchAndTheBrideBurst,
  theWitchAndTheBrideCommand,
  ironFistedDisciplineCommand,
  midairModificationsBurst,
  midairModificationsCommand,
  covertOperativeCommand,
  nahelArgamaDeploy,
  side7ActivateMain,
  zanzibarDeploy,
  gamowActivateAction,
  kusanagiDeploy,
  thirteenthTacticalTestingSectorActivateMain,
  psychoGundamLRFriendlyUnitDestroysShield,
  gundamEpyonLRFriendlyUnitDestroysEnemy,
  gundamMk2TitansGD02003Destroyed,
  byarlantGD02004WhenPaired,
  tallgeeseGD02005Attack,
  gabthleyGD02008WhenLinked,
  calamityGundamApReducedByEnemy,
  raiderGundamReceivesEnemyEffectDamage,
  moebiusPeacemakerActivateAction,
  galbaldyBetaDeploy,
  elmethGD02020Deploy,
  gundamAge1NormalLRDeploy,
  gExesPlacesExResource,
  gundamAge1SpallowAttack,
  genoaceCustomDeploy,
  gundamAge1TitusGD02031ResourcePhase,
  kikerogaGD02033StartOfTurn,
  qubeleyGD02036WhenLinked,
  qubeleyGD02036Attack,
  virsagoGD02037Deploy,
  hamanKarnsGazaCWhenPaired,
  ashtaronRPlusGD02040Deploy,
  sugaisGelgoogGQRPlusDeploy,
  ashtaronMAModeGD02042Deploy,
  daughtressWeaponDeploy,
  daughtressCommandDestroyed,
  ginnLongRangeReconAttack,
  saylasLightTypeGuncannonDeploy,
  gazaCGD02047ActivateMain,
  gundamXLRPlusGD02053StartOfTurn,
  gundamXGD02056Destroyed,
  zedasGD02057Attack,
  gundamLeopardUPlusDeploy,
  hyakuriGD02061WhenPaired,
  gundamBarbatos3rdFormDeploy,
  zetaGundamLRPlusActivateMain,
  gundamKimarisLRPlusDeploy,
  gundamMkIIAEUGDeploy,
  gundamAerialRebuildStartOfTurn,
  rickDiasRedAttack,
  methussDeploy,
  gaeliosSchwalbeGrazeStartOfTurn,
  grazeRitterGroundTypeGD02083Destroyed,
  fourMurasameBurst,
  fourMurasameRecoversHP,
  jeridMessaBurst,
  jeridMessaStartOfTurn,
  orgaCrotShaniBurst,
  orgaCrotShaniWhenLinked,
  flitAsunoBurst,
  flitAsunoWhenLinked,
  lalahSuneBurst,
  lalahSuneWhenPaired,
  challiaBullGQBurst,
  challiaBullGQStartOfTurn,
  hamanKarnRPlusBurst,
  hamanKarnRPlusWhenPaired,
  shagiaFrostBurst,
  shagiaFrostAttack,
  olbaFrostBurst,
  olbaFrostDestroysEnemy,
  garrodTiffaBurst,
  garrodTiffaWhenPaired,
  lafterFranklandBurst,
  lafterFranklandAttack,
  desilGaletteBurst,
  desilGaletteWhenLinked,
  kamilleBidanRPlusBurst,
  kamilleBidanRPlusStartOfTurn,
  quattroBajeenaBurst,
  quattroBajeenaWhenLinked,
  gaelioBauduinBurst,
  gaelioBauduinWhenPaired,
  dramaticTurnaboutBurst,
  dramaticTurnaboutCommand,
  beneathTheMaskCommand,
  mouarsDeterminationCommand,
  ageDeviceRPlusBurst,
  ageDeviceRPlusCommand,
  turningPointOfHistoryCommand,
  valedictorianCommand,
  whiteWolfCommand,
  allRangeAttackRPlusBurst,
  allRangeAttackRPlusCommand,
  thatOneLooksALotStrongerCommand,
  undyingPersistenceCommand,
  decisiveLastResortBurst,
  decisiveLastResortCommand,
  momentaryRespiteBurst,
  momentaryRespiteCommand,
  sisterlyCareCommand,
  itsNameIsRyuseiGoCommand,
  familialDevotionCommand,
  comradesComeFirstCommand,
  aNewSignBurst,
  aNewSignCommand,
  heartSetOnRevengeCommand,
  persistentAndFortitudinousCommand,
  aspiringPilotCommand,
  dominionDeploy,
  alexandriaDeploy,
  sodonDeploy,
  divaStartOfTurn,
  gwadanDeploy,
  freedenDestroyed,
  hammerheadDeploy,
  sleipnirDeploy,
  theOAllyAttack,
  hambrabiAttack,
  kshatriyaBesserungDeploy,
  penelopeMiddleFormDeploy,
  gundamNT1FullArmorDestroyed,
  palaceAtheneDeploy,
  hizackStartOfTurn,
  baundDocActivateMain,
  gundamAge2NormalLRWhenLinked,
  zakuIIFZWhenPaired,
  gundamDeathscytheHellGD03021Deploy,
  gundamKyriosRPlusDestroysEnemy,
  gBouncerPlacesExResource,
  audasManganacAttack,
  gundamHeavyarmsCustomDestroysEnemy,
  providenceGundamLRStartOfTurn,
  providenceGundamLRAttack,
  xiGundamFlightFormWhenLinked,
  bertigoAttack,
  guaizCommanderActivateMain,
  patuliaDeploy,
  messerTypeF02WhenPaired,
  daughtressFlyerDeploy,
  balientStartOfTurn,
  gfreDBurst,
  gundamXDividerWhenLinked,
  gundamVirtueRPlusDealsBattleDamage,
  gundamGusionRebakeFriendlyUnitReceivesEffectDamage,
  zeydraWhenPaired,
  gundamHajiroboshi2ndFormWhenPaired,
  zedasRAttack,
  cgsMobileWorkerReceivesEffectDamage,
  gxBitDeploy,
  defurseDeploy,
  gundamHajiroboshiStartOfTurn,
  grahamsUnionFlagCustomWhenLinked,
  grahamsUnionFlagCustomEndOfTurn,
  zGundamBiosensorDeploy,
  aileStrikeGundamGD03072Deploy,
  grazeEinActivateAction,
  superGundamAttack,
  freedomGundamMeteorFriendlyUnitDealsBattleDamage,
  justiceGundamMeteorWhenLinked,
  tierenHighMobilityDestroyed,
  gundamKimarisTrooperWhenLinked,
  paptimusSciroccoRPlusBurst,
  paptimusSciroccoRPlusWhenLinked,
  christinaMackenzieBurst,
  yazanGableBurst,
  yazanGableAttack,
  sarahZabiarovBurst,
  sarahZabiarovWhenLinked,
  asemuAsunoRPlusBurst,
  bernardWisemanBurst,
  bernardWisemanStartOfTurn,
  rauLeCreusetRPlusBurst,
  rauLeCreusetRPlusWhenLinked,
  carrisNautilusBurst,
  carrisNautilusStartOfTurn,
  azeeGuruminBurst,
  azeeGuruminReceivesEffectDamage,
  jamilNeateBurst,
  jamilNeateAttack,
  wistarioAfamBurst,
  wistarioAfamDestroysEnemy,
  grahamAkerRPlusBurst,
  grahamAkerRPlusSetActiveByEffect,
  emmaSheenBurst,
  emmaSheenDestroyed,
  somaPeriesBurst,
  somaPeriesDestroyed,
  aHealthyCuriosityRPlusCommand,
  privilegedPositionBurst,
  privilegedPositionCommand,
  fieldDirectiveBurst,
  fieldDirectiveCommand,
  reccoasShadowCommand,
  bridgeCrewRPlusBurst,
  bridgeCrewRPlusCommand,
  mavTacticsCommand,
  overTheRiverAndThroughTheWoodsCommand,
  howManyMilesToTheBattlefieldCommand,
  eliminateTargetCommand,
  infiltratorPresentCommand,
  warpedIntentBurst,
  warpedIntentCommand,
  humanKarmaCommand,
  lookOfDeterminationCommand,
  distantReunionCommand,
  towardsDestinyCommand,
  orgasOrderCommand,
  awakenedPotentialRPlusBurst,
  awakenedPotentialRPlusCommand,
  awkwardApproachCommand,
  immortalColasourCommand,
  unheraldedAttackCommand,
  veteranTacticsCommand,
  jupitrisBurst,
  jupitrisDeploy,
  riboColonyBurst,
  riboColonyDeploy,
  riboColonyAllyPaired,
  cyclopsTeamBurst,
  cyclopsTeamDeploy,
  cyclopsTeamStartOfTurn,
  jachinDueBurst,
  jachinDueDeploy,
  doriteaBurst,
  doriteaDeploy,
  doriteaFriendlyUnitRestedByEnemyEffect,
  hotarubiBurst,
  hotarubiDeploy,
  hotarubiFriendlyUnitReceivesEffectDamage,
  downesBurst,
  downesDeploy,
  eternalBurst,
  eternalDeploy,
  radishBurst,
  radishDeploy,
  radishDestroyed,
  psychoGundamMk2AllyPaired,
  victoryGundamHexaAttack,
  guncannon108109WhenLinked,
  coreFighterStartOfTurn,
  gundamPharactFriendlyUnitReceivesEnemyDamage,
  gnArmorTypeDTransAmDestroyed,
  gundamLfrithUrFriendlyPlaysCommand,
  gundamLfrithThornFriendlyPlaysCommand,
  kikerogaMsModeStartOfTurn,
  gundamKyriosTailBoosterDeploy,
  gundamAerialRebuildDeploy,
  gundvolvaDestroyed,
  garmasDoppDeploy,
  zakrelloAttack,
  chuchusDemiTrainerGD04030Attack,
  neoZeongLRPlusFriendlyUnitDeployed,
  xiGundamDeploy,
  gundamThroneEinsDeploy,
  gundamKyriosTransAmStartOfTurn,
  gundamExia038Deploy,
  rozenZuluDeploy,
  gundamThroneDreiRestedByEnemyEffect,
  psychoGundamGQUPlusFriendlyUnitDestroysShield,
  zssaSleevesDeploy,
  gadeelAttack,
  gundamThroneZweiWhenLinked,
  gundamDynamesDeploy,
  gundamDXLRPlusAttack,
  gundamLeopardDestroyAttack,
  gundamVirtueTransAmDealsBattleDamage,
  swordImpulseGundamGD04Deploy,
  gundamNadleehDeploy,
  jamilsGundamXDestroyed,
  esperansaDeploy,
  gnArmorTypeEDeploy,
  unicornGundamAwakenedLRPlusFriendlyPlaysCommand,
  turnAGundamLRPlusActivateMain,
  turnAGundamGD04069EndOfTurn,
  alSaachezAEUEnactMoraliaDeploy,
  grahamsUnionFlagGNFlagRPlusBurst,
  grahamsUnionFlagGNFlagRPlusActivateMain,
  unicornGundam02BansheeNornWhenLinked,
  turnAGundamGD04073ActivateMain,
  kapoolAttack,
  alvatoreDestroyed,
  rosamiaBadamBurst,
  rosamiaBadamWhenLinked,
  marbetFingerhatBurst,
  marbetFingerhatStartOfTurn,
  sleggarLawBurst,
  sleggarLawAttack,
  sulettaMercuryRPlusBurst,
  sulettaMercuryRPlusFriendlyPlaysCommand,
  garmaZabiBurst,
  garmaZabiDestroyed,
  elanCeresEnhancedPersonBurst,
  elanCeresEnhancedPersonAttack,
  deuxMurasameBurst,
  deuxMurasameDestroyed,
  michaelTrinityBurst,
  michaelTrinityWhenLinked,
  reyZaBurrelRPlusBurst,
  reyZaBurrelRPlusWhenLinked,
  palaSysBurst,
  palaSysWhenLinked,
  lunamariaHawkeUPlusBurst,
  lunamariaHawkeUPlusWhenLinked,
  ennilElBurst,
  ennilElDealsBattleDamage,
  loranCehackRPlusBurst,
  loranCehackRPlusWhenLinked,
  aliAlSaachezBurst,
  aliAlSaachezAttack,
  sochieHeimBurst,
  sochieHeimFriendlyPaysAbilityCost,
  momentOfRestUPlusBurst,
  momentOfRestUPlusCommand,
  spiritualSupportCommand,
  shrikeTeamsBulwarkCommand,
  encounterRPlusCommand,
  indiscriminateViolenceCommand,
  destinedBattleBurst,
  destinedBattleCommand,
  witchesFromEarthCommand,
  financierUPlusCommand,
  trinityCommand,
  inspectorCommand,
  damageControlBurst,
  damageControlCommand,
  reformationistUPlusBurst,
  reformationistUPlusCommand,
  backupBurst,
  backupCommand,
  reliableBigBrotherCommand,
  worldDistortionCommand,
  fightingAloneCommand,
  machineDollSquadCommand,
  ninthTacticalTestingSectorPlacesExResource,
  trinityWarshipActivateMain,
  izumaColonyReceivesBattleDamageFromEnemy,
  freedenIIDeploy,
  armoryOneDestroyed,
  willgemDeploy,
  willgemFriendlyPaysAbilityCost,
  industrial7ActivateMain,
  akatsukiOowashiWhenLinked,
  calamityRaiderGundamDeploy,
  forbiddenGundamWhenLinked,
  murasameFriendlyUnitDeployed,
  gundamCalibarnDeploy,
  gundamCalibarnFriendlyExResourceExiled,
  gundamAge2DoubleBulletActivateAction,
  gundamSchwarzetteActivateAction,
  reGZBWSDeploy,
  demiBardingDeploy,
  kayrasJeganDeploy,
  gaiaGundamLRPlusDestroysShield,
  chaosGundamAttack,
  gundamRoseAttack,
  abyssGundamMAModeWhenPaired,
  gundamBarbatosLupusRexEndOfTurn,
  sazabiRPlusDeploy,
  quessJagdDogaRPlusDestroyed,
  alphaAzieruFriendlyUnitDestroyedByEffect,
  gyuneisJagdDogaGD05057ActivateMain,
  gundamBarbatosLupusUPlusAttack,
  gearaDogaGD05061StartOfTurn,
  forceImpulseGundamGD05064Deploy,
  landmanRodiStartOfTurn,
  tallgeeseIIIDestroysEnemy,
  gundamSandrockCustomEWAttack,
  altronGundamEWDeploy,
  chadChadanAttack,
  trowaBartonGD05DestroysEnemy,
  quatreRaberbaWinnerGD05WhenPaired,
  gavaneGoonnyGD05FriendlyPaysAbilityCost,
  wingsOfLightRPlusCommand,
  notWithScattershotCommand,
  atTheRiskOfOnesLifeCommand,
  exclusivelyDefenseOrientedPolicyCommand,
  exclusivelyDefenseOrientedPolicyBurst,
  mutualAttractionRPlusCommand,
  interwovenBlessingsBurst,
  interwovenBlessingsCommand,
  overcomingHardshipsCommand,
  felsisPleaCommand,
  roseScreamerCommand,
  newtypeLabsDirectorBurst,
  newtypeLabsDirectorCommand,
  veteransPrideCommand,
  incendiarySparkCommand,
  aWindAgainstFiresRPlusCommand,
  quietZeroActivateMain,
  girtyLueAllyPaired,
  gundamAstrayRedFrameCustomEXActivateMain,
  hiNuGundamEXDeploy,
  hiNuGundamEXAttack,
  narrativeGundamAPacksEXEndOfTurn,
  gundamBarbatosLupusRexEXRecoversHP,
  zetaGundamIIIP2TypeDeploy,
  gundamAstrayGoldFrameAmatsuDeploy,
  gundamDeltaKaiDeploy,
  gundamFullArmorThunderboltEXDeploy,
  gundamBarbatos6thFormDeploy,
  redGundam0085Attack,
  prototypeAsshimarTR3Destroyed,
  haroDestroyed,
  gundamAstrayBlueFrameSecondLAttack,
  gundamPixyAttack,
  buildStrikeGundamFullPackageEXWhenPaired,
  gundamExiaEXEndOfTurn,
  leCygneEXAttack,
  gQuuuuuuXOmegaPsycommuAttack,
  tallgeeseIIDeploy,
  tallgeeseDeploy,
  gundamPlutoneAllyAttack,
  gundamAstarothRinascimentoEXDeploy,
  bigRangDeploy,
  gundamLfrithUrWhenLinked,
  taurusSancKingdomActivateAction,
  gundamLfrithThornFriendlyUnitDeployed,
  darilbaldeStartOfTurn,
  strikeFreedomGundamEXDeploy,
  psychoHaroEXAttack,
  blueDestinyUnit1EXAttack,
  psychoZakuEXWhenPaired,
  strikerCustomEXAttack,
  casvalsGundamWhenPaired,
  paleRiderGroundHeavyEquipmentTypeStartOfTurn,
  saikoroGundamAttack,
  hildolfrDeploy,
  gundamGeminass02Deploy,
  psychoZakuAttack,
  gundamAquariusWhenPaired,
  ellisClaudeWhenPaired,
  jonaBastaAttack,
  ioFlemingStartOfTurn,
  rondoGinaSahakuStartOfTurn,
  meirSivaWhenLinked,
  reijiWhenPaired,
  asunaElmaritWhenPaired,
  challAcusticaDestroyed,
  besidePainAttack,
  darylLorenzActivateAction,
  yuuKajimaWhenPaired,
  characterRequestsBurst,
  characterRequestsCommand,
  eternalRoadBurst,
  eternalRoadCommand,
  fierceEnemyAssaultCommand,
  gerberaStraightCommand,
  masterLeagueBeginsBurst,
  masterLeagueBeginsCommand,
  premiumUnitAssemblyCommand,
  modificationCommand,
  sturmFaustCommand,
  mapWeaponBurst,
  mapWeaponCommand,
  warshipCruiseCommand,
  warshipCruiseBurst,
  spConversionChipsCommand,
  cm30CannonAPFSDSRoundCommand,
  kudeliaAinaBernsteinIsaribiDeploy,
  kyciliaZabiGwazineAllyPaired,
  marinaIsmailPtolemaios2FriendlyUnitDestroysEnemy,
  miorineRembranAcademyShipStartOfTurn,
  lacusClyneEternalDeploy,
  tiffaAdillFreedenDeploy,
  gundamMAFormWhenPaired,
  guntankST01004Deploy,
  gundamAerialPermetScoreSixWhenPaired,
  sulettaMercuryAttack,
  thoroughlyDamagedCommand,
  kaisResolveCommand,
  asticassiaEarthHouseActivateMain,
  gundamHeavyarmsST02003DestroysEnemy,
  tallgeeseST02006ActivateMain,
  zechsMerquiseDestroysEnemy,
  simultaneousFireCommand,
  peacefulTimbreCommand,
  siegePloyCommand,
  siegePloyBurst,
  saintGabrielInstituteDeploy,
  sinanjuST03001DestroysShield,
  goufST03009Deploy,
  fullFrontalWhenPaired,
  indignationCommand,
  theBlueGiantST03014Command,
  falmelDeploy,
  strikeGundamST04002Deploy,
  miguelsGinnST04009Destroyed,
  hawkOfEndymionCommand,
  theMagicBulletOfDuskCommand,
  vesaliusActivateMain,
  gundamBarbatos4thFormDeploy,
  cgsMobileWorkerActivateMain,
  gundamGusionRebakeST05005Destroyed,
  mcgillisSchwalbeGrazeWhenPaired,
  mcgillisFareedWhenPaired,
  withIronAndBloodCommand,
  fatalStrikeCommand,
  fatalStrikeBurst,
  ruthlessTacticsCommand,
  fierceUnityCommand,
  clanBattleActivateMain,
  kanebanCoLtdAllyPaired,
  gundamDynamesLRDestroysEnemy,
  gundamKyriosST07007StartOfTurn,
  tieriaErdeST07010Destroyed,
  lockonStratosNeilWhenPaired,
  allelujahHaptismStartOfTurn,
  armedInterventionBurst,
  armedInterventionCommand,
  tacticalVisionaryCommand,
  xiGundamST08001WhenPaired,
  xiGundamST08002Deploy,
  messerTypeF01Attack,
  penelopeLRAttack,
  jeganGroundTypeAManHunterDeploy,
  hathawayNoaWhenPaired,
  laneAimDrawnByEffect,
  wordsForHathawayCommand,
  ladyLuckCommand,
  valiantDeploy,
  davaoActivateMain,
  saviourGundamWhenLinked,
  giantKillingCommand,
  zetaGundamEXST10001DestroysShield,
  zetaGundamST10002Deploy,
  phoenixGundamPowerUnleashedEXDestroysEnemy,
  gundamBarbatos4thFormST10007WhenLinked,
  gundamBarbatos1stFormST10008Deploy,
  kamilleBidanWhenLinked,
  markGuilderWhenPaired,
  tacticalTrainingBurst,
  tacticalTrainingCommand,
  unlockingTheDevelopmentDiagramCommand,
  diffuseBeamCannonCommand,
  lunaManaCarryBaseDeploy
};
