const { getAP, getRemainingHP, getKeywords } = require('../rules/management');

/** Keyword-copy value for Turn A Gundam (LR+) GD04-067: how good a trash Unit card is to copy from. */
function turnAKeywordValue(card) {
  const kw = card.def.keywords || {};
  let score = 0;
  if (kw.blocker) score += 2;
  if (kw.firstStrike) score += 2;
  if (kw.highManeuver) score += 2;
  if (kw.suppression) score += 2;
  if (kw.repair) score += kw.repair;
  if (kw.breach) score += kw.breach;
  if (kw.support) score += kw.support;
  return score;
}

/** Shared shape for "rest a same-trait friendly Unit as cost, rest a qualifying enemy Unit as the effect." */
function restEnemyByTradingArgs(player, opponent, source, usedKey, trait, enemyQualifies) {
  if (source.activationsUsed[usedKey]) return null;
  const restUnit = player.battleArea
    .filter((u) => u !== source && !u.rested && (u.def.traits || []).includes(trait))
    .sort((a, b) => getAP(a) - getAP(b))[0];
  if (!restUnit) return null;
  const target = opponent.battleArea
    .filter((u) => !u.rested && enemyQualifies(u) && getAP(u) > getAP(restUnit))
    .sort((a, b) => getAP(b) - getAP(a))[0];
  if (!target) return null;
  return { restUnit, target };
}

/**
 * cardNumber -> resolveArgs(state, player, opponent, source): returns either null (not currently
 * usable) or an args object ready to pass straight to
 * source.def.effects.activateMain(state, player, source, args). Each resolver mirrors its effect's
 * real preconditions exactly (activationsUsed flag, resource affordability, target existence) rather
 * than relying on the effect's own internal guard to silently no-op -- an action offered as "legal"
 * that actually resolves to a no-op is the same deterministic-fixed-point hazard the attack-target
 * pre-filter in mcts.js's getLegalActions already had to fix (the search is fully deterministic, so a
 * no-op applied for real reproduces the identical tree and picks the identical no-op forever).
 *
 * Both the old lookahead AI (heuristic.js's runActivations) and the MCTS search
 * (mcts.js's collectActivateCandidates) read this same table, so an ability wired here is usable by
 * every AI path, not just one -- see Phase 5 of the plan for why this table exists (previously an
 * if/else chain in heuristic.js covering only 8 of the ~40 cards in the DB with an activateMain effect).
 */
