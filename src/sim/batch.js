const { playGame } = require('./singleGame');

/** Runs many games, yielding to the event loop between each so a host (worker thread) UI stays responsive. */
async function runBatch(deckA, deckB, games, onProgress) {
  const totals = {
    games,
    winsA: 0,
    winsB: 0,
    timeouts: 0,
    turnsSum: 0,
    mulligansA: 0,
    mulligansB: 0,
    curveA: { turn1: 0, turn2: 0, turn3: 0 },
    curveB: { turn1: 0, turn2: 0, turn3: 0 }
  };

  for (let i = 0; i < games; i++) {
    const result = playGame(deckA, deckB);

    if (result.timedOut) totals.timeouts++;
    else if (result.winner === 0) totals.winsA++;
    else totals.winsB++;

    totals.turnsSum += result.turns;
    if (result.mulliganed[0]) totals.mulligansA++;
    if (result.mulliganed[1]) totals.mulligansB++;
    for (const key of ['turn1', 'turn2', 'turn3']) {
      if (result.openingCurve[0][key]) totals.curveA[key]++;
      if (result.openingCurve[1][key]) totals.curveB[key]++;
    }

    if (onProgress) onProgress({ completed: i + 1, games });
    await new Promise((resolve) => setImmediate(resolve));
  }

  return summarize(totals);
}

function rate(count, games) {
  return games === 0 ? 0 : count / games;
}

function summarize(t) {
  const perSide = (wins, mulligans, curve) => ({
    wins,
    winRate: rate(wins, t.games),
    mulliganRate: rate(mulligans, t.games),
    turn1PlayRate: rate(curve.turn1, t.games),
    turn2PlayRate: rate(curve.turn2, t.games),
    turn3PlayRate: rate(curve.turn3, t.games)
  });

  return {
    games: t.games,
    timeouts: t.timeouts,
    averageTurns: t.games === 0 ? 0 : t.turnsSum / t.games,
    deckA: perSide(t.winsA, t.mulligansA, t.curveA),
    deckB: perSide(t.winsB, t.mulligansB, t.curveB)
  };
}

module.exports = { runBatch };
