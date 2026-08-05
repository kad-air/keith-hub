// Port of hoops-sim's `hoops.boxscore` — the two-mode box-score simulator,
// rebuilt on the inputs the exported bundle actually carries.
//
// Pure: no fs, no SQLite, no `process`. Same discipline as rating.ts and
// pricing.ts, and for the same reason — the studio (#69) re-runs this in the
// browser on every keystroke, so it cannot depend on a server round trip.
//
// ── 🔴 WHERE THIS DELIBERATELY DIVERGES FROM PYTHON, AND WHY ─────────────
//
// This is a second implementation, so the divergences are stated here rather
// than discovered later. They are NOT approximations chosen for convenience;
// each one is forced by the export boundary (HOOPS_PLAN.md §2: nothing here
// may touch DuckDB), and each changes a NUMBER, not just an implementation.
//
//   1. PARTICIPANTS. Python's list is "last-game actives, or the season-
//      typical rotation when the last game is stale". The bundle carries no
//      game-by-game actives, so the first branch is unreachable here — but the
//      SECOND one is ported exactly (`selectRotation` below), because the
//      export's `minutes` field IS the quantity that branch ranks on
//      (`rosterratings._season_typical_minutes`, exporthub.py). Since the
//      bundle is a season snapshot, Python's own staleness rule would take
//      that same branch today.
//
//      🔴 This is not a nicety. Projecting the FULL 16-20 man roster instead
//      was the first implementation, and it was measurably wrong: allocating
//      240 minutes across everyone with a row deflated every rotation player's
//      line by ~40% (Tyrese Maxey 15.4 projected against 28.3 actual, a −4.9
//      point bias across all 137 rotation players in the bundle) while the
//      TEAM totals stayed perfectly correct, because points come from the
//      engine and the shares renormalize. Nothing self-consistent could catch
//      it — only comparing against the measured per-game scoring the bundle
//      also carries. scripts/check-hoops-boxscore.ts now asserts that bias.
//
//   2. NON-PTS TEAM LEVEL. Python anchors each team's REB/AST/STL/BLK/TOV
//      level on that team's own measured per-game totals from the game logs,
//      then allocates it across participants by season-to-date share. There
//      are no team game logs in the bundle. So the level here is BUILT from
//      the same per-player rates that drive the shares:
//
//          team per-game[stat] = Σ_players per36[stat] × allocated_minutes/36
//
//      i.e. the team total implied by 240 minutes of this roster's own
//      production rates. This is self-consistent by construction (the player
//      lines sum to the team level exactly, in both modes) and it responds
//      correctly to a minutes edit, which the studio needs. What it gives up
//      is the measured team level: a team whose real REB total runs above
//      what its players' individual rates imply will read low here.
//
//      🔴 Do NOT "fix" this by summing each player's per-GAME rates instead.
//      That was the obvious first move and it is wrong: a per-game rate is
//      conditioned on the games a player actually appeared in, so summing 18
//      of them counts a full rotation's worth of production for every bench
//      player who plays some nights, and inflates the team level by ~30%.
//      Per-36 × allocated-minutes is the version that respects the 240-minute
//      budget.
//
//   3. PTS SHARES. Python shares points by season points-per-game; here they
//      come off the same per36 × minutes basis as every other stat, so that
//      one roster edit moves all six stats coherently.
//
//   4. NO PLAYOFF CONCENTRATION. `hoops.playoffrotation`'s share**alpha
//      transform is not ported. `effective_alpha(False) == 1.0` is an exact
//      identity on the Python side, so regular-season output is unaffected;
//      a playoff toggle is a later milestone's job, not a silent default.
//
// What is NOT divergent, and is asserted: the multinomial allocation itself
// (lib/hoops/binomial.ts, checked against numpy by
// scripts/check-hoops-multinomial.ts), the minutes allocation
// (lib/hoops/pricing.ts's allocateMinutes, hoops-sim's own allocate_minutes),
// the possession engine (lib/hoops/engine.ts), the pace pathway into every
// stat (each replicate's OWN simulated possession count), and the RNG
// coordinates, which reuse Python's purpose strings verbatim.
//
// ── 🔴 VARIANCE HONESTY (must render in the UI, not just live here) ──────
// Player-level spread here UNDERSTATES real game-to-game variance: no hot or
// cold shooting nights, no minutes variance, no usage response to matchup or
// injury. Multinomial-over-a-fixed-share times a team total is the whole
// mechanism. A projected 24 is a centre of mass, not a forecast of the night.

