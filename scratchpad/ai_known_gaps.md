# Known AI gaps (found 2026-08-05, off-meta deckbuilding + AI research session)

All 4 items below are resolved: items 1/3/4 fixed and verified; item 2 was fixed at the code level and
retrained, but the retrain came back a null result (see its own entry) -- closed, not pending. Each
entry: what was missing, where, why it mattered, confirmed how.

## 1. FIXED (2026-08-05) -- Action-step (mid-combat reactive) timing is now wired to both AIs

Was much bigger than the initial 4-card estimate: extracting real `[Action]`/`[Main]/[Action]` timing
tags from `registry.js` comments found 75 command cards affected (43 Action-only, 32 Main-or-Action),
including two central pieces of this session's own blue/white deck (Wings of Light GD05-102 is
Action-only, Siege Ploy ST02-014 is Main/Action). Worse, there was no timing enforcement *at all* --
Action-only cards were being played proactively in the Main phase (rules-illegal) since
`heuristic.js`'s command legality never checked timing, and neither AI ever got a reactive window to
use any of them at the moment they'd actually matter.

**Fix:** added a real `actionTiming` field ('action'|'both') to all 75 card defs (data-driven, not
hardcoded per-card). `collectCommandCandidates`/`runCommands` (`heuristic.js`) now exclude Action-only
cards from Main-phase legality. `combat.js`'s Action Step now passes a real, mutable `battleTarget`
reference through `hooks.actionStep`, and a new `actionStep` heuristic (`heuristic.js`, added to both
`defaultHooks()`/`lookaheadHooks()`, so both MCTS and the lookahead engine get it automatically since
MCTS already reuses these same hook bundles) reactively plays one legal Action-eligible card from the
defending player's hand when facing lethal or a bad trade -- same facingLethal/badTrade gate
`chooseBlocker` already uses. `playCommand` (`actions.js`) now accepts `opts.extraContext` to thread
`battleTarget` through for redirect-style cards.

**Known scope limit, not a bug:** doesn't rank *which* eligible card is best for 75 different effect
shapes -- picks the first legal one and lets each card's own existing fallback targeting choose within
itself. Also only gives the *defending* player a reactive window (the common, valuable case); the
attacking player's own mid-combat Action-step options aren't modeled. A real first step, not full
priority-alternation per the official rules.

Verified with 4 new tests (`test/ai.test.js`): Main-phase exclusion for Action-only cards, an
Action-only card never getting played by `runCommands`, a full reactive Wings-of-Light bounce saving a
unit from a lethal attack, and a full Master-League-Begins redirect via the `battleTarget` mutation
path. Full suite: 924/924 passing.

## 2. CODE FIXED, RETRAINED -- NULL RESULT (2026-08-05) -- `trashSynergyValue` was a coarse, generic signal

`src/rules/management.js:325` gives credit for "progress toward any trash-synergy threshold," scaled
0-1 -- real, but generic ("some payoff is getting closer"), not specific ("this exact unit on my board
is a free kill waiting to happen," e.g. Nu Gundam GD05-017's `[When Paired]` safe-kill snipe). Confirmed
empirically, not just theorized: re-testing the exact same off-meta deck against `nu_gundam_real.txt`
under the newly-adopted trained net + higher search budget produced the *identical* 5-25 (16.7%) result
as under the old linear formula/old budget -- upgrading the evaluator and search depth made zero
measurable difference, consistent with a generic smoke detector rather than a precise one.

**Fix:** added `vulnerableUnitCount` to `valueFeatures.js` (2 new features, self/enemy) -- counts units
actually exposed to a safe kill right now, using the same remaining-HP-vs-attacker-AP /
own-AP-vs-attacker-remaining-HP shape `chooseBlocker`'s own `badTrade` gate already uses, aggregated
across the whole board instead of one declared attack. Deliberately not Nu-Gundam-specific -- it's "how
exposed is this board to a free kill," true regardless of which card would cash it in. `FEATURE_COUNT`
29 -> 31, appended at the end (not interspersed) specifically so the *currently-shipped* net's first 29
inputs stay byte-identical -- verified directly (`loadNet` + `forward` on the real `data/valueNet.json`
against the new 31-length vector: no crash, finite output, since `forward`'s loop bound is the net's own
stored `inputSize`, not the live `FEATURE_COUNT`). Two new tests in `value_features.test.js` confirm the
feature itself picks the right unit in a constructed Nu-Gundam-shaped scenario. Full suite: 926/926.

**Retrain result (2026-08-05, `bin/train_value_net.js --resume`, defaults, 196-deck pool):** ran to
completion in 36.5 min. Round 1's candidate (a fresh 31-input net, trained on 2500 self-play games
generated with the current champion) beat the resumed champion only 51.4% of the time (302-286,
z=0.66) -- nowhere near the z>=2.5 significance bar, so the script correctly stopped after round 1 and
never adopted it. `data/valueNet.json` is functionally unchanged (still `inputSize:29`; the file diff
is just a JSON round-trip re-serialization of the same unchanged weights, not a content change).

