const { playGame } = require('./singleGame');

/** Runs many games, yielding to the event loop between each so a host (worker thread) UI stays responsive.
 * `options` is passed straight through to playGame per game -- e.g. { engineA, engineB, mctsConfigA,
 * mctsConfigB } from the skill-slider feature (src/ai/skillPresets.js). */
async function runBatch(deckA, deckB, games, onProgress, options = {}) {
  const totals = {
    games,
    winsA: 0,
    winsB: 0,
    draws: 0,
    timeouts: 0,
    turnsSum: 0,
    mulligansA: 0,
    mulligansB: 0,
    curveA: { turn1: 0, turn2: 0, turn3: 0 },
    curveB: { turn1: 0, turn2: 0, turn3: 0 },
    perGame: [], // per-game {seed, winner, draw, timedOut, turns} -- lets the UI replay any past game on demand
    fullTurns: [], // full-turn count per game, for the length-spread stat (median/min/max, not just average)
    // Win rate split by who went first -- byFirst[0] tallies games Deck A went first, byFirst[1] games
    // Deck B went first -- answers "does going first help *this* deck" per side, not just overall.
    byFirst: { 0: { games: 0, winsA: 0, winsB: 0 }, 1: { games: 0, winsA: 0, winsB: 0 } },
    // Margin of victory: sum (for averaging) of the winning side's own remaining shields at game end.
    marginSumA: 0,
    marginCountA: 0,
    marginSumB: 0,
    marginCountB: 0
  };

  for (let i = 0; i < games; i++) {
    // Each game gets its own random seed regardless of whether options already fixes one, so every
    // game in the batch stays independently reproducible later via src/sim/traceGame.js -- an
    // explicit options.seed would otherwise make every game in the batch identical.
    const seed = Math.floor(Math.random() * 0x100000000);
    const result = playGame(deckA, deckB, { ...options, seed });
    totals.perGame.push({
      seed,
      winner: result.winner,
      draw: result.draw,
      timedOut: result.timedOut,
      turns: result.turns
    });

    if (result.draw) totals.draws++;
    else if (result.timedOut) totals.timeouts++;
    else if (result.winner === 0) totals.winsA++;
    else totals.winsB++;

    // result.turns is state.turnNumber, which increments once per individual player's turn (not once
    // per round) -- ceil(.../2) converts it to a "full turn" count both players would recognize
    // (e.g. Player One's turn 1 + Player Two's turn 1 = 1 full turn, matching normal TCG parlance).
    const fullTurns = Math.ceil(result.turns / 2);
    totals.turnsSum += fullTurns;
    totals.fullTurns.push(fullTurns);
    if (result.mulliganed[0]) totals.mulligansA++;
    if (result.mulliganed[1]) totals.mulligansB++;
    for (const key of ['turn1', 'turn2', 'turn3']) {
      if (result.openingCurve[0][key]) totals.curveA[key]++;
      if (result.openingCurve[1][key]) totals.curveB[key]++;
    }

    const firstBucket = totals.byFirst[result.firstPlayer];
    firstBucket.games++;
    if (result.winner === 0) firstBucket.winsA++;
    else if (result.winner === 1) firstBucket.winsB++;

    if (!result.draw && !result.timedOut) {
      if (result.winner === 0) {
        totals.marginSumA += result.shields[0];
        totals.marginCountA++;
      } else {
        totals.marginSumB += result.shields[1];
        totals.marginCountB++;
      }
    }

    if (onProgress) onProgress({ completed: i + 1, games, live: liveSummary(totals, i + 1) });
    await new Promise((resolve) => setImmediate(resolve));
  }

  return summarize(totals);
}

function median(sortedNumbers) {
  if (sortedNumbers.length === 0) return 0;
  const mid = Math.floor(sortedNumbers.length / 2);
  return sortedNumbers.length % 2 === 0 ? (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2 : sortedNumbers[mid];
}

function rate(count, games) {
  return games === 0 ? 0 : count / games;
}

// Shared by the final summarize() and the live in-progress preview below -- `gamesCount` is the
// games actually completed so far, not the batch's eventual target, so live rates read correctly
// mid-run (3/5 completed, not 3/100 requested).
function perSide(wins, mulligans, curve, marginSum, marginCount, gamesCount, decisive) {
  return {
    wins,
    winRate: rate(wins, gamesCount),
    decisiveWinRate: rate(wins, decisive),
    mulliganRate: rate(mulligans, gamesCount),
    turn1PlayRate: rate(curve.turn1, gamesCount),
    turn2PlayRate: rate(curve.turn2, gamesCount),
    turn3PlayRate: rate(curve.turn3, gamesCount),
    marginOfVictory: marginCount === 0 ? 0 : marginSum / marginCount
  };
}

// Cheap (O(1), no sorting) running snapshot of the same shape the renderer's stats chart already
// reads (`stats.deckA`/`stats.deckB`) -- lets the in-progress bar chart reuse the exact same
// CHART_GROUPS/drawBarChart code the finished results use, just fed partial totals.
function liveSummary(t, completed) {
  const decisive = t.winsA + t.winsB;
  const deckA = perSide(t.winsA, t.mulligansA, t.curveA, t.marginSumA, t.marginCountA, completed, decisive);
  const deckB = perSide(t.winsB, t.mulligansB, t.curveB, t.marginSumB, t.marginCountB, completed, decisive);
  deckA.winRateWhenFirst = rate(t.byFirst[0].winsA, t.byFirst[0].games);
  deckA.winRateWhenSecond = rate(t.byFirst[1].winsA, t.byFirst[1].games);
  deckB.winRateWhenFirst = rate(t.byFirst[1].winsB, t.byFirst[1].games);
  deckB.winRateWhenSecond = rate(t.byFirst[0].winsB, t.byFirst[0].games);
  return { deckA, deckB };
}

function summarize(t) {
  const decisive = t.winsA + t.winsB;
  const deckA = perSide(t.winsA, t.mulligansA, t.curveA, t.marginSumA, t.marginCountA, t.games, decisive);
  const deckB = perSide(t.winsB, t.mulligansB, t.curveB, t.marginSumB, t.marginCountB, t.games, decisive);
  // Deck A/B's win rate specifically when *that side* went first vs. went second (0 = A went first,
  // 1 = B went first) -- computed separately since it needs both byFirst buckets, not just one side's.
  deckA.winRateWhenFirst = rate(t.byFirst[0].winsA, t.byFirst[0].games);
  deckA.winRateWhenSecond = rate(t.byFirst[1].winsA, t.byFirst[1].games);
  deckB.winRateWhenFirst = rate(t.byFirst[1].winsB, t.byFirst[1].games);
  deckB.winRateWhenSecond = rate(t.byFirst[0].winsB, t.byFirst[0].games);

  const sortedTurns = [...t.fullTurns].sort((a, b) => a - b);

  return {
    games: t.games,
    timeouts: t.timeouts,
    draws: t.draws,
    averageTurns: t.games === 0 ? 0 : t.turnsSum / t.games,
    shortestGame: sortedTurns[0] || 0,
    longestGame: sortedTurns[sortedTurns.length - 1] || 0,
    medianGame: median(sortedTurns),
    deckA,
    deckB,
    perGame: t.perGame
  };
}

module.exports = { runBatch };
