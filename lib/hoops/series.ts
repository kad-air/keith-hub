// Best-of-seven series odds from two single-game win probabilities.
//
// Pure — no fs, no db, no engine. The matchup screen already knows how often
// team A beats team B on A's floor (one sim) and can ask for the mirror image
// (a second sim, A on B's floor); everything a series needs beyond that is
// arithmetic, and arithmetic should not be re-simulated.
//
// 🔴 What this deliberately does NOT know: playoff basketball. hoops-sim
// measured that a top-heavy team plays ABOVE its regular-season rating in May
// because its rotation shortens (docs/milestones/may-risers.md), and that
// channel is not ported here. So these are "seven regular-season games in the
// NBA's 2-2-1-1-1 home-court pattern", and the UI must say so.

/**
 * Court pattern of an NBA series: whose floor each game is on, in order.
 * `true` = the team holding home-court advantage is at home.
 */
export const SERIES_FORMAT_2_2_1_1_1: readonly boolean[] = [
  true,
  true,
  false,
  false,
  true,
  false,
  true,
];

export const SERIES_WINS_NEEDED = 4;

/**
 * P(the team holding home court wins the series).
 *
 * @param pHome  that team's single-game win probability on ITS OWN floor
 * @param pAway  the same team's single-game win probability on the OTHER floor
 * @param format court pattern, defaulting to the NBA's 2-2-1-1-1
 *
 * A straightforward state walk over (wins, losses): at every state the next
 * game's court is fixed by the format, so the probability of the next win is
 * either `pHome` or `pAway`. Games that would never be played (a sweep) are
 * simply never reached.
 */
export function seriesWinProb(
  pHome: number,
  pAway: number,
  format: readonly boolean[] = SERIES_FORMAT_2_2_1_1_1,
): number {
  const need = SERIES_WINS_NEEDED;
  if (format.length !== 2 * need - 1) {
    throw new Error(`series format must name ${2 * need - 1} games, got ${format.length}`);
  }
  for (const p of [pHome, pAway]) {
    if (!(p >= 0 && p <= 1)) throw new Error(`win probability out of range: ${p}`);
  }
  // prob[w][l] = probability of arriving at w wins, l losses.
  const prob: number[][] = Array.from({ length: need + 1 }, () =>
    new Array<number>(need + 1).fill(0),
  );
  prob[0][0] = 1;
  let won = 0;
  for (let w = 0; w <= need; w++) {
    for (let l = 0; l <= need; l++) {
      const mass = prob[w][l];
      if (mass === 0) continue;
      if (w === need) {
        won += mass;
        continue;
      }
      if (l === need) continue;
      const p = format[w + l] ? pHome : pAway;
      prob[w + 1][l] += mass * p;
      prob[w][l + 1] += mass * (1 - p);
    }
  }
  return won;
}

/** How many games the series is expected to go — for the "sweep or seven?" line. */
export function seriesLengthDistribution(
  pHome: number,
  pAway: number,
  format: readonly boolean[] = SERIES_FORMAT_2_2_1_1_1,
): { games: number; prob: number }[] {
  const need = SERIES_WINS_NEEDED;
  const prob: number[][] = Array.from({ length: need + 1 }, () =>
    new Array<number>(need + 1).fill(0),
  );
  prob[0][0] = 1;
  const byLength = new Map<number, number>();
  for (let w = 0; w <= need; w++) {
    for (let l = 0; l <= need; l++) {
      const mass = prob[w][l];
      if (mass === 0) continue;
      if (w === need || l === need) {
        byLength.set(w + l, (byLength.get(w + l) ?? 0) + mass);
        continue;
      }
      const p = format[w + l] ? pHome : pAway;
      prob[w + 1][l] += mass * p;
      prob[w][l + 1] += mass * (1 - p);
    }
  }
  return [...byLength.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([games, p]) => ({ games, prob: p }));
}