**Follow-up (2026-08-06): re-verified at a much bigger sample, on Jake's request, before accepting the
null.** Round 1's original verify was only 588 games (196 decks x 3/deck, the script's own default at
this deck-pool size) -- too small to rule out a real-but-modest effect on its own. Re-ran identically
(`--resume`, same defaults) except `verifyGamesPerDeck` raised to 20 (3920 games, matching the
confirm-step's own scale). Result: **49.1% (1923-1997), z=-1.18** -- more data moved the result *below*
50%, not toward significance, which is the opposite of what a real-but-underpowered positive effect
would look like. Two independent runs (different self-play datasets each time) now agree there's no
positive edge.

**Honest null result, not a bug:** `vulnerableUnitCount` does not measurably improve the AI.
Most likely explanation: `trashSynergyValue`'s existing generic signal already captured most of the
practical value this feature was meant to sharpen, making it genuinely redundant rather than merely
under-tested. Consistent with the original investigation's other finding (upgrading the
evaluator/search budget alone also produced zero measurable change on the Nu Gundam matchup) -- the
coarse-signal theory may simply not have been the real bottleneck for that matchup. Closed as a real
negative result, not an open item -- the `vulnerableUnitCount` feature code stays in `valueFeatures.js`
(harmless, backward-compatible, already tested) but nothing further is planned here without a new
reason to expect a different outcome.

## 3. FIXED (2026-08-05) -- mutual-destruction [Destroyed] triggers resolved in the wrong order

Official rules (Q108/Q110) specify a real ordering discipline for simultaneous triggers: the active
player's effects all resolve first as a batch, then the standby player's, never interleaved, with Burst
always jumping the queue. Grepping `src/rules` for `simultaneous`/`triggeredEffects`/`effectQueue` found
no formal queue at all -- effects fire as direct synchronous calls -- so this wasn't enforced anywhere
as a policy. Found a real, concrete violation in `combat.js`'s mutual-destruction path
(`resolveUnitBattleDamage`): the defender's (standby player's) `[Destroyed]` trigger, and the attacker's
own Breach/`destroysEnemy` reactions, were firing *before* the attacker's (active player's) own
`[Destroyed]` trigger -- backwards on both counts, since the attacker is always the active player here
(attacks only ever happen on your own turn).

