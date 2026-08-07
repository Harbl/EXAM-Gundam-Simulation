const { playGame } = require('./singleGame');
const { applyArchetypeHandicap } = require('../ai/archetypeHandicaps');

/** Randomly seeds entrants ({id, name, deck}) into a single-elimination bracket, padding to the next
 * power of 2 with byes (null slots) when the count isn't one already. */
function buildBracket(entrants, rng = Math.random) {
  const shuffled = [...entrants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const size = 2 ** Math.ceil(Math.log2(shuffled.length));
  return [...shuffled, ...Array(size - shuffled.length).fill(null)];
}

/** Per-entrant (not per-tournament) archetype handicap: `options.engineA/B` etc. are the tournament's
 * one shared skill choice, but a known AI-advantaged archetype (src/ai/archetypeHandicaps.js) needs
 * to be downgraded specifically whenever IT is playing, regardless of which bracket slot/opponent it's
 * facing -- so this is resolved fresh per match from each side's actual deck, not once for the whole
 * tournament like `options` itself is. `options.bypassHandicaps` (the "Newtype Awakening" opt-out,
 * electron/renderer's Simulate/Tournament screens) skips this entirely -- an explicit user choice to
 * see full-strength AI even for a known-lopsided archetype. */
function withArchetypeHandicaps(deckA, deckB, options) {
  if (options.bypassHandicaps) return options;
  const a = applyArchetypeHandicap(deckA, { engine: options.engineA, mctsConfig: options.mctsConfigA, valueModel: options.valueModelA });
  const b = applyArchetypeHandicap(deckB, { engine: options.engineB, mctsConfig: options.mctsConfigB, valueModel: options.valueModelB });
  return { ...options, engineA: a.engine, mctsConfigA: a.mctsConfig, valueModelA: a.valueModel, engineB: b.engine, mctsConfigB: b.mctsConfig, valueModelB: b.valueModel };
}

/** Plays a best-of-N match, stopping as soon as one side clinches a majority. Draws/timeouts don't
 * score either side but still get replayed (capped at bestOf*4 attempts, against a pathological
 * always-draws matchup) -- ties that hit the cap are broken by a coin flip so the bracket can advance. */
function playMatch(deckA, deckB, bestOf, options = {}) {
  const winsNeeded = Math.ceil(bestOf / 2);
  const maxAttempts = bestOf * 4;
  const matchOptions = withArchetypeHandicaps(deckA, deckB, options);
  const games = [];
  let scoreA = 0;
  let scoreB = 0;
  while (scoreA < winsNeeded && scoreB < winsNeeded && games.length < maxAttempts) {
    const seed = Math.floor(Math.random() * 0x100000000);
    const result = playGame(deckA, deckB, { ...matchOptions, seed });
    games.push(result);
    if (result.winner === 0) scoreA++;
    else if (result.winner === 1) scoreB++;
  }
  const winnerIdx = scoreA === scoreB ? (Math.random() < 0.5 ? 0 : 1) : scoreA > scoreB ? 0 : 1;
  // Carries the actually-resolved (post-handicap) per-side engine/config forward onto the match result,
  // not just the tournament-wide nominal preset -- so a saved tournament's replay can reproduce a
  // handicapped match under the engine it was REALLY played with, not the un-adjusted one. See
  // withArchetypeHandicaps above; electron/renderer/index.html's buildMatchGameRows is the consumer.
  return {
    winnerIdx,
    scoreA,
    scoreB,
    games,
    engineA: matchOptions.engineA,
    engineB: matchOptions.engineB,
    mctsConfigA: matchOptions.mctsConfigA,
    mctsConfigB: matchOptions.mctsConfigB,
    valueModelA: matchOptions.valueModelA,
    valueModelB: matchOptions.valueModelB
  };
}

function publicRef(entrant) {
  return entrant && { id: entrant.id, name: entrant.name };
}

function cloneRounds(rounds) {
  return JSON.parse(JSON.stringify(rounds));
}

function emptySlotRound(count) {
  return Array.from({ length: count }, () => ({ a: null, b: null, result: null, bye: false }));
}

// Empty placeholder rounds sized to match a `entrantCount`-entrant bracket (round 0 has
// entrantCount/2 matches, each later round half the one before, down to 1 final) -- lets the UI paint
// the whole bracket's shape (including "TBD" slots for rounds that haven't been paired yet) as soon as
// seeding happens, instead of only being able to draw one round at a time as it's reached.
function bracketSkeleton(entrantCount) {
  const roundCount = Math.ceil(Math.log2(entrantCount));
  const rounds = [];
  let count = 2 ** (roundCount - 1);
  while (count >= 1) {
    rounds.push(emptySlotRound(count));
    count = Math.floor(count / 2);
  }
  return rounds;
}

/** Same pairing/bye logic as playSlotRound below, but never actually plays a match -- used only to
 * preview a round's real pairings (e.g. round 0's, before any games have run) for the immediate
 * 'seeded' progress event, without paying for or discarding a real game's result. */
function pairSlotRound(slots) {
  const matches = [];
  for (let i = 0; i < slots.length; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    if (a && !b) matches.push({ a: publicRef(a), b: null, result: null, bye: true });
    else if (!a && b) matches.push({ a: null, b: publicRef(b), result: null, bye: true });
    else if (!a && !b) matches.push({ a: null, b: null, result: null, bye: true });
    else matches.push({ a: publicRef(a), b: publicRef(b), result: null, bye: false });
  }
  return matches;
}

/** Plays one round of paired slots. Each slot is an entrant or `null` -- a bye (buildBracket pads a
 * non-power-of-2 field with nulls) or, in the losers bracket, a genuinely empty spot with nobody left
 * to drop into it. A match is only actually played when both sides are present; otherwise whichever
 * side *is* present auto-advances with no game (and if neither is, the slot stays empty and that
 * emptiness propagates forward the same way -- this is what used to crash `runTournament` for any
 * entrant count needing 2+ byes, e.g. 5 or 6, before both codepaths were unified onto this one
 * primitive). Returns `{ winners, losers, matches }`, all positional/same length as slots.length/2:
 * `losers` has `null` wherever there was no real match (keeps a losers-bracket drop-in round's pairing
 * aligned even when a bye is involved), `matches` is the [{a,b,result,bye}] round data for the UI. */
function playSlotRound(slots, bestOf, options) {
  const winners = [];
  const losers = [];
  const matches = [];
  for (let i = 0; i < slots.length; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    if (a && !b) {
      winners.push(a);
      losers.push(null);
      matches.push({ a: publicRef(a), b: null, result: null, bye: true });
    } else if (!a && b) {
      winners.push(b);
      losers.push(null);
      matches.push({ a: null, b: publicRef(b), result: null, bye: true });
    } else if (!a && !b) {
      winners.push(null);
      losers.push(null);
      matches.push({ a: null, b: null, result: null, bye: true });
    } else {
      const result = playMatch(a.deck, b.deck, bestOf, options);
      const winner = result.winnerIdx === 0 ? a : b;
      const loser = result.winnerIdx === 0 ? b : a;
      winners.push(winner);
      losers.push(loser);
      matches.push({ a: publicRef(a), b: publicRef(b), result, bye: false });
    }
  }
  return { winners, losers, matches };
}

function interleave(a, b) {
  const out = [];
  for (let i = 0; i < a.length; i++) out.push(a[i], b[i]);
  return out;
}

// Losers-bracket round sizes for a winners bracket of `k` rounds (k = log2(bracket size)), derived
// from the standard double-elimination shape: a "consolidation" round (losers-bracket survivors play
// each other) alternating with a "drop-in" round (survivors play that round's fresh winners-bracket
// losers), starting at size/4 and halving each pair of rounds down to 1 (the losers final, where the
// winners-bracket final's loser drops in). k=1 (a 2-entrant tournament) is a degenerate case -- the
// sole winners-bracket loser has nobody to play in the losers bracket at all, so they just sit in one
// placeholder "round" until the Grand Final.
function losersRoundSizes(k) {
  if (k <= 1) return [1];
  const sizes = [];
  for (let p = k - 2; p >= 0; p--) {
    sizes.push(2 ** p, 2 ** p);
  }
  return sizes;
}

/** Runs a full single-elimination bracket. `entrants` is [{id, name, deck}] (deck objects never leave
 * this function -- rounds/matches only ever expose the {id, name} pair). `onProgress` fires once
 * immediately after seeding ({ phase: 'seeded', rounds }) and once per resolved bracket slot, bye or
 * real match ({ phase: 'match', round, matchIndex, rounds }) -- each call's `rounds` is a full snapshot
 * (byes/results filled in so far, later rounds' `a`/`b` filled in as soon as their feeder matches
 * resolve), so a live UI can redraw the whole bracket and fade out newly-eliminated entrants as it
 * goes. Returns { rounds, champion }, where the final `rounds` is [[{a, b, result, bye}]] in play order. */
function runTournament(entrants, bestOf, onProgress, options = {}) {
  const slots = buildBracket(entrants);
  const rounds = bracketSkeleton(entrants.length);

  rounds[0] = pairSlotRound(slots);
  if (onProgress) onProgress({ phase: 'seeded', rounds: cloneRounds(rounds) });

  let current = slots;
  for (let r = 0; r < rounds.length; r++) {
    const { winners, matches } = playSlotRound(current, bestOf, options);
    for (let idx = 0; idx < matches.length; idx++) {
      rounds[r][idx] = matches[idx];
      const winner = winners[idx];
      if (r + 1 < rounds.length) {
        const nextMatch = rounds[r + 1][Math.floor(idx / 2)];
        if (idx % 2 === 0) nextMatch.a = publicRef(winner);
        else nextMatch.b = publicRef(winner);
      }
      if (onProgress) onProgress({ phase: 'match', round: r, matchIndex: idx, rounds: cloneRounds(rounds) });
    }
    current = winners;
  }
  return { format: 'single', rounds, champion: publicRef(current[0]) };
}

/** Runs a full double-elimination bracket: entrants only need to lose twice to be out. A winners
 * bracket (WB) runs single-elimination-style; each round's losers drop into a losers bracket (LB)
 * that alternates "survivors play each other" (consolidation) rounds with "survivors play that
 * round's fresh WB drop-ins" rounds, per losersRoundSizes' shape. The WB champion (0 losses) then
 * faces the LB champion (1 loss) in a Grand Final; if the LB champion wins that, both are now tied at
 * 1 loss, so a second decider match (a "bracket reset") is played to crown the champion. Same
 * `onProgress`/return shape convention as runTournament, just with three bracket sections
 * (`winners`/`losers`/`grandFinal`, the last 1 or 2 single-match "rounds") instead of one. */
function runDoubleElimTournament(entrants, bestOf, onProgress, options = {}) {
  const slots = buildBracket(entrants);
  const size = slots.length;
  const k = Math.log2(size);

  const winners = [];
  let wCount = size / 2;
  while (wCount >= 1) {
    winners.push(emptySlotRound(wCount));
    wCount = Math.floor(wCount / 2);
  }
  const losers = losersRoundSizes(k).map(emptySlotRound);
  const grandFinal = [emptySlotRound(1)];

  winners[0] = pairSlotRound(slots);
  const snapshot = () => ({ winners: cloneRounds(winners), losers: cloneRounds(losers), grandFinal: cloneRounds(grandFinal) });
  if (onProgress) onProgress({ phase: 'seeded', format: 'double', ...snapshot() });

  let wbCurrent = slots;
  let lbSurvivors = null;
  let lbRoundCursor = 0;

  for (let r = 0; r < winners.length; r++) {
    const wb = playSlotRound(wbCurrent, bestOf, options);
    for (let idx = 0; idx < wb.matches.length; idx++) {
      winners[r][idx] = wb.matches[idx];
      if (r + 1 < winners.length) {
        const next = winners[r + 1][Math.floor(idx / 2)];
        if (idx % 2 === 0) next.a = publicRef(wb.winners[idx]);
        else next.b = publicRef(wb.winners[idx]);
      }
      if (onProgress) onProgress({ phase: 'match', bracket: 'winners', round: r, matchIndex: idx, ...snapshot() });
    }

    if (r === 0) {
      if (wb.losers.length === 1) {
        // 2-entrant tournament: the sole WB loser has nobody to play in the LB, they just wait.
        lbSurvivors = wb.losers;
        losers[0] = [wb.losers[0] ? { a: publicRef(wb.losers[0]), b: null, result: null, bye: true } : { a: null, b: null, result: null, bye: true }];
      } else {
        const cons = playSlotRound(wb.losers, bestOf, options);
        losers[lbRoundCursor] = cons.matches;
        lbSurvivors = cons.winners;
      }
      lbRoundCursor++;
    } else {
      const dropin = playSlotRound(interleave(lbSurvivors, wb.losers), bestOf, options);
      losers[lbRoundCursor] = dropin.matches;
      lbRoundCursor++;
      if (r < winners.length - 1) {
        const cons = playSlotRound(dropin.winners, bestOf, options);
        losers[lbRoundCursor] = cons.matches;
        lbSurvivors = cons.winners;
        lbRoundCursor++;
      } else {
        lbSurvivors = dropin.winners; // that drop-in round *was* the losers final
      }
    }
    if (onProgress) onProgress({ phase: 'match', bracket: 'losers', round: lbRoundCursor - 1, ...snapshot() });

    wbCurrent = wb.winners;
  }

  const wbChampion = wbCurrent[0];
  const lbChampion = lbSurvivors[0];

  const gf1 = playMatch(wbChampion.deck, lbChampion.deck, bestOf, options);
  grandFinal[0][0] = { a: publicRef(wbChampion), b: publicRef(lbChampion), result: gf1, bye: false };
  if (onProgress) onProgress({ phase: 'match', bracket: 'grandFinal', round: 0, ...snapshot() });

  let champion = gf1.winnerIdx === 0 ? wbChampion : lbChampion;
  if (champion === lbChampion) {
    // The WB entrant just took their first loss -- tied 1-1, so a decider match crowns the champion.
    grandFinal.push(emptySlotRound(1));
    const gf2 = playMatch(wbChampion.deck, lbChampion.deck, bestOf, options);
    grandFinal[1][0] = { a: publicRef(wbChampion), b: publicRef(lbChampion), result: gf2, bye: false };
    champion = gf2.winnerIdx === 0 ? wbChampion : lbChampion;
    if (onProgress) onProgress({ phase: 'match', bracket: 'grandFinal', round: 1, ...snapshot() });
  }

  return { format: 'double', winners, losers, grandFinal, champion: publicRef(champion) };
}

/** Aggregates one entrant's own record across every match they actually played (byes don't add
 * games). `eliminatedRound` is the round index they lost in, or null if they won every match they
 * played (i.e. they're still in, or the champion). */
function deckStats(entrantId, rounds) {
  let matchesPlayed = 0;
  let matchesWon = 0;
  let gamesPlayed = 0;
  let gamesWon = 0;
  let mulligans = 0;
  let turnsSum = 0;
  let eliminatedRound = null;

  rounds.forEach((round, roundIdx) => {
    for (const match of round) {
      if (!match.result) continue;
      const isA = match.a && match.a.id === entrantId;
      const isB = match.b && match.b.id === entrantId;
      if (!isA && !isB) continue;
      const side = isA ? 0 : 1;
      matchesPlayed++;
      if (match.result.winnerIdx === side) matchesWon++;
      else eliminatedRound = roundIdx;
      for (const game of match.result.games) {
        gamesPlayed++;
        turnsSum += Math.ceil(game.turns / 2);
        if (!game.draw && !game.timedOut && game.winner === side) gamesWon++;
        if (game.mulliganed[side]) mulligans++;
      }
    }
  });

  return {
    matchesPlayed,
    matchesWon,
    gamesPlayed,
    gamesWon,
    winRate: gamesPlayed === 0 ? 0 : gamesWon / gamesPlayed,
    mulliganRate: gamesPlayed === 0 ? 0 : mulligans / gamesPlayed,
    avgTurns: gamesPlayed === 0 ? 0 : turnsSum / gamesPlayed,
    eliminatedRound
  };
}

module.exports = { buildBracket, playMatch, runTournament, runDoubleElimTournament, deckStats, withArchetypeHandicaps };
