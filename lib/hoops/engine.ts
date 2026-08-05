// Port of hoops-sim's `hoops.sim.simulate_game` — the clock-driven possession
// engine.
//
// 🔴 SECOND IMPLEMENTATION WARNING. Everything here exists in Python too, and
// two implementations of one thing silently disagreeing is this project
// family's most-repeated bug. The shared fixture (hoops-data/hoops_fixture.json,
// asserted by scripts/check-hoops-fixture.ts here and by `hoops verify` there)
// is the only thing that makes this trustworthy. Re-run it after ANY edit,
// including ones that "obviously can't change a number".
//
// Structural differences from the Python, both deliberate:
//
//   • Python vectorises across replicates with numpy; this loops over
//     replicates in plain JS. Same arithmetic, same order, same draws — the
//     RNG hands back one value per replicate per coordinate either way.
//   • `LineupPlan` (the L3 per-slot on-court delta) is NOT ported. The
//     committed export carries no lineup plan, so there is nothing to feed it;
//     the Python path with `lineups=None` is bit-identical to an all-zero
//     plan, and that is the path reproduced here. Porting it is a later
//     milestone's job, not a silent approximation in this one.
//
// Mechanics that are easy to get backwards, kept in the same order as the
// Python's own docstring:
//
//   • HCA is a full mean-margin effect, so it is HALVED onto the home side and
//     halved off the away side. Adding it whole to both doubles it.
//   • Only period 1 gets a fresh coinflip and a synthetic OffDeadball start.
//     Every later period boundary carries the current possession across
//     unchanged: if a drawn duration would run past the clock, nothing
//     happened yet — the play just continues after the whistle, and it isn't
//     counted until it resolves.
//   • Margin feedback applies OUTSIDE the end-game window only; inside it the
//     end-game tables already condition on margin.
//   • The duration table axis is NOT the outcome table axis. Non-endgame rows
//     are (start_type × outcome_class) using the start type from BEFORE the
//     transition update; end-game rows are keyed by cell alone.

import { stream } from "./rng.ts";
import type { DecodedParams, Matrix } from "./params.ts";

// ── Constants, mirrored from hoops.params ────────────────────────────────
export const START_TYPES = [
  "OffMadeShot",
  "OffMissedShot",
  "OffTimeout",
  "OffLiveBallTurnover",
  "OffDeadball",
] as const;
const N_START_TYPES = 5;
const N_OUTCOME_CLASSES = 4;
const N_MARGIN_BUCKETS = 7;
const N_REGULATION_PERIODS = 4;
const OPENING_START_TYPE_IDX = 4; // START_TYPE_INDEX["OffDeadball"]

// Safety valves. Never silently truncate a game to hit these — tripping one
// means the duration/theta fit is pathological and must be investigated, not
// capped away (capping would bias the OT-rate and pace targets).
const MAX_POSSESSIONS_PER_PERIOD = 200;
const MAX_PERIODS = 20;

// ── Bucket helpers (hoops.params) ────────────────────────────────────────

/** Seconds remaining in the period → time bucket. Only meaningful inside the
 *  end-game window; the caller gates that. */
export function timeBucketIndex(s: number): number {
  if (s < 12) return 0;
  if (s < 24) return 1;
  if (s < 60) return 2;
  if (s < 120) return 3;
  if (s < 180) return 4;
  return 5;
}

/** The POSSESSING team's margin (positive = leading) → end-game bucket. */
export function marginBucketIndex(m: number): number {
  if (m <= -9) return 0;
  if (m <= -4) return 1;
  if (m <= -1) return 2;
  if (m === 0) return 3;
  if (m <= 3) return 4;
  if (m <= 8) return 5;
  return 6;
}

/** The offense's margin outside the end-game window → wider feedback bucket. */
export function gameMarginBucketIndex(m: number): number {
  if (m <= -20) return 0;
  if (m <= -10) return 1;
  if (m <= -1) return 2;
  if (m === 0) return 3;
  if (m <= 9) return 4;
  if (m <= 19) return 5;
  return 6;
}

export const endgameCellIndex = (t: number, m: number): number => t * N_MARGIN_BUCKETS + m;
export const endgameTableIndex = (cell: number): number => N_START_TYPES + cell;
export const durationRowStart = (startIdx: number, outcomeIdx: number): number =>
  startIdx * N_OUTCOME_CLASSES + outcomeIdx;
export const durationRowEndgame = (cell: number): number =>
  N_START_TYPES * N_OUTCOME_CLASSES + cell;

// ── Numeric helpers ──────────────────────────────────────────────────────