**Fix:** decoupled "remove a dead unit from the battle area" (immediate, no ordering ambiguity, 8-5-3-2)
from "fire that unit's `[Destroyed]` card text" (Q108-ordered) via a new `fireDestroyedTrigger` helper,
so both units die immediately (keeping existing effects that scan `battleArea` correct -- a live
regression test, `cards7.test.js`'s Penelope test, caught this exact removal-timing issue on the first
attempt and forced the fix) while the attacker's full batch (own `[Destroyed]`, Breach, `destroysEnemy`)
resolves before the defender's `[Destroyed]`. New regression test added
(`test/rules.test.js`: "mutual destruction: the active (attacking) player's [Destroyed] reaction fires
before the standby (defending) player's") locks in the actual ordering claim, not just the removal-timing
side effect. Full suite green throughout (919 -> 920 -> 924 as fixes/tests were added).

**Residual scope, not claimed fixed:** this only covers the one call site (mutual battle destruction).
Whether the same active-before-standby ordering holds everywhere else multiple triggers can fire at once
(e.g. two different `[Deploy]` reactions, or a Burst reveal alongside another trigger) hasn't been
audited -- flagging as still open if it comes up again, not asserting it's now universally correct.

## 4. FIXED (2026-08-05) -- `[Activate·Action]` abilities are now wired into the same reactive window as item 1

Item 1's fix covered Command-card `[Action]` timing only. There's a separate mechanic, activated
abilities tagged `[Activate·Action]` (as opposed to `[Activate·Main]`, which `runActivations`/
`RESOLVERS` already handled), usable during any Action Step (8-4) -- e.g. Daryl Lorenz EB01-070's
"(1): If it is your opponent's turn, choose 1 Unit. It gets AP+1 during this battle." Jake pushed back
on treating this as a separate, deferred gap: "activate action can ALSO be played during the combat
phase" -- i.e. it belongs in the exact reactive window heuristic.js's `actionStep` (item 1) already
built for Action-timed Commands, not a whole new mechanism.

Found 12 real card references (11 distinct handlers, G-Sky Easy's is byte-identically reused by
Gundam Mk-III EB01-020) via `effectRefs.activateAction` across the card JSON. Two of them (Taurus (Sanc
Kingdom) EB01-033, Daryl Lorenz EB01-070) turned out to be actual latent bugs, not just unwired: their
handlers never checked the Once-per-Turn flag or paid their real (1) cost, since nothing had ever
called them before now -- wiring them into the AI without fixing that would have let it spam a free
buff every reactive window. Fixed both to guard/pay correctly (Daryl Lorenz also gained the
isLinkUnit check its own "[During Link]" text requires but the code never enforced).

**Fix:** new `ACTION_RESOLVERS` table in `activations.js` (the Activate·Action counterpart to the
existing Activate·Main `RESOLVERS` table), keyed by card number, each resolving a per-card
target/precondition against the battle actually in progress (`battleCtx = {attacker, target}`, `target`
already reflecting a chosen Blocker). `collectActivateActionCandidates(state, playerIdx, battleCtx)`
collects every currently-legal source; `heuristic.js`'s `actionStep` (already shared by both the
lookahead AI and MCTS, same as item 1) now tries one reactive Command *and then* one reactive
Activate·Action ability per Action Step, re-checking the battle is still on in between (a Command like
Wings of Light can already end it) so an ability never targets a unit that just left the fight. 9 of
the 11 handlers got a real resolver (G-Sky Easy/Mk-III, Taurus, Daryl Lorenz, Galluss-K, Gundam Aerial,
Elan Ceres, Graze Ein, AGE-2 Double Bullet, Schwarzette).

**Known scope limit, not a bug -- same shape as item 1's:** only the *defending* player gets a
reactive window (no full priority-alternation). Two cards, Gamow GD01-127 and Moebius Peacemaker
GD02-011, are naturally *attacker*-side abilities (their whole point is Breach damage forward into an
enemy Base/Shields, which only happens while attacking) and stay unwired for that reason -- documented
directly in their own `registry.js` comments now, not silently dropped.

Verified with 2 new tests (`test/ai.test.js`): Taurus reactively buffing an attacked Unit turns a
one-sided loss into a mutual kill; Schwarzette's self damage-reduction turns a lethal hit into a
survived one. Plus the 2 handler-guard fixes got their own updated unit tests (`test/cards52.test.js`,
`test/cards54.test.js`) proving the (1) cost and Once-per-Turn flag are now real. Full suite: 928/928.

---

## Investigated and resolved (not bugs) -- kept for the record

**Nu Gundam GD05-017's `[When Paired]` kill -- does it skip return damage entirely?** Briefly flagged as
an open discrepancy after meta-research described the ability as "skips the return-damage step... a
one-sided kill," which conflicted with our implementation (`nuGundam017WhenPaired` calls
`resolveUnitBattleDamage`, whose default path deals damage to both sides -- Nu Gundam takes real counter
damage, the ability's own target filter just guarantees that damage isn't lethal). Jake pointed out the
resolution: if the trade truly dealt zero counter damage, Amuro Ray's uncapped HP-recovery pairing
wouldn't be the load-bearing synergy every real deck guide treats it as -- there'd be nothing to heal
from that specific kill. Mutual-damage-but-not-lethal is the mechanically coherent reading, and it's what
our engine already does. The "skips return damage" phrasing was almost certainly an imprecise paraphrase
of the outcome (enemy dies, Nu Gundam doesn't), not a literal rule. No code change needed.