const RESOLVERS = {
  'GD04-122': (state, player, opponent, source) =>
    restEnemyByTradingArgs(player, opponent, source, 'restEnemy', 'Earth Federation', (u) => (u.def.level || 0) <= 3),
  'GD04-006': (state, player, opponent, source) =>
    restEnemyByTradingArgs(player, opponent, source, 'restEnemy', 'League Militaire', (u) => getRemainingHP(u) <= 4),
  // Ra Cailum GD05-125: guards via instance.rested, not activationsUsed -- already covered correctly by
  // collectActivateCandidates' own `!c.rested` activator filter, no extra check needed here.
  'GD05-125': (state, player) => {
    const target = player.battleArea
      .filter((u) => (u.def.traits || []).includes('Londo Bell'))
      .sort((a, b) => getAP(b) - getAP(a))[0];
    return target ? { target } : null;
  },
  // Turn A Gundam (GD04-073): "(1): AP+2 during this turn" -- needs 1 active Resource, once per turn.
  'GD04-073': (state, player, opponent, source) => {
    if (source.activationsUsed.apBoost) return null;
    return player.resourceArea.some((r) => !r.rested) ? {} : null;
  },
  // Gundam Heavyarms Custom (EW) (C+) GD05-079: needs another (G Team)/(Preventer) ally and a Lv.4-or-lower enemy Unit, once per turn.
  'GD05-079': (state, player, opponent, source) => {
    if (source.activationsUsed.debuffEnemy) return null;
    const hasAlly = player.battleArea.some(
      (u) => u !== source && (u.def.traits || []).some((t) => t === 'G Team' || t === 'Preventer')
    );
    if (!hasAlly) return null;
    return opponent.battleArea.some((u) => (u.def.level || 0) <= 4) ? {} : null;
  },
  // Quiet Zero GD05-126: needs 2 active Resources and a Lv.5+ "Gundam Aerial" Unit in play, once per turn.
  'GD05-126': (state, player, opponent, source) => {
    if (source.activationsUsed.deployGundnode) return null;
    if (player.resourceArea.filter((r) => !r.rested).length < 2) return null;
    const hasGundamAerial = player.battleArea.some(
      (u) => (u.def.name || '').includes('Gundam Aerial') && (u.def.level || 0) >= 5
    );
    return hasGundamAerial ? {} : null;
  },
  // Gundam Astray Red Frame Custom (EX) EB01-001: needs 2+ Commands in trash and a damaged Lv.7-or-lower enemy Unit, once per turn.
  'EB01-001': (state, player, opponent, source) => {
    if (source.activationsUsed.exileCommandsRest) return null;
    if (player.trash.filter((c) => c.def.type === 'command').length < 2) return null;
    return opponent.battleArea.some((u) => u.damage > 0 && (u.def.level || 0) <= 7) ? {} : null;
  },
  // Char's Gelgoog GD01-023: needs a discardable Zeon/Neo Zeon Unit in hand -- no once-per-turn guard
  // in the real effect (repeatable as long as hand keeps offering candidates, each firing shrinks the
  // pool for real, so it's self-limiting rather than a no-op hazard).
  'GD01-023': (state, player) =>
    player.hand.some((c) => c.def.type === 'unit' && ((c.def.traits || []).includes('Zeon') || (c.def.traits || []).includes('Neo Zeon')))
      ? {}
      : null,
  // Geara Doga GD01-053: needs 1 active Resource and an enemy Unit with AP<=2, once per turn.
  'GD01-053': (state, player, opponent, source) => {
    if (source.activationsUsed.pingLowAP) return null;
    if (!player.resourceArea.some((r) => !r.rested)) return null;
    return opponent.battleArea.some((u) => getAP(u) <= 2) ? {} : null;
  },
  // Strike Rouge GD01-069: needs 1 active Resource and a rested white Blocker Unit of its own, once per turn.
  'GD01-069': (state, player, opponent, source) => {
    if (source.activationsUsed.unrestBlocker) return null;
    if (!player.resourceArea.some((r) => !r.rested)) return null;
    return player.battleArea.some((u) => u.rested && u.def.color === 'white' && getKeywords(u).blocker) ? {} : null;
  },
  // Guel Jeturk GD01-097: needs the opponent to have 8+ cards in hand, once per turn.
  'GD01-097': (state, player, opponent, source) => (!source.activationsUsed.guelUnrest && opponent.hand.length >= 8 ? {} : null),
  // Side 7 GD01-124: guards via instance.rested (already covered by the activator filter) -- just needs
  // a friendly Unit to target (its own default sort always picks something once battleArea is non-empty).
  'GD01-124': (state, player) => (player.battleArea.length > 0 ? {} : null),
  // 13th Tactical Testing Sector GD01-130: guards via instance.rested -- needs a friendly (Academy) Unit and an enemy Unit to target.
  'GD01-130': (state, player, opponent) =>
    player.battleArea.some((u) => (u.def.traits || []).includes('Academy')) && opponent.battleArea.length > 0 ? {} : null,
  // Gaza C GD02-047: no guard at all in the real effect -- it unconditionally self-destructs when
  // fired (a real, non-reversible state change every time), so it's always usable as long as it's
  // still a legal activator (the shared !c.rested filter already guarantees that much).
  'GD02-047': () => ({}),
  // Zeta Gundam (LR+) GD02-069: needs to be a Link Unit, an un-rested friendly Base, once per turn.
  'GD02-069': (state, player, opponent, source) => {
    if (!source.isLinkUnit || source.activationsUsed.setActive) return null;
    return player.base && !player.base.rested ? {} : null;
  },
  // Gundam Barbatos Lupus GD03-050: needs 3+ (Tekkadan)/(Teiwaz) Units in trash and an enemy Unit to
  // target -- no once-per-turn guard in the real effect (self-limiting, exhausts trash each firing).
  'GD03-050': (state, player, opponent) =>
    player.trash.filter((c) => c.def.type === 'unit' && ((c.def.traits || []).includes('Tekkadan') || (c.def.traits || []).includes('Teiwaz'))).length >= 3 &&
    opponent.battleArea.length > 0
      ? {}
      : null,
  // GFreD GD03-035: needs 1 active Resource and a Pilot card in trash to exile as the cost, once per turn.
  'GD03-035': (state, player, opponent, source) => {
    if (source.activationsUsed.trashDamage) return null;
    if (!player.resourceArea.some((r) => !r.rested)) return null;
    const pilotCard = player.trash.find((c) => c.def.type === 'pilot');
    return pilotCard ? { exilePilot: pilotCard } : null;
  },
  // Baund Doc GD03-015: needs 3+ (Titans) cards in trash, once per turn.
  'GD03-015': (state, player, opponent, source) =>
    !source.activationsUsed.breach && player.trash.filter((c) => (c.def.traits || []).includes('Titans')).length >= 3 ? {} : null,
  // GuAIZ (Commander Type) GD03-038: guards via unit.rested (already covered by the activator filter)
  // -- needs another friendly Unit to target (buffs it AP+1, then buffs its biggest (ZAFT) Unit AP+2
  // if one exists -- that second part is optional in the real effect, no precondition needed for it).
  'GD03-038': (state, player, opponent, source) => {
    const candidates = player.battleArea.filter((u) => u !== source);
    if (candidates.length === 0) return null;
    const target = candidates.sort((a, b) => getAP(b) - getAP(a))[0];
    return { target };
  },
  // --- Batch 2 (Phase 5, remaining ~21) ---
  // Gundam Fight GD05-128: guards via instance.rested -- needs a friendly (MF) Link Unit in play and a
  // friendly Unit to target with AP+2.
  'GD05-128': (state, player) => {
    const hasMfLink = player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('MF'));
    if (!hasMfLink || player.battleArea.length === 0) return null;
    return { target: player.battleArea.sort((a, b) => getAP(b) - getAP(a))[0] };
  },
  // Turn A Gundam (LR+) GD04-067: (1), once per turn -- copies the best available keyword off any
  // player's trash Unit card (turnAKeywordValue above).
  'GD04-067': (state, player, opponent, source) => {
    if (source.activationsUsed.copyKeyword) return null;
    if (!player.resourceArea.some((r) => !r.rested)) return null;
    const candidates = [...player.trash, ...opponent.trash].filter((c) => c.def.type === 'unit' && turnAKeywordValue(c) > 0);
    if (candidates.length === 0) return null;
    return { target: candidates.sort((a, b) => turnAKeywordValue(b) - turnAKeywordValue(a))[0] };
  },
  // Trinity Warship GD04-125: (1) + rest 1 friendly (CB) Unit, once per turn -- rests the cheapest
  // (lowest-AP) CB unit available, targets the lowest-remaining-HP enemy Lv.5-or-lower (best chance
  // of actually finishing it off with the 1 damage).
  'GD04-125': (state, player, opponent, source) => {
    if (source.activationsUsed.pingCB) return null;
    if (!player.resourceArea.some((r) => !r.rested)) return null;
    const restUnit = player.battleArea.filter((u) => !u.rested && (u.def.traits || []).includes('CB')).sort((a, b) => getAP(a) - getAP(b))[0];
    if (!restUnit) return null;
    const target = opponent.battleArea.filter((u) => (u.def.level || 0) <= 5).sort((a, b) => getRemainingHP(a) - getRemainingHP(b))[0];
    return target ? { restUnit, target } : null;
  },
  // Industrial 7 GD04-130: exile 1 Command from trash, once per turn -- cheap (self-limiting via
  // trash supply), always worth debuffing the opponent's biggest threat when available.
  'GD04-130': (state, player, opponent, source) => {
    if (source.activationsUsed.debuffFromExile) return null;
    if (!player.trash.some((c) => c.def.type === 'command')) return null;
    const target = opponent.battleArea.sort((a, b) => getAP(b) - getAP(a))[0];
    return target ? { target } : null;
  },
  // White Base ST01-015: 2, once per turn -- a free token Unit for 2 resources is essentially always
  // a good trade, no target/board-state judgement needed (unlike Archangel/V2 Gundam's setActive
  // abilities below, this permanently adds a real asset rather than just buying back tempo).
  'ST01-015': (state, player, opponent, source) => {
    if (source.activationsUsed.deployToken) return null;
    return player.resourceArea.filter((r) => !r.rested).length >= 2 ? {} : null;
  },
  // Asticassia School of Technology, Earth House ST01-016: guards via instance.rested -- no resource
  // cost, unconditionally buffs every friendly Link Unit (harmless even with zero Link Units in play).
  'ST01-016': () => ({}),
  // Archangel ST04-015: 2, once per turn -- only meaningful when there's a rested friendly Blocker to
  // reactivate (an already-active Blocker gains nothing and the effect still applies "can't attack",
  // so this only fires when the source is actually rested, not merely "no benefit").
  'ST04-015': (state, player, opponent, source) => {
    if (source.activationsUsed.setActive) return null;
    if (player.resourceArea.filter((r) => !r.rested).length < 2) return null;
    const target = player.battleArea.filter((u) => u.rested && getKeywords(u).blocker).sort((a, b) => getAP(b) - getAP(a))[0];
    return target ? { target } : null;
  },
  // Vesalius ST04-016: guards via instance.rested -- needs any friendly Unit to target with AP+1.
  'ST04-016': (state, player) => (player.battleArea.length > 0 ? {} : null),
  // CGS Mobile Worker ST05-003: guards via instance.rested -- needs any friendly Unit to target
  // (deals it 1 damage, then AP+1; the effect's own default targeting doesn't know about
  // benefitsFromSelfDamage, matching the same shallow-default convention as every other resolver here).
  'ST05-003': (state, player) => (player.battleArea.length > 0 ? {} : null),
  // Isaribi ST05-015: guards via instance.rested -- only worth firing when a friendly Unit is
  // actually damaged (an undamaged target gets a real AP+2, but the card's whole design centers on
  // Tekkadan's self-damage payoffs, so restrict to a genuine damaged target rather than firing blind).
  'ST05-015': (state, player) => (player.battleArea.some((u) => u.damage > 0) ? {} : null),
  // Axis GD05-129: guards via instance.rested -- gated on the neoZeonSelfDestroyThisTurn flag plus a
  // qualifying (Neo Zeon) Lv.3-or-lower Unit card in hand to deploy.
  'GD05-129': (state, player) => {
    if (!player.neoZeonSelfDestroyThisTurn) return null;
    const hasCandidate = player.hand.some(
      (c) => c.def.type === 'unit' && (c.def.traits || []).includes('Neo Zeon') && (c.def.level || 0) <= 3
    );
    return hasCandidate ? {} : null;
  },
  // Clan Battle ST06-014: guards via instance.rested -- needs a friendly (Clan) Link Unit in play and
  // a friendly Unit to target with AP+2.
  'ST06-014': (state, player) => {
    const hasClanLink = player.battleArea.some((u) => u.isLinkUnit && (u.def.traits || []).includes('Clan'));
    return hasClanLink && player.battleArea.length > 0 ? {} : null;
  },
  // Davao ST08-015: (2), once per turn -- only worth it when a friendly Unit is actually damaged
  // (the effect's own default target is lowest-remaining-HP regardless, but an undamaged target
  // wastes 2 real resources for zero effect).
  'ST08-015': (state, player, opponent, source) => {
    if (source.activationsUsed.recoverUnit) return null;
    if (player.resourceArea.filter((r) => !r.rested).length < 2) return null;
    return player.battleArea.some((u) => u.damage > 0) ? {} : null;
  },
  // Impulse Gundam ST09-001: (2), no once-per-turn flag in the real effect -- self-limiting anyway,
  // since a successful activation bottom-decks the source itself (can't refire without redrawing it).
  // Needs a bigger (Impulse Gundam)-named Lv.4+ Unit card sitting in trash to fetch.
  'ST09-001': (state, player, opponent, source) => {
    if (player.resourceArea.filter((r) => !r.rested).length < 2) return null;
    const candidates = player.trash.filter(
      (c) => c.def.type === 'unit' && (c.def.name || '').includes('Impulse Gundam') && (c.def.level || 0) >= 4
    );
    if (candidates.length === 0) return null;
    return { target: candidates.sort((a, b) => getAP(b) - getAP(a))[0] };
  },
  // Gundam Throne Eins (GN High Mega Launcher) GD05-038: rest 3 (CB) Units, once per turn -- rests
  // the 3 weakest-AP CB units as the cost, targets a Lv.5-or-lower-remaining-HP kill if one exists
  // (finishing a nearly-dead Unit), else the biggest AP threat.
  'GD05-038': (state, player, opponent, source) => {
    if (source.activationsUsed.throneEinsBarrage) return null;
    const cbUnits = player.battleArea.filter((u) => !u.rested && (u.def.traits || []).includes('CB'));
    if (cbUnits.length < 3) return null;
    const toRest = [...cbUnits].sort((a, b) => getAP(a) - getAP(b)).slice(0, 3);
    const target = opponent.battleArea.filter((u) => getRemainingHP(u) <= 4).sort((a, b) => getAP(b) - getAP(a))[0]
      || [...opponent.battleArea].sort((a, b) => getAP(b) - getAP(a))[0];
    return target ? { toRest, target } : null;
  },
  // Nena Trinity GD04-089 (Pilot, Activate*Main via the paired Unit -- see activateMainSource below):
  // rests the paired Unit itself (already guaranteed un-rested by the shared activator filter), needs
  // another friendly Unit to buff AP+2.
  'GD04-089': (state, player, opponent, source) => {
    const candidates = player.battleArea.filter((u) => u !== source);
    if (candidates.length === 0) return null;
    return { target: candidates.sort((a, b) => getAP(b) - getAP(a))[0] };
  }
  // Deliberately left unwired (Phase 5): V2 Gundam GD05-001, Unicorn Gundam 02 Banshee Norn (Destroy
  // Mode) GD04-065, Graham's Union Flag Custom II (GN Flag) (R+) GD04-071, Gyunei's Jagd Doga GD05-057,
  // and Tallgeese ST02-006 all center on "set THIS source as active" -- but the whole point of that is
  // only realized when the source is currently rested, while collectActivateCandidates' own activator
  // filter (below) requires `!c.rested` to consider something a legal activator at all. Under the
  // current architecture these abilities can never be offered in a state where they'd do anything
  // useful (firing while already active just wastes the real cost for zero benefit, or in Graham's/
  // Gyunei's case actively hurts by applying a "can't attack"/self-destroy cost with no payoff).
  // Fixing this for real needs relaxing the shared rested-filter for this specific ability shape --
  // a small architecture change, not a per-card resolver, so it's flagged here rather than forced.
};

