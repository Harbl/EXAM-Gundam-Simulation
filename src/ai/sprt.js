// Sequential Probability Ratio Test (Fishtest/Stockfish-style): a stopping rule for self-play
// verification that plays games one at a time and stops as soon as the evidence is a definitive
// accept, reject, or (only if a caller-imposed game cap is hit first) inconclusive -- instead of
// committing to a fixed sample size up front and hoping it's big enough. Framed directly in win-rate
// space (not Elo) to match this codebase's existing zScore/win-rate convention.
//
// H0 (p0): candidate is no better than champion. H1 (p1): candidate wins at a rate worth adopting.
// alpha/beta are the false-accept/false-reject rates SPRT is allowed at those two hypotheses.
const DEFAULT_SPRT = { p0: 0.5, p1: 0.54, alpha: 0.05, beta: 0.05 };

function sprtBounds({ alpha, beta }) {
  return { upper: Math.log((1 - beta) / alpha), lower: Math.log(beta / (1 - alpha)) };
}

function llrIncrement(candidateWon, { p0, p1 }) {
  return candidateWon ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
}

function sprtVerdict(llr, bounds) {
  if (llr >= bounds.upper) return 'accept';
  if (llr <= bounds.lower) return 'reject';
  return null; // keep playing
}

module.exports = { DEFAULT_SPRT, sprtBounds, llrIncrement, sprtVerdict };
