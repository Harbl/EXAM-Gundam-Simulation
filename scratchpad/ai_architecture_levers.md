# AI architecture levers (tracked options, not yet built)

Running list of real, externally-precedented architectural directions for the AI, distinct from
`ai_known_gaps.md` (bug/wiring fixes to the current architecture) and from in-flight work (the
DeepSets per-unit value net, see the project plan). Add to this list as research surfaces new ideas;
each entry should say what it is, why it might help, what it costs, and what (if anything) has to be
true first for it to actually pay off -- not just "this is a cool technique."

## 1. Policy-guided search (PUCT-style), instead of plain UCT -- OPEN, next candidate after DeepSets

**What:** MCTS today (`src/ai/mcts.js`) is plain UCT: a value net/heuristic scores leaves and rollout
ends, but which branches even get explored is driven only by visit counts + a hand-coded cheap rollout
policy -- no learned model biases search toward promising moves. AlphaZero-style PUCT adds a learned
**policy** (a probability distribution over candidate actions) that biases UCT's exploration term
toward moves the policy thinks are good, so search budget concentrates on plausible lines instead of
spreading close to uniformly.

**Why it might help:** distinct lever from anything tried so far -- every AI change this project has
made (weight tuning, the flat value net, DeepSets) has only ever touched *how well a position is
evaluated*, never *which branches get searched at all*. Real precedent: AlphaZero's own PUCT; AlphaZe**
(Blüml/Czech/Kersting 2023) applying policy-guided search specifically to imperfect-information games;
the Hearthstone CoG2023 paper (Xiao et al.) reporting an end-to-end learned policy beating
value/heuristic-only baselines 84% vs. 67-75% in a real commercial-scale TCG.

