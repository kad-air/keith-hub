// Matchup-level derivations: the run_id encoding that makes a result page
// reproducible from its URL alone, and the distribution summary the matchup
// screen renders.
//
// Pure — no fs, no db. Shared by the API routes, the SSR pages and the client.

import type { GameSimResult } from "./engine.ts";
import { spawnRunId } from "./rng.ts";
import type { RatingMode } from "./types.ts";

// ── run_id ───────────────────────────────────────────────────────────────
//
// 🔴 The run_id is SELF-DESCRIBING on purpose: `DEN-OKC-hb-3f2a9c1b0d4e5f6a`
// carries home, away, court and rating mode, so /hoops/game/[runId] can
// reproduce the game from the URL and nothing else. The alternative — a bare
// random id plus a row in hoops_runs — makes a shared link depend on this
// device's database, which is exactly the property "reproducible forever" was
// supposed to buy. hoops_runs stays reserved for sims the user deliberately
// SAVES (a later milestone); it is not load-bearing for a deep link.
//
// The trailing hex is what makes two taps on Sim different games. It is
// derived (rng.spawnRunId) rather than random so the same nonce reproduces
// the same id, and it is part of the RNG key, so changing it redraws
// everything.
//
// What a run_id does NOT pin is the parameter blob. A Mac Mini push can
// replace the fit under an old link, and the same id would then produce a
// different game. That is why every result surface prints param_version and
// data_as_of next to the run_id rather than the run_id alone.

// 🔴 The court code and the mode code sit in FIXED positions ("hb" = home
// court, blend rating), so `n` meaning "neutral" in the first slot and
// "nightly" in the second can never collide. Every code here is permanent: a
// link shared at any point in this site's history has to keep resolving.
const COURT_CODE = { home: "h", neutral: "n" } as const;
const MODE_CODE: Record<RatingMode, string> = {
  results: "r",
  roster: "o",
  blend: "b",
  nightly: "n",
};
const MODE_OF_CODE: Record<string, RatingMode> = {
  r: "results",
  o: "roster",
  b: "blend",
  n: "nightly",
};

export interface RunCoordinates {
  home: string;
  away: string;
  neutralSite: boolean;
  ratingMode: RatingMode;
}

export function encodeRunId(coords: RunCoordinates, nonce: string): string {
  const court = coords.neutralSite ? COURT_CODE.neutral : COURT_CODE.home;
  const flags = `${court}${MODE_CODE[coords.ratingMode]}`;
  const hex = spawnRunId(coords.home, coords.away, flags, nonce);
  return `${coords.home}-${coords.away}-${flags}-${hex}`;
}

/** null (never a throw) for anything that isn't one of ours — the result page
 *  turns that into a 404 rather than a 500. */
export function parseRunId(runId: string): RunCoordinates | null {
  const parts = runId.split("-");
  if (parts.length !== 4) return null;
  const [home, away, flags, hex] = parts;
  if (!/^[A-Z]{2,4}$/.test(home) || !/^[A-Z]{2,4}$/.test(away)) return null;
  if (home === away) return null;
  if (!/^[hn][robn]$/.test(flags)) return null;
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  return {
    home,
    away,
    neutralSite: flags[0] === COURT_CODE.neutral,
    ratingMode: MODE_OF_CODE[flags[1]],
  };
}

// ── Distribution summary ─────────────────────────────────────────────────

export interface Histogram {
  /** Left edge of the first bin. */
  min: number;
  binWidth: number;
  counts: number[];
}

export interface Quantiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface SimSummary {
  runId: string;
  home: string;
  away: string;
  neutralSite: boolean;
  ratingMode: RatingMode;
  nSims: number;

  homeWinProb: number;
  /** Market convention: the home team's spread, so a favourite is negative. */
  homeSpread: number;
  meanMargin: number;
  meanTotal: number;
  meanHomeScore: number;
  meanAwayScore: number;
  /** Monte Carlo standard error on the mean margin — how much of the number
   *  is just replicate count. Rendered, not hidden: it is the difference
   *  between "the model says 5.8" and "the model says about 6". */
  mcStderrMargin: number;
  /** Standard deviation of the margin across replicates. The width of the
   *  cloud, which is the actual point of the histogram. */
  sdMargin: number;
  otPct: number;

  margin: Quantiles;
  total: Quantiles;
  marginHist: Histogram;
}

function quantiles(sorted: Float64Array | number[]): Quantiles {
  const at = (q: number): number => {
    const n = sorted.length;
    if (n === 0) return 0;
    const pos = q * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
  };
  return { p5: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95) };
}

/** Fixed-width histogram over the margin, snapped to whole points. Bin width
 *  scales with the replicate count so a 200-sim run doesn't render as a comb. */
function histogram(values: Float64Array, binWidth: number): Histogram {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { min: 0, binWidth, counts: [] };
  const min = Math.floor(lo / binWidth) * binWidth;
  const nBins = Math.max(1, Math.floor((hi - min) / binWidth) + 1);
  const counts = new Array<number>(nBins).fill(0);
  for (const v of values) {
    const idx = Math.min(nBins - 1, Math.max(0, Math.floor((v - min) / binWidth)));
    counts[idx] += 1;
  }
  return { min, binWidth, counts };
}

export function summarizeSim(
  result: GameSimResult,
  ratingMode: RatingMode,
): SimSummary {
  const n = result.nSims;
  const margin = Array.from(result.margin).sort((a, b) => a - b);
  const total = Array.from(result.total).sort((a, b) => a - b);

  let sumHome = 0;
  let sumAway = 0;
  let ot = 0;
  for (let i = 0; i < n; i++) {
    sumHome += result.finalHomeScore[i];
    sumAway += result.finalAwayScore[i];
    if (result.nOtPeriods[i] > 0) ot += 1;
  }

  let ss = 0;
  for (let i = 0; i < n; i++) ss += (result.margin[i] - result.meanMargin) ** 2;
  const sdMargin = n <= 1 ? 0 : Math.sqrt(ss / (n - 1));

  const binWidth = n >= 1500 ? 2 : n >= 500 ? 3 : 5;

  return {
    runId: result.runId,
    home: result.homeTeam,
    away: result.awayTeam,
    neutralSite: result.neutralSite,
    ratingMode,
    nSims: n,
    homeWinProb: result.homeWinProb,
    homeSpread: -result.meanMargin,
    meanMargin: result.meanMargin,
    meanTotal: result.meanTotal,
    meanHomeScore: sumHome / n,
    meanAwayScore: sumAway / n,
    mcStderrMargin: result.mcStderrMargin,
    sdMargin,
    otPct: (100 * ot) / n,
    margin: quantiles(margin),
    total: quantiles(total),
    marginHist: histogram(result.margin, binWidth),
  };
}