/** numpy's `searchsorted(a, v)` with side="left": first i where a[i] >= v. */
function searchsortedLeft(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Linear interpolation of theta along the shared PPP grid, for one table row. */
function gridInterp(
  gridPpp: Float64Array,
  thetaGrid: Matrix,
  tableIdx: number,
  targetPpp: number,
): number {
  const g = gridPpp.length;
  const idxHi = clamp(searchsortedLeft(gridPpp, targetPpp), 1, g - 1);
  const idxLo = idxHi - 1;
  const xLo = gridPpp[idxLo];
  const xHi = gridPpp[idxHi];
  const frac = (targetPpp - xLo) / (xHi - xLo);
  const base = tableIdx * thetaGrid.cols;
  const tLo = thetaGrid.data[base + idxLo];
  const tHi = thetaGrid.data[base + idxHi];
  return tLo + frac * (tHi - tLo);
}

/**
 * Exponentially tilted categorical draw. Mirrors `tilt_cumprobs` + the
 * argmax pick: weight each category by exp(theta * points), renormalise,
 * accumulate, and take the first index whose cumulative probability reaches
 * u. The last column is forced to exactly 1.0 on the Python side to guard
 * against a u in the final few ulps — reproduced here by returning K-1 if the
 * scan falls through.
 */
function tiltedCategory(
  baseProbs: Matrix,
  points: Float64Array,
  tableIdx: number,
  theta: number,
  u: number,
  scratch: Float64Array,
): number {
  const K = baseProbs.cols;
  const base = tableIdx * K;
  let total = 0;
  for (let k = 0; k < K; k++) {
    const w = baseProbs.data[base + k] * Math.exp(theta * points[k]);
    scratch[k] = w;
    total += w;
  }
  let cum = 0;
  for (let k = 0; k < K - 1; k++) {
    cum += scratch[k] / total;
    if (cum >= u) return k;
  }
  return K - 1;
}

/** Piecewise-linear inverse CDF over the duration histogram, one replicate. */
function inverseCdfDuration(
  binEdges: Float64Array,
  cumprobs: Matrix,
  row: number,
  u: number,
): number {
  const nBins = binEdges.length - 1;
  const base = row * cumprobs.cols;
  // ge.argmax: first column at or above u; 0 if none reaches it.
  let idxHi = 0;
  for (let j = 0; j < cumprobs.cols; j++) {
    if (cumprobs.data[base + j] >= u) {
      idxHi = j;
      break;
    }
  }
  idxHi = clamp(idxHi, 1, nBins);
  const idxLo = idxHi - 1;
  const cumLo = cumprobs.data[base + idxLo];
  const cumHi = cumprobs.data[base + idxHi];
  const frac = (u - cumLo) / Math.max(cumHi - cumLo, 1e-12);
  return binEdges[idxLo] + frac * (binEdges[idxHi] - binEdges[idxLo]);
}

/** First index whose cumulative probability reaches u (numpy argmax on `>=`). */
function cumPick(cum: Matrix, row: number, u: number): number {
  const base = row * cum.cols;
  for (let j = 0; j < cum.cols; j++) {
    if (cum.data[base + j] >= u) return j;
  }
  return 0; // argmax of an all-false row is 0, matching numpy
}

// ── Public API ───────────────────────────────────────────────────────────

export interface SimulateGameInput {
  params: DecodedParams;
  runId: string;
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeOff: number;
  homeDef: number;
  awayOff: number;
  awayDef: number;
  hcaPts: number;
  nSims: number;
  neutralSite?: boolean;
}

export interface GameSimResult {
  runId: string;
  paramVersion: string;
  dataAsOf: string;
  nSims: number;
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  neutralSite: boolean;
  homeOff: number;
  homeDef: number;
  awayOff: number;
  awayDef: number;
  hcaPts: number;

  finalHomeScore: Float64Array;
  finalAwayScore: Float64Array;
  possCountHome: Float64Array;
  possCountAway: Float64Array;
  nOtPeriods: Float64Array;
  paceLatent: Float64Array;
  efficiencyLatent: Float64Array;
  finalHomeScoreH1: Float64Array;
  finalAwayScoreH1: Float64Array;
  finalHomeScoreReg: Float64Array;
  finalAwayScoreReg: Float64Array;

  margin: Float64Array;
  total: Float64Array;
  meanMargin: number;
  meanTotal: number;
  /** Monte Carlo standard error on the mean margin (ddof=1). */
  mcStderrMargin: number;
  homeWinProb: number;
}

export function simulateGame(input: SimulateGameInput): GameSimResult {
  const {
    params,
    runId,
    gameId,
    homeTeam,
    awayTeam,
    homeOff,
    homeDef,
    awayOff,
    awayDef,
    hcaPts,
    nSims: n,
    neutralSite = false,
  } = input;

  const avgPoss = params.avgPossPerTeamGame;
  const hcaEff = neutralSite ? 0.0 : hcaPts;

  // Game-level latents, drawn once and shared by every possession this game.
  const paceZ = stream(runId, "pace", gameId).standardNormal(n);
  const paceLatent = new Float64Array(n);
  for (let i = 0; i < n; i++) paceLatent[i] = Math.exp(params.paceSigma * paceZ[i]);
  const effZ = stream(runId, "efficiency", gameId).standardNormal(n);
  const efficiencyLatent = new Float64Array(n);
  for (let i = 0; i < n; i++) efficiencyLatent[i] = effZ[i] * params.efficiencySigma;

  // Fixed per-game PPP targets for each team's OWN offense. HCA halved per side.
  const deltaHomeOff = (homeOff + awayDef) / avgPoss + hcaEff / 2.0 / avgPoss;
  const deltaAwayOff = (awayOff + homeDef) / avgPoss - hcaEff / 2.0 / avgPoss;

  const scoreHome = new Float64Array(n);
  const scoreAway = new Float64Array(n);
  const possCountHome = new Float64Array(n);
  const possCountAway = new Float64Array(n);
  const nOtPeriods = new Float64Array(n);
  const finished = new Uint8Array(n);

  const u0 = stream(runId, "opening_tip", gameId).random(n);
  const possessing = new Int8Array(n); // 0 = home has the ball, 1 = away
  for (let i = 0; i < n; i++) possessing[i] = u0[i] >= 0.5 ? 1 : 0;
  const curStartType = new Int32Array(n).fill(OPENING_START_TYPE_IDX);

  // A possession whose drawn duration outruns the period clock RESUMES next
  // period needing only the time it still had left — it is not redrawn. Losing
  // this undercounts pace by a few possessions per team-game.
  const pendingDuration = new Float64Array(n);
  const hasPending = new Uint8Array(n);

  let homeScoreH1: Float64Array | null = null;
  let awayScoreH1: Float64Array | null = null;
  let homeScoreReg: Float64Array | null = null;
  let awayScoreReg: Float64Array | null = null;

  const clock = new Float64Array(n);
  const activePeriod = new Uint8Array(n);
  const scratch = new Float64Array(params.nCategories);

  let possessionCounter = 0;
  let period = 1;

  for (;;) {
    if (period > MAX_PERIODS) {
      throw new Error(
        `game ${gameId}: exceeded MAX_PERIODS=${MAX_PERIODS} without every replicate finishing ` +
          `— investigate the OT-tie mechanism rather than raising this cap`,
      );
    }

    let anyActive = false;
    for (let i = 0; i < n; i++) {
      activePeriod[i] = finished[i] ? 0 : 1;
      if (activePeriod[i]) anyActive = true;
    }
    if (!anyActive) break;

    const periodLen =
      period <= N_REGULATION_PERIODS
        ? params.regulationPeriodSeconds
        : params.otPeriodSeconds;
    for (let i = 0; i < n; i++) clock[i] = activePeriod[i] ? periodLen : 0.0;

    let brokeOut = false;
    for (let iter = 0; iter < MAX_POSSESSIONS_PER_PERIOD; iter++) {
      let any = false;
      for (let i = 0; i < n; i++) {
        if (activePeriod[i] && clock[i] > 0) {
          any = true;
          break;
        }
      }
      if (!any) {
        brokeOut = true;
        break;
      }

      possessionCounter += 1;
      // One stream per draw site per possession — n values, replicate i gets
      // element i. This keying is what makes CRN work.
      const uOutcome = stream(runId, "outcome", gameId, period, possessionCounter).random(n);
      const uDur = stream(runId, "duration", gameId, period, possessionCounter).random(n);
      const uTrans = stream(runId, "transition", gameId, period, possessionCounter).random(n);

      for (let i = 0; i < n; i++) {
        const active = activePeriod[i] === 1 && clock[i] > 0;

        const isHomeOff = possessing[i] === 0;
        const marginForOffense = isHomeOff
          ? scoreHome[i] - scoreAway[i]
          : scoreAway[i] - scoreHome[i];
        const inEndgame =
          period > N_REGULATION_PERIODS ||
          (period === N_REGULATION_PERIODS && clock[i] <= params.endgameWindowSeconds);

        const cell = endgameCellIndex(
          timeBucketIndex(clock[i]),
          marginBucketIndex(marginForOffense),
        );
        const tableIdx = inEndgame ? endgameTableIndex(cell) : curStartType[i];

        const teamDelta = isHomeOff ? deltaHomeOff : deltaAwayOff;
        const marginFeedback = inEndgame
          ? 0.0
          : params.marginFeedbackPpp[gameMarginBucketIndex(marginForOffense)];
        let targetPpp =
          params.baseMeanPpp[tableIdx] + teamDelta + efficiencyLatent[i] + marginFeedback;
        targetPpp = clamp(targetPpp, params.gridPpp[0], params.gridPpp[params.gridPpp.length - 1]);

        const theta = gridInterp(params.gridPpp, params.thetaGrid, tableIdx, targetPpp);
        const catIdx = tiltedCategory(
          params.baseProbs,
          params.points,
          tableIdx,
          theta,
          uOutcome[i],
          scratch,
        );
        const pts = params.points[catIdx];
        const ocIdx = params.outcomeClassOfCategory[catIdx];

        // Outcome-conditioned duration row. Uses the start type from BEFORE
        // the transition update below — that ordering is load-bearing.
        const durationRow = inEndgame
          ? durationRowEndgame(cell)
          : durationRowStart(curStartType[i], ocIdx);

        const rawDuration = inverseCdfDuration(
          params.durationBinEdges,
          params.durationCumprobs,
          durationRow,
          uDur[i],
        );
        // Dispersion shrink: a deterministic re-centring of the SAME draw,
        // pivoted on the table's own mean, so the fitted mean (and pace) is
        // unchanged and only the spread moves. Not a new draw.
        const tableMeanDur = params.durationTableMean[durationRow];
        const shrunk = Math.max(
          tableMeanDur + params.durationDispersionScale * (rawDuration - tableMeanDur),
          0.0,
        );
        const freshDuration = (shrunk * params.durationLevelScale) / paceLatent[i];
        const actualDuration = hasPending[i] ? pendingDuration[i] : freshDuration;

        const resolves = active && actualDuration <= clock[i];

        if (resolves) {
          if (isHomeOff) {
            scoreHome[i] += pts;
            possCountHome[i] += 1;
          } else {
            scoreAway[i] += pts;
            possCountAway[i] += 1;
          }
        }

        const nextStart = cumPick(params.transitionCumprobs, ocIdx, uTrans[i]);
        if (resolves) curStartType[i] = nextStart;

        // Only ACTIVE replicates update their pending state; an inactive one
        // may be carrying state from an earlier iteration or period boundary.
        if (active) {
          const stillPending = !resolves;
          pendingDuration[i] = stillPending ? actualDuration - clock[i] : 0.0;
          hasPending[i] = stillPending ? 1 : 0;
        }
        if (resolves) possessing[i] = possessing[i] === 0 ? 1 : 0;
        if (active) clock[i] = resolves ? clock[i] - actualDuration : 0.0;
      }
    }
    if (!brokeOut) {
      throw new Error(
        `game ${gameId}: MAX_POSSESSIONS_PER_PERIOD=${MAX_POSSESSIONS_PER_PERIOD} hit without the ` +
          `period clock reaching everyone — check the duration fit`,
      );
    }

    if (period === 2) {
      homeScoreH1 = scoreHome.slice();
      awayScoreH1 = scoreAway.slice();
    }
    if (period === N_REGULATION_PERIODS) {
      homeScoreReg = scoreHome.slice();
      awayScoreReg = scoreAway.slice();
    }

    if (period >= N_REGULATION_PERIODS) {
      for (let i = 0; i < n; i++) {
        if (!activePeriod[i]) continue;
        const tied = scoreHome[i] === scoreAway[i];
        if (!tied) finished[i] = 1;
        if (period > N_REGULATION_PERIODS) nOtPeriods[i] += 1;
      }
    }
    period += 1;
  }

  const margin = new Float64Array(n);
  const total = new Float64Array(n);
  let sumMargin = 0;
  let sumTotal = 0;
  let homeWins = 0;
  for (let i = 0; i < n; i++) {
    margin[i] = scoreHome[i] - scoreAway[i];
    total[i] = scoreHome[i] + scoreAway[i];
    sumMargin += margin[i];
    sumTotal += total[i];
    if (margin[i] > 0) homeWins += 1;
  }
  const meanMargin = sumMargin / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (margin[i] - meanMargin) ** 2;
  const mcStderrMargin = n <= 1 ? NaN : Math.sqrt(ss / (n - 1)) / Math.sqrt(n);

  return {
    runId,
    paramVersion: params.paramVersion,
    dataAsOf: params.dataAsOf,
    nSims: n,
    gameId,
    homeTeam,
    awayTeam,
    neutralSite,
    homeOff,
    homeDef,
    awayOff,
    awayDef,
    hcaPts,
    finalHomeScore: scoreHome,
    finalAwayScore: scoreAway,
    possCountHome,
    possCountAway,
    nOtPeriods,
    paceLatent,
    efficiencyLatent,
    finalHomeScoreH1: homeScoreH1 ?? new Float64Array(n),
    finalAwayScoreH1: awayScoreH1 ?? new Float64Array(n),
    finalHomeScoreReg: homeScoreReg ?? new Float64Array(n),
    finalAwayScoreReg: awayScoreReg ?? new Float64Array(n),
    margin,
    total,
    meanMargin,
    meanTotal: sumTotal / n,
    mcStderrMargin,
    homeWinProb: homeWins / n,
  };
}
