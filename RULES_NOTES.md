# Gundam Card Game — Rules Deep-Dive Notes

Working notes from a full, section-by-section read of `gundam-tcg-comprehensiverules_en.pdf` (Ver. 1.8.0)
and `floor_rule_en.pdf`. Not a rules reprint — captures the exact wording/section numbers for anything
non-obvious, load-bearing for the engine, or previously gotten wrong. Cite section numbers when
implementing or explaining a mechanic; don't work from memory of this file alone once it's stale.

## 1) Game Overview
- 2-player is the base case; multiplayer (battle royale 3+, team battle exactly 4 in 2v2) is a separate rules layer (section 12), not default.
- Defeat conditions (checked via Rules Management, section 11, not instantly mid-action): (a) receive battle damage from a Unit while you have 0 cards in your shield area, (b) have 0 cards in your deck at all (not just "tried to draw and couldn't" — see 11-2-1-2, broader than the draw-phase case).
- Drawing your last card (the draw that empties the deck) is itself lethal (7-3-1-1) — already correctly implemented (`drawCard` in phases.js).
- Card text beats the comprehensive rules on conflict (1-3-1).
- Can't put something into a state it's already in — the action doesn't happen, no side effects (1-3-2-1). E.g. resting an already-rested card is a no-op, doesn't refire "when rested."
- Zero-or-negative repetition count = action not performed at all (1-3-2-2).
- Simultaneous required choices: active player chooses first, then standby (1-3-4).

## 2) Card Information
- **Colors**: blue, green, red, white, purple. **Resource cards and tokens are the only card types with no color** (2-4-2). A paired Unit's printed color is never overwritten by its Pilot's color (2-4-3).
- **Trait**: Pilot traits do **NOT** transfer to the Unit they're paired with (2-5-5) — already correctly not modeled as a transfer anywhere in the engine.
- **Lv (Level)**: "the number of resources required when playing a card." Satisfied when resource-area count >= Lv, **active or rested makes no difference** (2-9-1). All cards except Resource/tokens have a Lv; token Lv = 0.
- **Cost**: paid by resting the necessary number of **active** Resources (2-10-1). No color condition. Token cost = 0.
- Pilot cards have two texts: above the name = the Pilot's own (typically Burst), below the name = effects **gained by the paired Unit** (2-11-3).
- **Link Condition** only exists on **Unit** cards (2-12-2) — it describes which Pilot(s) satisfy the link, not something Pilots carry. Bracket syntax `[xyz]` = satisfied if the paired Pilot's name *contains* that substring (3-2-6-4) — matches `matchesLinkCondition`'s `.includes()` check.

## 3) Card Types
- Units: only card type that can attack. Can't attack the turn deployed **unless** it's a Link Unit (a Unit whose paired Pilot satisfies its link condition) — Link Units can attack immediately (3-2-6-3).
- Pilots: can only exist in the battle area while paired (3-3-3). Can't be freely removed/swapped (3-3-5). **When a Unit paired with a Pilot is destroyed, returned to hand, or otherwise moved from the battle area to another location, the paired Pilot moves to the SAME location as the Unit** (3-3-6) — not automatically trash. ✅ **Fixed 2026-08-01**: `removeFromField` now takes an optional `destinationZone` param and routes the paired Pilot there instead of trash (defaults to trash when omitted, matching the battle-area-limit-bump case which really is trash-bound). All 4 "return enemy Unit to hand/deck" effect sites in `registry.js` now pass the matching zone. Audit also caught a real bug along the way: Impulse Gundam ST09-001's Activate·Main (return itself to the bottom of its own deck) was hand-splicing the Unit out of the battle area directly, silently dropping any paired Pilot reference into the void instead of moving it anywhere — now goes through `removeFromField`/`sendToZone` like everything else. Tests in `test/rules.test.js`.
- Commands: some have a **[Pilot]** sub-effect (bottom portion, own traits/AP/HP/second name) — when played, can be paired as a Pilot **instead of** activating the Command effect (3-4-6-2). Some also have **[Burst]** in addition to their normal Command effect.
- Bases: AP shows a Base's "offensive strength in battle" (3-5-4-1) — worth noting Bases nominally have an AP stat for battle purposes even though nothing in the current engine ever has a Base attack; likely only relevant for some specific card' text, not a default action.