import { randomMultinomial } from "./binomial.ts";
import { simulateGame } from "./engine.ts";
import type { GameSimResult } from "./engine.ts";
import type { DecodedParams } from "./params.ts";
import { allocateMinutes } from "./pricing.ts";
import { stream } from "./rng.ts";
import type { RawPlayerGameRates, RawPlayerPer36 } from "./types.ts";

export const STAT_ORDER = ["pts", "reb", "ast", "stl", "blk", "tov"] as const;
export type Stat = (typeof STAT_ORDER)[number];

/** Default replicate count for expected mode. Python's is 3000; this is lower
 *  because the port runs ~3x slower than vectorised numpy (measured, #66) and
 *  this one has to feel interactive on a phone. 1000 replicates puts the
 *  Monte Carlo standard error on win probability near 1.5 points. */
export const N_SIMS_EXPECTED_DEFAULT = 1000;
export const N_SIMS_MAX = 5000;

export interface BoxPlayer {
  athlete_id: number;
  name: string;
  /** Raw expected minutes, PRE-normalisation — allocated to the 240 budget here. */
  minutes: number;
  per36: RawPlayerPer36 | null;
  game_rates: RawPlayerGameRates | null;
}

// ── Who is actually playing ──────────────────────────────────────────────
//
// 🔴 These three come from hoops-sim's `hoops.roster` (ROTATION_FILL_MINUTES,
// ROTATION_MIN, ROTATION_MAX) and are the ONLY constants in this module not
// read by name off the bundle — the export's `constants` block doesn't carry
// them yet. They are read from `constants` when present, so the moment the
// sender adds them the fallbacks stop being consulted; adding them to
// contract.ts's REQUIRED_CONSTANTS instead would reject every bundle that
// exists today, which the wire contract explicitly forbids for a constant the
// sender hasn't started sending.
const ROTATION_FILL_MINUTES = 265.0;
const ROTATION_MIN = 8;
const ROTATION_MAX = 13;

export interface RotationSelection {
  players: BoxPlayer[];
  /** Sum of the picked players' RAW minutes, before allocation. */
  rawMinutes: number;
  /** How many players were on the roster but not projected. */
  omitted: number;
  /** Human-readable, printed on screen — Python prints its own basis string
   *  on every box score and this one has to as well. */
  basis: string;
}

/**
 * Port of the season-typical branch of hoops-sim's
 * `roster.resolve_participant_basis`: rank the roster by season-typical
 * minutes, take players until their combined historical minutes reach the
 * fill target, bounded by the min/max rotation size.
 *
 * A team plays 240 minutes and the fill target is 265, so the rotation is
 * deliberately a little larger than one game's worth — the allocation that
 * follows shrinks everyone proportionally back onto the real budget.
 */
export function selectRotation(
  roster: BoxPlayer[],
  constants?: Partial<Record<"rotation_fill_minutes" | "rotation_min" | "rotation_max", number>>,
): RotationSelection {
  const fill = constants?.rotation_fill_minutes ?? ROTATION_FILL_MINUTES;
  const min = constants?.rotation_min ?? ROTATION_MIN;
  const max = constants?.rotation_max ?? ROTATION_MAX;

  // Ties broken by athlete_id so the rotation is stable across processes —
  // a sort that isn't total would make a shared run_id render differently on
  // two devices.
  const ranked = [...roster].sort(
    (a, b) => b.minutes - a.minutes || a.athlete_id - b.athlete_id,
  );

  const picked: BoxPlayer[] = [];
  let cum = 0;
  for (const p of ranked) {
    if (picked.length >= max) break;
    if (cum >= fill && picked.length >= min) break;
    picked.push(p);
    cum += p.minutes;
  }

  return {
    players: picked,
    rawMinutes: cum,
    omitted: roster.length - picked.length,
    basis:
      `season-typical rotation — ${picked.length} players filling ${cum.toFixed(0)} ` +
      `historical minutes`,
  };
}

