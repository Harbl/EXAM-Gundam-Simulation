/** Small, fast, seedable PRNG (mulberry32) -- deterministic given the same 32-bit integer seed,
 * so a single game can be exactly reproduced later for the replay viewer (see src/sim/traceGame.js). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { mulberry32 };