## 4) Game Locations
- "Field" = resource area + battle area + shield area collectively (4-1-1-2).
- Moving between locations = treated as a **brand new card**; any effects applied to it previously are wiped (4-1-5) — matches `createInstance` being called fresh on every deploy.
- **Base section is public**; the **Shield section is private** (cards face down, order/contents hidden) even though they're both technically part of "the shield area" (4-6-3-1 vs 4-6-4-1). Default when moving a card out of the shield section = take the **top** card (4-6-4-1).
- Shields are always 1 HP each (4-6-4-2 / 11-3-1-1).
- Hand limit (10) is only enforced/checked **during your own end phase** (hand step) (4-8-4) — matches `enforceHandLimit` being called from `runEndPhase`.
- Resource area max 15 total, max 5 EX Resources (4-4-2) — though in practice only ever 1 EX Resource is granted (Player Two only, see below), so this ceiling is essentially unreachable under normal play.

## 5) Essential Game Terminology (glossary — the load-bearing definitions)
- **Damage**: excess damage beyond a Base/Shield's HP does **not** spill over to another Shield (5-5-6) — no overkill/trample. 0 damage is never dealt (no-op, no triggers).
- **HP Recovery**: a Unit with 0 damage **cannot** recover HP at all (5-6-3) — it's a no-op, not "recover 0."
- **Destroy**: when a Shield is destroyed, **first reveal it and check for Burst, decide whether to activate it, THEN place into trash** (5-10-3) — reveal happens before the trash placement, not after.
- Cards trashed by **rules-management overflow** (battle-area-of-6 or base-section-of-1 excess) are explicitly **not** treated as "destroyed" (5-10-4) — no Destroyed trigger fires. Already correctly special-cased in `enforceBattleAreaLimit`/`enforceBaseLimit`.
- **Remove**: a removed Unit/Base is not treated as destroyed either (5-12-2).
- **Token** (5-17): tokens are colorless, Lv 0, Cost 0 (5-17-2-3/4). **When a token moves to any location other than the battle area, resource area, or shield area, it is removed from the game** (5-17-2-5) — it momentarily passes through the destination first so "when destroyed"/"returned to hand" triggers still fire, then vanishes rather than sitting in trash/hand permanently. ✅ **Fixed 2026-08-01**: added `sendToZone` in `management.js` (pushes to a zone array unless `.def.isToken`); `destroyCard`, `removeFromField`, `enforceBattleAreaLimit`, and `enforceBaseLimit` all route through it now, as do the 4 bounce-to-hand/deck effect sites in `registry.js`. Tests in `test/rules.test.js`.
- **EX Base**: a Base token, 0 AP / 3 HP, one placed active in each player's base section at game start (5-17-3-1). Already correct (`EX_BASE_DEF` in `setup.js`).
- **EX Resource**: a Resource token, **Player Two only**, one placed active in their resource area at game start (6-2-4). **When an EX Resource is used to pay a cost, it is removed from the game** (5-17-3-2-3) — single-use, not just "rested until next untap." ✅ **Fixed** (see Open items #1 below).
- **"If you do" vs "Then"**: if the clause *before* "If you do" fails to resolve, the clause *after* it does not resolve either (conditional) (5-20-1). If the clause *before* "Then" fails to resolve, the clause *after* "Then" **still can** resolve (sequential, not conditional) (5-20-2). Distinct connector words with different resolution semantics — matters for any future card text using either phrase.
- **Reduce**: if reduction >= incoming damage, the result is 0, and 0 damage is neither dealt nor received (5-21-2-1) — no partial no-op weirdness, matches `dealDamage`'s early-return-on-<=0 approach.
- **Battle** (5-22): if an effect starts a battle skipping the normal attack step (e.g. "begin a battle... only perform the damage step"), **[Attack] and "when this Unit attacks" triggers do NOT fire**, since the attack step itself was skipped (5-22-3-1) — matches the existing Nu Gundam (GD05-017) implementation, which calls `resolveUnitBattleDamage` directly rather than going through `resolveAttack`'s full step sequence.

## 6) Preparing to Play
- Resource deck: exactly 10 cards, Resource-type only, **no 4-copy cap** — "any number of Resource cards with the same card number" is legal (6-1-1-5), unlike the main deck's 4-copy limit.
- Setup order: shuffle deck → place resource deck face down → determine P1 (RPS/die, winner picks) → draw 5 each → **P1 decides mulligan first, then P2** → each player takes their **top 6 deck cards one at a time** face down into the shield section, overlapping, nearest-to-them card first → **each player** places 1 active EX Base into their base section → **Player Two only** places 1 active EX Resource into their resource area → Player One's turn begins.

## 7) Game Progression
- Turn = start phase → draw phase → resource phase → main phase → end phase, in that order, each fully resolving before the next begins.
- **Start phase**: active step (untap everything in battle area/resource area/base section, simultaneously) → start step ("at the start of your turn" effects).
- **Resource phase**: place exactly 1 Resource card, face up and **active**, from resource deck to resource area.
- **Main phase**: any order, any number of repeats, of: play a card from hand (deploy Unit, deploy Base, pair a Pilot, activate a Main-timing Command), activate an Activate·Main effect, attack with a Unit. Can attack the opposing player or a **rested** enemy Unit only (7-5-4-1) — active enemies aren't legal targets by default, matches `chooseAttackTarget`'s baseline filter.
- **End phase**: action step (**standby player acts first**, alternating, until both consecutively pass) → end step ("at the end of the turn" effects) → hand step (discard to 10) → cleanup step (turn-duration effects expire, any resulting triggers resolve).

## 8) Attacking and Battles
- Steps in order: attack → block → action → damage → battle end.
- Attack step: rest the attacker, declare target (opposing player or a rested enemy Unit). [Attack] triggers fire here.
- Block step: **standby player** may activate a Blocker Unit to redirect the attack to it (once per attack, can't self-block the original target).
- Damage step: player attack with no Base/Shields = instant loss; Base present = damage goes to Base; Shields only = top Shield takes damage (Suppression hits top 2 simultaneously — see keyword section); Unit-vs-Unit = simultaneous AP trade unless First Strike.
- (No new info beyond what was already implemented/verified in an earlier session — First Strike pre-empting return damage, Blocker validity checks, Breach-on-kill, all confirmed correct against 13-1-x already.)

## 9) Action Steps
- Applies both mid-battle (after the block step) and during the end phase.
- Priority-passing structure: **standby player** chooses first each round (activate an Action Command, activate an Activate·Action effect, or pass), then active player does the same; alternates until **both** consecutively pass.
- ⚠️ **Known engine simplification, not a bug**: this is effectively a full priority/stack system (closer to Magic's stack than anything currently modeled). The engine's `hooks.actionStep` is a single optional callback, not a real back-and-forth loop, and the AI heuristic doesn't appear to use Action-timing Commands or Activate·Action abilities reactively at all. Fine for the current card pool (nothing implemented needs it yet) but worth knowing this is unmodeled if a future card's whole gimmick is an Action-step interaction.

## 10) Effect Activation and Resolution
- Five effect types: **constant**, **triggered**, **activated**, **command**, **substitution**.
- **Constant**: always active while in its activating location; some are conditional (only active while a condition holds, no "trigger" needed — continuously live, re-evaluated the instant the condition changes) (10-1-5-3/10-1-5-7). Matches the engine's live-computed `getAP`/`getKeywords` pattern already. **Conflicting constant effects: ones that say "can't" beat ones that would allow** (10-1-5-6) — a real precedence rule (restrictions > permissions) to keep in mind for any future interacting keywords.
- **Triggered**: fires automatically on its condition. Without an explicit "Once per Turn," fires **every time** the condition is met that turn, not just once (10-1-6-1-1). **If multiple simultaneous events satisfy the same trigger condition, the effect still only triggers once** (10-1-6-3) — e.g. a board wipe destroying 3 friendly Units simultaneously would only fire a "when a friendly Unit is destroyed" trigger once, not 3 times. ✅ **Audited 2026-08-01, no bug found**: no implemented card actually has a "whenever a friendly Unit is destroyed"-style broadcast trigger shape (searched for any `.def.effects` handler keyed that way, analogous to `friendlyUnitDestroysEnemy` in `combat.js` -- none exist). `Widespread Annihilation`'s board wipe does call `fireCardEffect(..., 'destroyed', ...)` once per unit, but that's each unit's *own* Destroyed trigger firing correctly, not a shared broadcast over-firing. Nothing to fix today; if a future card introduces this trigger shape, it needs `triggerEvent`-style batched dispatch (fire once, not per-instance) rather than a naive per-unit loop.
- If a card's triggered effect is still waiting to resolve when the card **leaves** its active location, **it still resolves** (10-1-6-4).
- Trigger ordering: **your own** simultaneous triggers resolve in an order **you** choose (10-1-6-5). Triggers belonging to **both** players: **active player's** triggers all resolve first (in their own chosen order), **then** standby player's — not interleaved (10-1-6-6). A new trigger appearing mid-resolution gets **priority** over the remaining queued ones (10-1-6-7). **Burst** effects get absolute priority over any other simultaneously-triggered effects (10-1-6-8), and a new trigger arising while resolving multiple Bursts gets priority over the remaining Bursts too (10-1-6-8-1).
- **Activated**: freely activated when timing permits. A "①" symbol = pay a cost equal to the printed number as part of the activation condition. Multiple comma-separated conditions must **all** be satisfied.
- **Command**: can't be played at all if it requires choosing a target and none exists (10-1-8-1-1) — same for "Then"/"If you do" clauses that need a target.
- **"Choosing a target"** specifically means selecting a player or a card in a **public** location (battle area, base section, resource area, trash) (10-2-2-1) — hand/shields/deck aren't "target" locations by this definition; effects that pick from those use different framing (reveal-then-choose, dig-the-top-N, etc.), not literal targeting.
- Effect activation order: confirm conditions met → declare/reveal → activate → resolve anything that triggers *in response to the activation itself* (10-3-1) — a small reactive window the current synchronous engine doesn't model, but nothing implemented currently needs it.
- "Choose"-style targets in a Command/triggered effect are chosen **at the moment that instruction appears in the text**, not pre-declared (10-3-3). If the text doesn't say "choose" but is clearly targeted, the implicit target is the card generating the effect itself (or its owner, for player-targeted text) (10-3-4).
- Digging into the deck: **confirm the top card(s) first, then choose** the specified card from among them (10-3-5) — matches the existing splice-then-pick pattern used across the codebase's "dig" effects.

## 11) Rules Management
- Auto-resolves the instant a qualifying event occurs, interrupting anything else mid-resolution — not optional, no response window.
- Defeat check happens **at the start of** a rules-management pass; if any player currently meets a defeat condition, **all** players who do are defeated **simultaneously** (11-2-1) — a genuine double-KO is possible.
- Defeat condition #2 is **"0 cards in deck," full stop** (11-2-1-2) — broader than "tried to draw and couldn't." Any effect that empties a deck to 0 (not just the draw-phase draw) should trigger this. ⚠️ Worth checking `checkDefeat()` is actually called after every deck-size-reducing action in the engine (mills, deck-based costs), not just after the draw phase and combat.
- Battle-area-of-6 / base-section-of-1 overflow: trash the excess (not destroyed). **If multiple Units are deployed simultaneously, trash an equal number** to restore the limit in one pass (11-4-2-2), rather than evaluating one at a time.

## 12) Multiplayer Battle (not applicable to this 2-player-only simulator, read for completeness)
- Battle royale (3+, free-for-all) and team battle (exactly 4, 2v2 with a **shared** shield area per team) are separate rule sets layered on top of the 2-player base rules. Team battle changes several setup numbers (4 shields per player instead of 6, since shared; **both** members of Team Two place an EX Resource, not just one player). None of this applies unless the simulator ever adds >2-player support.

## 13) Keyword Effects and Keywords

### Keyword *effects* (numeric formulas, most stack additively when granted again)
- **`<Repair(amount)>`**: "At the end of your turn, this Unit recovers (amount) HP." Stacks additively (gaining a 2nd copy adds to the existing amount, not a separate instance) (13-1-1-2).
- **`<Breach(amount)>`**: fires when the Unit destroys an enemy Unit **with battle damage** (not effect damage) during **your** turn; deals (amount) to the enemy's **Base if present, else topmost Shield** (13-1-2-2). Fires even if both Units mutually died in the trade (13-1-2-3). No-ops if the enemy has neither Base nor Shields (13-1-2-4). Stacks additively (13-1-2-5). **"During your turn" clarified by Jake**: this specifically excludes the defensive case — if your rested Unit (which can't act, but still deals its own AP as return battle damage per the normal simultaneous-damage rule) gets attacked and its return damage happens to kill the attacker, that kill happens on the *opponent's* turn, so Breach does **not** trigger even though your Unit did "destroy an enemy Unit with battle damage." Breach is an attacker-side bonus only, never triggered off return damage. **Engine check**: already correct — `resolveUnitBattleDamage` only ever reads `getKeywords(attacker).breach`, checked solely in the branch where the *defender* dies, never checking the defender's own Breach when the attacker dies to return damage. No fix needed, just confirmed.
- **`<Support(amount)>`**: literally defined as "【Activate·Main】Rest this Unit: Choose one other friendly unit. It gets AP+(amount) during this turn" (13-1-3-1) — a self-resting activated ability, not a static aura. Stacks additively.
- **`<Blocker>`**: redirects the attack target to itself when activated during the block step, resting itself. Does **not** stack (boolean) (13-1-4-2).
- **`<First Strike>`**: deals battle damage first; if that kills the target, no return damage is dealt at all. Does not stack (boolean). Explicitly still applies even for "begin a battle... only perform the damage step"-style effects (13-1-5-4, a v1.8.0 addition) — confirms the Nu Gundam pattern is handled correctly.
- **`<High-Maneuver>`**: active only while the Unit is attacking; enemy Units can't activate Blocker against it during that attack. Does not stack.
- **`<Suppression>`**: hits the **first two** Shields simultaneously with battle damage (only the one Shield if just one remains). **If both hit Shields have Burst effects, their OWNER (the defender) chooses which order to resolve them in** (13-1-7-4). ✅ **Fixed 2026-08-01**: `resolveDamageStep` still destroys both shields via `destroyTopShield`, but Burst resolution now goes through an optional `hooks.chooseBurstOrder(destroyedShields)` hook that lets the defender reorder them; defaults to the original fixed top-then-next order when the hook isn't supplied (the AI doesn't currently supply one -- low-impact enough not to matter for heuristic play). Test in `test/rules.test.js`. Does not stack. **Confirmed by Jake**: Suppression never triggers against a Base — if a Base is present, damage priority routes to the Base as normal (single hit, no keyword bonus), matching the engine's existing branch structure (Suppression is only checked inside the no-Base/shields-only path). Also confirmed: with exactly 1 Shield remaining, Suppression does **not** spill the "missing" second hit through to the player (no lethal win-through) — it just destroys the 1 available Shield and stops, matching `Math.min(2, shields.length)` already in the code.
- **`<Development(number)>`**: embedded inside a timed keyword like 【Deploy】 or 【When Linked】, e.g. "【Deploy·Development(number)】" = "you may exile (number) (G Generation) cards from your trash [out of the game]. If you do, activate the following effect" — a trash-exile cost gating a bonus effect. The bonus-effect text is printed after a "■" marker on the physical card (13-1-8-2) — a print convention to recognize when reading future card scans, not a rule with its own engine logic beyond "cost then bonus effect."

### Keywords (pure timing/activation markers, no formula of their own)
- **【Activate·Main】** / **【Activate·Action】**: activated-effect timing, main phase (not mid-attack) vs. action steps respectively.
- **【Main】** / **【Action】**: Command-effect timing, main phase (no Units attacking) vs. action steps. **Cannot pair a Command-with-[Pilot]-effect as a Pilot during an action step** (13-2-4-2) — pairing that way is a Main-phase "play a card" action only.
- **【Burst】**: activates immediately before a destroyed Shield goes to trash; always **free** (no cost paid) (13-2-5-1) — matches every `xBurst` effect in `registry.js` never calling `payCost`. If activated, resolve it before the card moves to trash; if the effect doesn't relocate the card, it goes to trash right after (13-2-5-3).
- **【Deploy】** / **【Attack】**: fire on deploy / on declaring an attack, respectively.
- **【Destroyed】**: fires from the trash, as an effect on the now-trashed card (13-2-8-2). If its text references the card's own state, use its state **at its last location before being destroyed** (13-2-8-2-1), not its (blank) trash state — matches the existing `{wasPaired}`-style pre-computed context pattern used for Destroyed effects.
- **【When Paired】**: fires on any pairing; can be qualified — "【When Paired·(qualifications)】" only fires if the paired Pilot meets those specific qualifications.
- **【During Pair】**: constant ability active while **any** Pilot is paired (optionally qualified, e.g. "while an (Earth Federation) Pilot is paired" — any pilot with that trait, not necessarily one satisfying the Unit's own link condition). **Distinct from "During Link."**
- **【When Linked】**: fires specifically when a pilot satisfying the Unit's **link condition** is paired (i.e., becoming a Link Unit) — narrower than When Paired.
- **【During Link】**: constant ability active only while the paired Pilot satisfies the link condition (i.e., only while it IS a Link Unit) — narrower than During Pair. Matches the engine's `isLinkUnit`-gated reads exactly.
- **【Once per Turn】**: the restriction is **per card instance** — if multiple copies of the same card (each with their own copy of the effect) are in play, **each one** gets its own once-per-turn activation, independent of the others (13-2-13-2). Matches the engine's per-instance `activationsUsed` tracking.

---

## Floor Rules (`floor_rule_en.pdf`, Bandai Organized Play Tournament Rules Manual)

Read in full (46 pages). This is almost entirely tournament administration — event participants/roles
(judges, TOs, scorekeepers, spectators, media), tournament formats and structure (Swiss/single-elim/top
cut, round counts by attendance, match/game time limits), deck list submission and deck-check
procedure, sleeves/tokens/playmat equipment rules, penalty tiers (Caution → Warning → Game Loss →
Match Loss → Disqualification → Suspension) with a long catalog of example infractions, and an Online
Event Supplement (Discord/webcam setup for remote play). None of that has bearing on the simulator's
engine — it governs human tournament conduct, not game mechanics. Reading it in full confirmed there's
no hidden gameplay rule buried in there that contradicts or extends the comprehensive rules, with one
useful exception:

- **4.11 Public Knowledge / 4.12 Private Knowledge** — an explicit, clean list that sharpens section 4 of
  the comprehensive rules:
  - **Public** (must answer truthfully if asked): number of cards in hand, number of cards in deck
    (main *and* resource), number **and names** of cards in trash, number of Shields remaining, current
    damage counters on all cards in public zones, printed info on any card mentioned by name, which
    cards have been played during the *current* turn.
  - **Private** (must not answer): the actual cards in the main deck, what cards are in the Shield area,
    which cards are in *either* player's hand, and — notably — which cards were played/activated
    during the *previous* turn (unless there's an active ongoing effect referencing it). This last one
    is a real nuance not spelled out in the comprehensive rules: "what happened" becomes private again
    one turn later.
  - Not engine-relevant for a solo AI-vs-AI simulator (there's no human opponent to withhold information
    from), but useful for calibrating expectations if this project ever adds a human-vs-AI or
    human-vs-human mode, or a UI that reveals more than a real match would.
- **6-1-1's deck-construction numbers are reconfirmed verbatim** (50-card main deck, 10-card resource
  deck, max 4 copies per main-deck card number, up to 2 colors) — 2.4 Tournament Materials restates the
  exact same limits, no discrepancy.
- **8.2 Online Event Supplement**: "When a card instructs a player to look at a card in an opponent's
  private area, that card is instead revealed to both players." This is a webcam-play procedural
  adaptation (there's no way to look-but-not-reveal over a webcam), not a core rule — the *real* game
  has a genuine "look privately without revealing" concept that this online supplement collapses for
  practical reasons. Not relevant to the simulator either way, since there's no concealment between two
  AI-controlled players to begin with.

## Clarifications from Jake (his ruling, not stated explicitly in either document)

Asked after finishing both documents, on points where the rules text itself left me genuinely inferring rather than reading something explicit. These are authoritative for this project even where the PDFs are silent or ambiguous.

1. **The "①" activated-effect cost symbol** (10-1-7-3) is paid in **Resources**.
2. **Breach's "during your turn" clause** exists specifically to exclude the defensive/return-damage case (see the updated Breach entry above) — confirmed the engine already handles this correctly.
3. **Suppression never triggers against a Base**, and does **not** spill through to the player when only 1 Shield remains — confirmed the engine already handles both correctly (see the updated Suppression entry above).
4. **Genuine simultaneous double-defeat (11-2-1) is a draw** for this project. (In real tournament play a tie-breaker system may apply, but this simulator isn't modeling tournament rules, only the base game rules — so it should just be a draw, full stop.) ✅ **Fixed 2026-08-01**: `checkDefeat()` in `management.js` now detects the both-defeated case and sets `state.draw = true` instead of picking an arbitrary winner. `state`/`createGame` gained a `draw` field, `playGame`'s result gained a `draw` field (and `timedOut` was corrected to exclude the draw case), and `runBatch`/`bin/simulate.js` both now tally draws as their own distinct count instead of silently mis-attributing them as a win for one side. Tests added in `test/rules.test.js`. (Note: two scratchpad-only analysis scripts, `run_matchups.js`/`mirror_sweep.js`, still have the old mis-attribution — left alone since they're throwaway tools, not the shipped codebase, and a real double-defeat is very hard to construct via normal AI play in the first place.)
5. **A required-but-unsatisfiable choice always fizzles the whole effect, no partial resolution** — confirmed this applies beyond the literal "target" definition (10-2-2-1's public-location wording) to hand-based choices too: e.g. "choose a card from your hand" with an empty hand does nothing at all, the card is simply wasted. Same for multi-clause choices like "choose an enemy Unit and one of your Units, deal 1 to each" — if *either* side has no legal choice, the whole effect does nothing. Matches the `if (!target) return;` idiom already used throughout `registry.js`'s effect implementations, though not exhaustively re-audited against this specific empty-hand case.

## Open items found during this read

Status as of 2026-08-01: all 6 concrete bugs found during the rules read are now fixed and tested. Only
item 6 (a known AI simplification, not a bug) remains genuinely open.

1. ✅ **Fixed**: EX Resource is now single-use (5-17-3-2-3) — `payCost` removes any token Resource from `resourceArea` entirely when spent, instead of just resting it. Tests in `test/cost.test.js`.
2. ✅ **Fixed**: Tokens now vanish (are removed from the game) when they leave the battle/resource/shield area (5-17-2-5), via a new `sendToZone` helper in `management.js` used everywhere a Unit/Base/Pilot lands in trash/hand/deck. Tests in `test/rules.test.js`.
3. ✅ **Fixed**: Suppression's simultaneous double-Burst now lets the defender choose resolution order via an optional `hooks.chooseBurstOrder` (13-1-7-4), defaulting to the original fixed order when unset. Test in `test/rules.test.js`.
4. ✅ **Fixed**: A paired Pilot now follows its Unit to whatever location the Unit moves to (3-3-6), via `removeFromField`'s new `destinationZone` param. Also fixed a real bug found during the audit: Impulse Gundam ST09-001's self-bounce-to-deck was dropping its paired Pilot into the void instead of moving it anywhere. Tests in `test/rules.test.js`.
5. ✅ **Audited, no bug found**: no implemented card currently has a "whenever a friendly Unit is destroyed"-style shared/broadcast trigger (10-1-6-3), so there's nothing that could be over-firing today. Left a note in the rules section above for whoever implements the first such card: use batched dispatch, not a per-unit loop.
6. Activate·Action abilities / reactive Action-step Command usage aren't modeled by the AI at all — a known simplification, not urgent unless a future card's whole design depends on it.
7. ✅ **Fixed**: Simultaneous double-defeat is now a draw (see clarification #4 above) — `checkDefeat()`, `state.draw`, `playGame`, `runBatch`, and `bin/simulate.js` all updated together. Tests in `test/rules.test.js`.

All rules bugs found during the deep read are now resolved. Item 6 is a deliberate AI scope limitation, not a rules-accuracy bug.