export interface PlayerLine {
  athlete_id: number;
  name: string;
  minutes: number;
  stats: Record<Stat, number>;
  /** Expected mode only: sampled 10th/90th percentile of this player's points
   *  across replicates — team-points variance AND allocation variance in one
   *  pass, exactly like Python's (sampled, never derived analytically). */
  ptsP10?: number;
  ptsP90?: number;
  /** True when this player had no per-36 rates in the bundle and his line was
   *  reconstructed from per-game rates, or is all zeroes. Surfaced, not hidden. */
  ratesImputed: boolean;
}

export interface TeamBox {
  tri: string;
  /** How the participant list was chosen, and who was left off. Rendered. */
  basis: string;
  omitted: number;
  players: PlayerLine[];
  totals: Record<Stat, number> & { min: number };
  /** Replicate-distribution mean per stat (expected), or the one realised
   *  total (sample). */
  teamSim: Record<Stat, number>;
}

export interface BoxscoreResult {
  mode: "expected" | "sample";
  runId: string;
  gameId: string;
  home: TeamBox;
  away: TeamBox;
  homeScore: number;
  awayScore: number;
  /** Sample mode: the realised OT-period count. */
  nOt: number | null;
  /** Expected mode: P(any OT) across replicates, as a percentage. */
  otPct: number | null;
  nSims: number;
  neutralSite: boolean;
  paramVersion: string;
  dataAsOf: string;
  /** Simulated possessions per team — the realised count in sample mode, the
   *  replicate mean in expected mode. Every non-PTS stat is this times a
   *  per-possession rate, so it is the pace the box score was built at and is
   *  rendered rather than left implicit. */
  possHome: number;
  possAway: number;
}

// ── Per-36 extraction ────────────────────────────────────────────────────

/** Points per 36 implied by the shooting lines the export carries. */
function pts36(p: RawPlayerPer36): number {
  return 2 * p.fg2m + 3 * p.fg3m + p.ftm;
}

function statPer36(p: RawPlayerPer36, stat: Stat): number {
  switch (stat) {
    case "pts":
      return pts36(p);
    case "reb":
      return p.oreb + p.dreb;
    case "ast":
      return p.ast;
    case "stl":
      return p.stl;
    case "blk":
      return p.blk;
    case "tov":
      return p.tov;
  }
}

/**
 * One player's per-36 rate for every stat, with the export's own gaps handled
 * explicitly rather than silently.
 *
 * `per36` is null for a true no-history player (1 of 533 in the current
 * bundle). Rather than drop him from the box score — he still holds rotation
 * minutes and would silently inflate everyone else's share — his rates are
 * reconstructed from the per-GAME rates the export does carry, divided by his
 * own expected minutes. A player with neither gets zeroes, matching Python's
 * "never stated, never templated" default for a fictional player, and is
 * flagged so the UI can say so.
 */
function ratesFor(p: BoxPlayer): { rates: Record<Stat, number>; imputed: boolean } {
  const rates = {} as Record<Stat, number>;
  if (p.per36) {
    for (const stat of STAT_ORDER) rates[stat] = statPer36(p.per36, stat);
    return { rates, imputed: false };
  }
  const g = p.game_rates;
  const mins = p.minutes > 0 ? p.minutes : 0;
  if (g && mins > 0) {
    const scale = 36 / mins;
    rates.pts = g.pts * scale;
    rates.reb = g.reb * scale;
    rates.ast = g.ast * scale;
    rates.stl = g.stl * scale;
    rates.blk = g.blk * scale;
    rates.tov = g.tov * scale;
    return { rates, imputed: true };
  }
  for (const stat of STAT_ORDER) rates[stat] = 0;
  return { rates, imputed: true };
}

// ── Shares ───────────────────────────────────────────────────────────────

interface TeamBasis {
  players: BoxPlayer[];
  selection: RotationSelection;
  /** athlete_id -> allocated minutes, summing to the 240-minute budget. */
  minutes: Map<number, number>;
  /** stat -> per-player expected production over one 240-minute team game. */
  production: Record<Stat, Float64Array>;
  /** stat -> per-player share, summing to 1. */
  shares: Record<Stat, Float64Array>;
  /** stat -> team per-game level implied by this roster. */
  teamPerGame: Record<Stat, number>;
  imputed: boolean[];
}

