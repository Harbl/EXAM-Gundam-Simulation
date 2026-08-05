const { playGame } = require('./singleGame');

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

/** Plays a best-of-N match, stopping as soon as one side clinches a majority. Draws/timeouts don't
 * score either side but still get replayed (capped at bestOf*4 attempts, against a pathological
 * always-draws matchup) -- ties that hit the cap are broken by a coin flip so the bracket can advance. */
function playMatch(deckA, deckB, bestOf, options = {}) {
  const winsNeeded = Math.ceil(bestOf / 2);
  const maxAttempts = bestOf * 4;
  const games = [];
  let scoreA = 0;
  let scoreB = 0;
  while (scoreA < winsNeeded && scoreB < winsNeeded && games.length < maxAttempts) {
    const seed = Math.floor(Math.random() * 0x100000000);
    const result = playGame(deckA, deckB, { ...options, seed });
    games.push(result);
    if (result.winner === 0) scoreA++;
    else if (result.winner === 1) scoreB++;
  }
  const winnerIdx = scoreA === scoreB ? (Math.random() < 0.5 ? 0 : 1) : scoreA > scoreB ? 0 : 1;
  return { winnerIdx, scoreA, scoreB, games };
}

function publicRef(entrant) {
  return entrant && { id: entrant.id, name: entrant.name };
}

function cloneRounds(rounds) {
  return JSON.parse(JSON.stringify(rounds));
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
    rounds.push(Array.from({ length: count }, () => ({ a: null, b: null, result: null, bye: false })));
    count = Math.floor(count / 2);
  }
  return rounds;
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

  for (let i = 0; i < slots.length; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    const idx = i / 2;
    if (a && !b) rounds[0][idx] = { a: publicRef(a), b: null, result: null, bye: true };
    else if (!a && b) rounds[0][idx] = { a: null, b: publicRef(b), result: null, bye: true };
    else rounds[0][idx] = { a: publicRef(a), b: publicRef(b), result: null, bye: false };
  }
  if (onProgress) onProgress({ phase: 'seeded', rounds: cloneRounds(rounds) });

  let current = slots;
  for (let r = 0; r < rounds.length; r++) {
    const winners = new Array(current.length / 2);
    for (let i = 0; i < current.length; i += 2) {
      const a = current[i];
      const b = current[i + 1];
      const idx = i / 2;
      let winner;
      if (a && !b) {
        winner = a; // bye -- already recorded in the round-0 skeleton fill above
      } else if (!a && b) {
        winner = b;
      } else {
        const result = playMatch(a.deck, b.deck, bestOf, options);
        rounds[r][idx] = { a: publicRef(a), b: publicRef(b), result, bye: false };
        winner = result.winnerIdx === 0 ? a : b;
      }
      winners[idx] = winner;
      if (r + 1 < rounds.length) {
        const nextMatch = rounds[r + 1][Math.floor(idx / 2)];
        if (idx % 2 === 0) nextMatch.a = publicRef(winner);
        else nextMatch.b = publicRef(winner);
      }
      if (onProgress) onProgress({ phase: 'match', round: r, matchIndex: idx, rounds: cloneRounds(rounds) });
    }
    current = winners;
  }
  return { rounds, champion: publicRef(current[0]) };
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

module.exports = { buildBracket, playMatch, runTournament, deckStats };