/**
 * Resolves which card's activateMain handler actually applies to `instance` -- almost always its own
 * def, but Nena Trinity GD04-089 is a Pilot whose Activate*Main lives on the paired Unit's `.pilot`
 * instead (pairPilot, src/rules/actions.js, never merges a Pilot's effects onto the Unit's own def;
 * same paired-Pilot-fallback shape already established for the friendlyPlaysCommand/allyPaired
 * broadcasts in actions.js). Returns null if neither the instance nor its paired Pilot has one.
 */
function activateMainSource(instance) {
  if (instance.def.effects && instance.def.effects.activateMain) {
    return { handler: instance.def.effects.activateMain, number: instance.def.number };
  }
  if (instance.pilot && instance.pilot.def.effects && instance.pilot.def.effects.activateMain) {
    return { handler: instance.pilot.def.effects.activateMain, number: instance.pilot.def.number };
  }
  return null;
}

/** Every currently-usable Activate-Main source (Base or Unit) + its resolved args, for playerIdx. */
function collectActivateCandidates(state, playerIdx) {
  const player = state.players[playerIdx];
  const opponent = state.players[1 - playerIdx];
  const activators = [player.base, ...player.battleArea].filter((c) => c && !c.rested);
  const candidates = [];
  for (const source of activators) {
    const handlerInfo = activateMainSource(source);
    if (!handlerInfo || !RESOLVERS[handlerInfo.number]) continue;
    const args = RESOLVERS[handlerInfo.number](state, player, opponent, source);
    if (args) candidates.push({ source, args, handler: handlerInfo.handler });
  }
  return candidates;
}

module.exports = { RESOLVERS, collectActivateCandidates, activateMainSource };