function buildBasis(
  roster: BoxPlayer[],
  totalTeamMinutes: number,
  rotationConstants?: Parameters<typeof selectRotation>[1],
): TeamBasis {
  const selection = selectRotation(roster, rotationConstants);
  const players = selection.players;

  const raw = new Map<number, number>();
  for (const p of players) raw.set(p.athlete_id, p.minutes);
  const minutes = allocateMinutes(raw, totalTeamMinutes);

  const production = {} as Record<Stat, Float64Array>;
  const shares = {} as Record<Stat, Float64Array>;
  const teamPerGame = {} as Record<Stat, number>;
  for (const stat of STAT_ORDER) {
    production[stat] = new Float64Array(players.length);
    shares[stat] = new Float64Array(players.length);
    teamPerGame[stat] = 0;
  }

  const imputed: boolean[] = [];
  players.forEach((p, i) => {
    const { rates, imputed: imp } = ratesFor(p);
    imputed.push(imp);
    const min = minutes.get(p.athlete_id) ?? 0;
    for (const stat of STAT_ORDER) {
      const v = (rates[stat] * min) / 36;
      production[stat][i] = v;
      teamPerGame[stat] += v;
    }
  });

  // Uniform fallback on a degenerate stat (every participant at zero) —
  // hoops.boxscore._shares does exactly this, and without it the multinomial
  // would be handed a vector of NaNs.
  for (const stat of STAT_ORDER) {
    const total = teamPerGame[stat];
    if (total > 0) {
      for (let i = 0; i < players.length; i++) shares[stat][i] = production[stat][i] / total;
    } else {
      const u = players.length > 0 ? 1 / players.length : 0;
      for (let i = 0; i < players.length; i++) shares[stat][i] = u;
    }
  }

  return { players, selection, minutes, production, shares, teamPerGame, imputed };
}

// ── numpy-compatible percentile ──────────────────────────────────────────