**Cost:** same shape as the value net work -- a small hand-rolled network (predict a move-distribution
instead of a scalar), same "no ML framework, cheap enough for thousands of MCTS calls/game" constraint.
Needs its own training loop (policy target = visit-count distribution from completed searches, roughly
AlphaZero's own recipe) and its own z-gated verification before adoption, same discipline as every
other AI change here.

**Sequencing:** reasonable next swing after seeing where the DeepSets value-net training lands --
either as a complement to it (structured/DeepSets value net + a policy head) or independently.

**Source:** 2026-08-06 research session, see `project_gundam_tcg_sim_overview.md` memory for full citations.

## 2. True ISMCTS (information-set tree) -- OPEN, but likely low priority until we have something to exploit

**What:** the Phase 8 determinization experiment (reverted, see the project plan history) was PIMC --
"determinize once per decision, then run ordinary MCTS on that one sampled world." True ISMCTS
(Cowling/Powley/Whitehouse 2012) is structurally different: **one tree whose nodes are information
sets**, sharing statistics across every determinization sampled during search, instead of resampling a
fresh tree per decision. It's the theoretically sounder fix for the "strategy fusion" problem PIMC has.

**Why we haven't pursued it:** the Phase 8 revert's real root cause, per the 2026-08-06 research
session, isn't "determinization is bad" -- it's that nothing in `scoreState`/`getLegalActions` reads
opponent hand *identity* (only counts), so there's no mechanism anywhere in this codebase that could
ever benefit from hiding information (no bluffing, no hand-reading, no adaptive exploitation). Per
Long/Sturtevant/Buro/Furtak (AAAI 2010), determinization-family techniques only pay off when hidden
information creates genuinely divergent optimal lines *and* something can act on that divergence.
**Prerequisite, not just "build it better":** real opponent-modeling/exploitation logic would need to
exist first, or ISMCTS would just be a more complex way to arrive at the same "no benefit" result Phase
8 already measured.

**Cost:** a real `MCTSNode`/`runSearch` structural rewrite (bigger than PIMC was), with real risk of
subtle bugs -- explicitly flagged as bigger scope than the reverted attempt in the original Phase 8 plan.

## 3. Deep CFR family -- RESEARCHED, probably not a fit

**What:** CFR -> CFR+ -> Deep CFR (Brown/Lerer/Gross/Sandholm 2019) -- the poker-AI lineage (Libratus,
Pluribus, ReBeL), replacing tabular regret matching with neural function approximation so it can run
without hand-crafted state abstraction.

**Why probably not:** real TCG-scale precedent exists (Adams 2022, applied CFR variants to Yu-Gi-Oh),
but the surrounding literature is consistent that raw CFR struggles with TCG-scale branching factors
without heavy additional engineering (sampling schemes like Average Strategy Sampling, abstraction) --
Gibson et al. (NeurIPS 2012) built AS specifically because standard MCCFR chokes as per-node action
count grows, which is exactly our situation (many playable cards x many targets x ordering). It's also
a structurally different machinery (regret matching over information sets) than our hand-rolled
MCTS+value-net stack, a much bigger lift than the policy-guided-search option above for a less certain
payoff given this project's stated "small, hand-rolled, no ML framework" constraint.

**Verdict:** known to exist, deliberately not pursuing without a specific reason to revisit.

**Source:** 2026-08-06 research session, see `project_gundam_tcg_sim_overview.md` memory for full citations.

## 4. SPRT-style adaptive significance testing -- SHIPPED 2026-08-06

**What:** our training scripts' verify step runs a FIXED number of games (`VERIFY_GAMES_PER_DECK`),
then checks a fixed |z| >= 2.5 bar. Chess engine testing (Stockfish's Fishtest, used to gate every
real patch) instead uses a Sequential Probability Ratio Test (SPRT): it keeps playing games and
re-checking after each one, stopping as soon as the result is definitively a pass, a fail, or -- if it
runs long enough without resolving -- an inconclusive "too close to call," rather than committing to a
sample size up front and hoping it's big enough.

**Why this is the most immediately relevant finding of this whole research round:** we manually hit
exactly the problem SPRT exists to solve, twice, this session -- `vulnerableUnitCount`'s first verify
(588 games) came back ambiguous, we had to manually decide to rerun bigger (3920 games) to get a real
answer; the DeepSets net's first verify (588 games) did the same thing. Both times, the fix was "a
human decides to spend more compute and reruns," not something the test itself did. SPRT would have
run exactly as many games as needed to resolve each case, no manual intervention, no wasted
under-sampled first attempt.

**Cost:** a real but bounded change to `verify()`'s loop shape in both `bin/train_value_net.js` and
`bin/train_value_net_deepset.js` -- replace "run N games, check z once" with "run games in a loop,
check an SPRT stopping condition after each batch." Doesn't change anything about the AI itself, purely
a testing-methodology upgrade. Worth prioritizing over the other items on this list given it's cheap
relative to its payoff and directly reduces the manual back-and-forth this exact session has needed
twice already.

**Shipped:** new `src/ai/sprt.js` (pure GSPRT math, `p0=0.5`/`p1=0.54`/`alpha=beta=0.05` defaults) plus
`test/sprt.test.js` (boundary + seeded Monte Carlo tests). Both training scripts' `verify()` replaced
with `sprtVerify()` -- plays games one at a time, stops on a definitive `accept`/`reject`, or reports
`inconclusive` if a safety cap (`maxGamesPerDeck`, ~15/deck for the per-round gate, ~30/deck for the
final confirm) is hit without resolving. Smoke-tested against real self-play (null vs. null, a true-p0
case): LLR wandered near 0 for 100 games and correctly reported `inconclusive` rather than a false
verdict, confirming the loop terminates and behaves as designed. Full suite green (958/958). Not yet
exercised on a real multi-hour training run -- next real test is re-running the parked DeepSets
decision (see the project plan) under this gate instead of guessing another fixed N.

## 5. Reanalyze-style training-data reuse -- SHIPPED 2026-08-06 (as a replay window, not literal Reanalyze)

**What:** from MuZero Unplugged's "Reanalyze" -- periodically re-score OLD stored self-play games using
the CURRENT (improved) net/champion to relabel fresher training targets, instead of only ever training
on freshly-collected self-play data and discarding everything from prior rounds.

**Why it might help:** every training round today collects an entirely fresh batch of self-play games
and throws away prior rounds' data once used. If a round's candidate fails to beat the champion (as
just happened twice with DeepSets), that round's 2500 games and ~38k samples are simply gone. Reanalyze
suggests old game *trajectories* are still useful even if the net trained on their original labels
wasn't -- reusing them (re-evaluated by whatever the current champion is) could make each round's
compute go further, decoupled entirely from whether the game's engine is MuZero-style or not.

**Cost:** moderate -- needs stored trajectories (not just final labeled samples) and a re-labeling
pass; a real change to the training script's data pipeline, not a one-line tweak.

**Shipped (adapted):** literal Reanalyze doesn't apply here -- this project's training targets are the
real Monte-Carlo game outcome (who actually won), not a search-derived value estimate, so re-labeling
old trajectories with a new champion wouldn't change anything. Adapted instead as a bounded **replay
window**: both training scripts gained a `replayWindowRounds` CLI arg (default 1 = old behavior); at
>1, each round's self-play data is pooled with the last N rounds' instead of being discarded the
instant a round's candidate isn't adopted. Buffer/windowing logic verified in isolation + smoke-tested
via a real tiny training run; `node --test` unaffected (961/961, pure `bin/` CLI change, no dedicated
test file -- matches this file pair's existing precedent of validating via real runs). Not yet run at
real scale or shown to actually improve outcomes -- a real go/no-go for a future full run.

## 6. League/population-based self-play training -- OPEN, bigger lift, only worth it if single-lineage plateaus

**What:** AlphaStar's "league" (main agents + dedicated "exploiter" agents that only try to find and
punish the main agent's current weaknesses) and the PSRO/P2SRO family (maintain a population of
policies, train each new one as a best-response to a mixture over the whole population via a
game-theoretic solver) both exist to fix a real, named failure mode of naive single-lineage self-play:
"strategy cycling" (a new model reliably beats its immediate predecessor while being weaker than an
earlier ancestor) and "narrow-strategy collapse" (self-play implicitly narrows to whatever's easiest to
improve against the current self, abandoning otherwise-valid strategies). A striking real example:
adversarial researchers found an exploit beating a superhuman self-play-trained Go engine (KataGo) over
97% of the time by targeting a specific blind spot -- and the exploit survived the engine being
adversarially retrained against it.

**Why not now:** our whole current approach is a single evolving lineage (candidate vs. current
champion, adopt or discard, repeat) -- exactly the shape this literature flags as having no defense
against cycling/collapse. But this is a real architectural commitment (maintaining and training a whole
population, not one net), and we have no current evidence our lineage is actually cycling (we've mostly
seen candidates fail to beat champions outright, not oscillate). Worth revisiting if we ever observe
a model that beats its immediate predecessor but loses to an older one -- that specific symptom would
be the trigger to reach for this, not a reason to build it preemptively.

## 7. Skill-tier design: imitation-per-tier (Maia-style) vs. budget-scaling (what we do now) -- NOTED, low near-term feasibility

**What:** our 5 skill tiers (`skillPresets.js`) all scale MCTS search budget up/down against the same
underlying evaluator. Maia Chess instead trains *separate models per rating band* on real human game
logs, so a given tier plays like an actual human at that skill level, not a strong engine with reduced
search -- and reportedly matches real human moves far more often than a turned-down strong engine does.
Directly relevant design lesson either way: how you make an AI weaker changes whether it reads as "a
plausible weaker opponent" or "obviously artificial" (budget-scaling is on the right side of this
already, unlike literal stat-cheating, which is the well-documented bad pattern from commercial game AI).

**Why not now:** Maia's approach needs a large corpus of real human games bucketed by skill level, which
doesn't exist for this game the way Lichess data exists for chess. Noting the idea, not proposing it.

**Source (items 4-7):** 2026-08-06 broader research session (self-play methodology, rating/evaluation
methodology, general game AI design), see `project_gundam_tcg_sim_overview.md` memory for full citations.
