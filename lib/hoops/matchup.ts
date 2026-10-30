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
// carries home, away, court and rating mode, so /hoops/sim/game/[runId] can
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

// ── The favourite's view ─────────────────────────────────────────────────
//
// The matchup screen leads with the FAVOURITE, not the home team. Every
// number the engine produces is from the home side (homeWinProb, a margin of
// home − away, the home spread), and the first version of the screen rendered
// those as-is: the home team got the big headline, the accent colour and the
// right-hand half of the histogram whether it was 62% to win or 38%, so an
// "Orlando at Brooklyn" read as if the page were pushing the Nets at 38%.
//
// `favouriteView` re-expresses the whole summary from the favourite's side,
// in ONE place, so the headline, the win bar, the line, the histogram, its
// end labels and its caption cannot disagree about who is favoured or what a
// sign means:
//   · the favourite is the team whose UNROUNDED win probability exceeds 0.5;
//   · when the two probabilities print the same at the displayed precision
//     (one decimal — 50.0% vs 50.0%) the page falls back to the home team,
//     exactly as it always did, rather than appear to choose between two
//     identical numbers; the same when the probability is exactly 0.5;
//   · every signed margin here is favourite − underdog, so a positive margin
//     is always the favourite winning. The histogram is mirrored (bins
//     reversed, the axis negated) when the favourite is the away team, and the
//     quantiles mirror with it (p25 ↔ −p75, p5 ↔ −p95).
// The home-side fields on SimSummary are untouched; this is a view.

export interface FavouriteView {
  /** Tri of the favoured team (the home team on a coin flip). */
  fav: string;
  dog: string;
  favIsHome: boolean;
  /** True when the favourite could not be told apart at the displayed
   *  precision and the home team was taken instead. */
  coinFlip: boolean;
  favWinProb: number;
  dogWinProb: number;
  /** Market convention from the favourite's side — negative when the mean
   *  margin agrees with the win probability, which it nearly always does. */
  favSpread: number;
  /** favourite − underdog. */
  meanMargin: number;
  margin: Quantiles;
  marginHist: Histogram;
}

/** How win probabilities are printed on the matchup screen; the coin-flip
 *  rule is defined in terms of this so the two can't drift. */
export const WIN_PROB_DIGITS = 1;

export function fmtWinProb(p: number): string {
  return `${(p * 100).toFixed(WIN_PROB_DIGITS)}%`;
}

/** Mirror a histogram about zero: the same games, counted from the other
 *  team's side. Reversing the bins and negating the right edge keeps every
 *  count on the bin that holds the same games. */
export function mirrorHistogram(h: Histogram): Histogram {
  const width = h.counts.length * h.binWidth;
  return { min: -(h.min + width), binWidth: h.binWidth, counts: [...h.counts].reverse() };
}

export function mirrorQuantiles(q: Quantiles): Quantiles {
  return { p5: -q.p95, p25: -q.p75, p50: -q.p50, p75: -q.p25, p95: -q.p5 };
}

export function favouriteView(s: SimSummary): FavouriteView {
  const pHome = s.homeWinProb;
  const pAway = 1 - pHome;
  const coinFlip = fmtWinProb(pHome) === fmtWinProb(pAway);
  const favIsHome = coinFlip || pHome >= 0.5;
  if (favIsHome) {
    return {
      fav: s.home,
      dog: s.away,
      favIsHome: true,
      coinFlip,
      favWinProb: pHome,
      dogWinProb: pAway,
      favSpread: s.homeSpread,
      meanMargin: s.meanMargin,
      margin: s.margin,
      marginHist: s.marginHist,
    };
  }
  return {
    fav: s.away,
    dog: s.home,
    favIsHome: false,
    coinFlip: false,
    favWinProb: pAway,
    dogWinProb: pHome,
    favSpread: -s.homeSpread,
    meanMargin: -s.meanMargin,
    margin: mirrorQuantiles(s.margin),
    marginHist: mirrorHistogram(s.marginHist),
  };
}

/** A favourite-side margin as words: "ORL by 12" / "BKN by 4" / "level".
 *  Every signed figure the screen prints goes through this, so a reader never
 *  has to know which way the sign runs. */
export function marginLabel(margin: number, fav: string, dog: string, digits = 0): string {
  const abs = Math.abs(margin).toFixed(digits);
  if (Number(abs) === 0) return "level";
  return `${margin > 0 ? fav : dog} by ${abs}`;
}

// ── Head to head ─────────────────────────────────────────────────────────
//
// What the market and the scoreboard said the last time these two met. The
// bundle carries the whole season's schedule and closing lines, and the last
// ~200 finals, so a matchup screen can put the sim's number next to a real
// closing line — framed as the sim's read, never an edge (HOOPS_PLAN.md §8:
// the market's typical miss is smaller than ours).

export interface Meeting {
  gameId: string;
  date: string;
  home: string;
  away: string;
  neutral: boolean;
  /** Closing spread from the HOME side (market convention: favourite negative). */
  homeSpread: number | null;
  total: number | null;
  /** Real final, when the game sits inside the results window; else null. */
  homeScore: number | null;
  awayScore: number | null;
}

interface ScheduleLike {
  game_id: string;
  date: string;
  home: string;
  away: string;
  neutral_site: boolean | number;
}
interface LineLike {
  game_id: string;
  home_spread: number | null;
  total: number | null;
}
interface ResultLike {
  game_id: string;
  home_score: number;
  away_score: number;
}

/** Every scheduled game between `a` and `b`, oldest first, joined to its
 *  closing line and (where the window has it) its real final. Pure, so the
 *  build check can drive it over the committed JSON and the server over the
 *  same rows read back out of SQLite. */
export function meetingsBetween(
  schedule: ScheduleLike[],
  lines: LineLike[],
  results: ResultLike[],
  a: string,
  b: string,
): Meeting[] {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  const lineOf = new Map(lines.map((l) => [l.game_id, l]));
  const resultOf = new Map(results.map((r) => [r.game_id, r]));
  return schedule
    .filter((g) => (g.home === A && g.away === B) || (g.home === B && g.away === A))
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.game_id.localeCompare(y.game_id)))
    .map((g) => {
      const l = lineOf.get(g.game_id);
      const r = resultOf.get(g.game_id);
      return {
        gameId: g.game_id,
        date: g.date,
        home: g.home,
        away: g.away,
        neutral: g.neutral_site === true || g.neutral_site === 1,
        homeSpread: l?.home_spread ?? null,
        total: l?.total ?? null,
        homeScore: r?.home_score ?? null,
        awayScore: r?.away_score ?? null,
      };
    });
}