/** np.percentile with the default linear interpolation, over a sorted copy. */
function percentile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = (q / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

// ── Per-team builders ────────────────────────────────────────────────────

/** Each replicate's team total for one stat. PTS comes straight from the
 *  engine; every other stat is the team's per-possession rate times THAT
 *  replicate's own simulated possession count, so pace flows through. */
function teamStatReplicates(
  basis: TeamBasis,
  stat: Stat,
  teamPts: Float64Array,
  possCount: Float64Array,
  avgPossPerTeamGame: number,
): Float64Array {
  if (stat === "pts") return teamPts;
  const ratePerPoss = basis.teamPerGame[stat] / avgPossPerTeamGame;
  const out = new Float64Array(possCount.length);
  for (let i = 0; i < possCount.length; i++) out[i] = ratePerPoss * possCount[i];
  return out;
}

function buildExpectedTeam(
  basis: TeamBasis,
  arrs: Record<Stat, Float64Array>,
  runId: string,
  gameId: string,
  tri: string,
  nSims: number,
): TeamBox {
  const teamSim = {} as Record<Stat, number>;
  for (const stat of STAT_ORDER) {
    let s = 0;
    for (let i = 0; i < nSims; i++) s += arrs[stat][i];
    teamSim[stat] = s / nSims;
  }

  // Sampled p10/p90 for points: one multinomial allocation per replicate, off
  // that replicate's OWN simulated team total. Combines team-level points
  // variance and allocation variance in a single pass — the same mechanic
  // Python documents as sampled rather than analytic.
  const nPlayers = basis.players.length;
  const gen = stream(runId, "boxscore-expected-pts-alloc", gameId, tri);
  const perPlayer: number[][] = Array.from({ length: nPlayers }, () => new Array(nSims));
  const pv = Array.from(basis.shares.pts);
  for (let i = 0; i < nSims; i++) {
    const total = Math.max(Math.round(arrs.pts[i]), 0);
    const draw = randomMultinomial(gen, total, pv);
    for (let j = 0; j < nPlayers; j++) perPlayer[j][i] = draw[j];
  }

  const players: PlayerLine[] = basis.players.map((p, j) => {
    const stats = {} as Record<Stat, number>;
    for (const stat of STAT_ORDER) stats[stat] = basis.shares[stat][j] * teamSim[stat];
    const sorted = perPlayer[j].slice().sort((a, b) => a - b);
    return {
      athlete_id: p.athlete_id,
      name: p.name,
      minutes: basis.minutes.get(p.athlete_id) ?? 0,
      stats,
      ptsP10: percentile(sorted, 10),
      ptsP90: percentile(sorted, 90),
      ratesImputed: basis.imputed[j],
    };
  });

  return {
    tri,
    basis: basis.selection.basis,
    omitted: basis.selection.omitted,
    players,
    totals: sumTotals(players),
    teamSim,
  };
}

function buildSampleTeam(
  basis: TeamBasis,
  arrs: Record<Stat, Float64Array>,
  runId: string,
  gameId: string,
  tri: string,
): TeamBox {
  const teamSim = {} as Record<Stat, number>;
  for (const stat of STAT_ORDER) teamSim[stat] = Math.max(Math.round(arrs[stat][0]), 0);

  const nPlayers = basis.players.length;
  const perPlayer: Record<Stat, Int32Array> = {} as Record<Stat, Int32Array>;
  for (const stat of STAT_ORDER) {
    const gen = stream(runId, `boxscore-sample-${stat}`, gameId, tri);
    perPlayer[stat] = randomMultinomial(gen, teamSim[stat], Array.from(basis.shares[stat]));
  }

  const players: PlayerLine[] = basis.players.map((p, j) => {
    const stats = {} as Record<Stat, number>;
    for (const stat of STAT_ORDER) stats[stat] = perPlayer[stat][j];
    return {
      athlete_id: p.athlete_id,
      name: p.name,
      minutes: basis.minutes.get(p.athlete_id) ?? 0,
      stats,
      ratesImputed: basis.imputed[j],
    };
  });

  const totals = sumTotals(players);

  // 🔴 The load-bearing property of sample mode, asserted in the code path
  // itself and not only in the build check. Multinomial guarantees it by
  // construction — which is exactly why a violation here would mean the
  // allocation is not the one it claims to be.
  for (const stat of STAT_ORDER) {
    if (totals[stat] !== teamSim[stat]) {
      throw new Error(
        `boxscore sample mode: ${tri} ${stat} lines sum to ${totals[stat]} but the realised ` +
          `team total is ${teamSim[stat]} — the multinomial allocation is not intact`,
      );
    }
  }

  return {
    tri,
    basis: basis.selection.basis,
    omitted: basis.selection.omitted,
    players,
    totals,
    teamSim,
  };
}

function sumTotals(players: PlayerLine[]): Record<Stat, number> & { min: number } {
  const totals = { min: 0 } as Record<Stat, number> & { min: number };
  for (const stat of STAT_ORDER) totals[stat] = 0;
  for (const p of players) {
    totals.min += p.minutes;
    for (const stat of STAT_ORDER) totals[stat] += p.stats[stat];
  }
  return totals;
}

// ── The entry point ──────────────────────────────────────────────────────

export interface BoxscoreInput {
  params: DecodedParams;
  runId: string;
  home: string;
  away: string;
  homeRoster: BoxPlayer[];
  awayRoster: BoxPlayer[];
  homeOff: number;
  homeDef: number;
  awayOff: number;
  awayDef: number;
  hcaPts: number;
  neutralSite?: boolean;
  mode?: "expected" | "sample";
  nSims?: number;
  /**
   * Reuse an already-computed simulation instead of re-running the engine —
   * the matchup screen sims once and renders both the distribution and the
   * expected box score off the same replicates.
   *
   * 🔴 The replicate count must MATCH the mode's own, and that is enforced
   * below rather than trusted. Replicate 0 of an n = 1 run is NOT replicate 0
   * of an n = 1000 run: `possessionCounter` in engine.ts is scoped to the
   * whole batch (a faithful port of hoops-sim's sim.py), so period 2's draw
   * coordinates depend on how long the slowest replicate in the batch took in
   * period 1. Measured, not theorised — the same run_id gives DEN 128-137 at
   * n = 1 and 135-134 at n = 1000. Feeding a sampled box score the matchup
   * screen's 1000-replicate simulation would therefore produce a game that
   * its own run_id can never reproduce, which is the one thing
   * /hoops/game/[runId] promises.
   */
  simulation?: GameSimResult;
}

/** The game_id both teams' draws are keyed on. Stable and self-describing, so
 *  a run is reproducible from the URL alone. */
export function boxscoreGameId(home: string, away: string): string {
  return `boxscore-${home}-${away}`;
}

export function buildBoxscore(input: BoxscoreInput): BoxscoreResult {
  const {
    params,
    runId,
    home,
    away,
    homeRoster,
    awayRoster,
    homeOff,
    homeDef,
    awayOff,
    awayDef,
    hcaPts,
    neutralSite = false,
    mode = "expected",
    simulation,
  } = input;

  if (home === away) throw new Error("home and away must be different teams");
  if (homeRoster.length === 0) throw new Error(`no roster for ${home}`);
  if (awayRoster.length === 0) throw new Error(`no roster for ${away}`);

  const nSims =
    mode === "sample"
      ? 1
      : Math.max(1, Math.min(input.nSims ?? N_SIMS_EXPECTED_DEFAULT, N_SIMS_MAX));
  const gameId = boxscoreGameId(home, away);

  const result =
    simulation ??
    simulateGame({
      params,
      runId,
      gameId,
      homeTeam: home,
      awayTeam: away,
      homeOff,
      homeDef,
      awayOff,
      awayDef,
      hcaPts,
      nSims,
      neutralSite,
    });

  if (result.nSims !== nSims) {
    throw new Error(
      `boxscore: supplied simulation has ${result.nSims} replicates but this mode needs ${nSims}`,
    );
  }

  const budget = params.constants.total_team_minutes;
  const rotationConstants = params.constants as unknown as Parameters<typeof selectRotation>[1];
  const homeBasis = buildBasis(homeRoster, budget, rotationConstants);
  const awayBasis = buildBasis(awayRoster, budget, rotationConstants);

  const arrsFor = (
    basis: TeamBasis,
    pts: Float64Array,
    poss: Float64Array,
  ): Record<Stat, Float64Array> => {
    const arrs = {} as Record<Stat, Float64Array>;
    for (const stat of STAT_ORDER) {
      arrs[stat] = teamStatReplicates(basis, stat, pts, poss, params.avgPossPerTeamGame);
    }
    return arrs;
  };

  const homeArrs = arrsFor(homeBasis, result.finalHomeScore, result.possCountHome);
  const awayArrs = arrsFor(awayBasis, result.finalAwayScore, result.possCountAway);

  let homeBox: TeamBox;
  let awayBox: TeamBox;
  let homeScore: number;
  let awayScore: number;
  let nOt: number | null;
  let otPct: number | null;

  if (mode === "expected") {
    homeBox = buildExpectedTeam(homeBasis, homeArrs, runId, gameId, home, nSims);
    awayBox = buildExpectedTeam(awayBasis, awayArrs, runId, gameId, away, nSims);
    homeScore = homeBox.teamSim.pts;
    awayScore = awayBox.teamSim.pts;
    nOt = null;
    let ot = 0;
    for (let i = 0; i < nSims; i++) if (result.nOtPeriods[i] > 0) ot += 1;
    otPct = (100 * ot) / nSims;
  } else {
    homeBox = buildSampleTeam(homeBasis, homeArrs, runId, gameId, home);
    awayBox = buildSampleTeam(awayBasis, awayArrs, runId, gameId, away);
    homeScore = homeBox.totals.pts;
    awayScore = awayBox.totals.pts;
    nOt = result.nOtPeriods[0];
    otPct = null;
  }

  return {
    mode,
    runId,
    gameId,
    home: homeBox,
    away: awayBox,
    homeScore,
    awayScore,
    nOt,
    otPct,
    nSims,
    neutralSite,
    paramVersion: result.paramVersion,
    dataAsOf: result.dataAsOf,
    possHome: mean(result.possCountHome, nSims),
    possAway: mean(result.possCountAway, nSims),
  };
}

function mean(a: Float64Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return s / n;
}
