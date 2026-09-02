// Server-side glue: DB read model + engine + box score, in one place, so the
// two API routes and the two SSR pages can never drift into simulating
// slightly different games.
//
// 🔴 ONE ENGINE, TWO CALL SITES (HOOPS_PLAN.md §5). This module runs the same
// lib/hoops/engine.ts + lib/hoops/boxscore.ts the client will call directly
// for live editing in the studio. There is no server-only copy of the maths
// here — everything below is plumbing: resolve tricodes, pick the rating mode,
// hand the pure modules their inputs.

import { boxscoreGameId, buildBoxscore, N_SIMS_EXPECTED_DEFAULT } from "./boxscore";
import type { BoxscoreResult } from "./boxscore";
import { simulateGame } from "./engine";
import { encodeRunId, summarizeSim } from "./matchup";
import type { RunCoordinates, SimSummary } from "./matchup";
import { offDefOf } from "./rating";
import {
  getBoxRoster,
  getDecodedParams,
  getHoopsMeta,
  getTeamRows,
  resolveRatingMode,
} from "./queries";
import type { HoopsMeta } from "./queries";
import type { RatingMode, TeamRow } from "./types";

export class UnknownTeamError extends Error {
  constructor(public readonly tri: string) {
    super(`unknown team tricode: ${tri}`);
    this.name = "UnknownTeamError";
  }
}

export interface MatchupInput {
  home: string;
  away: string;
  neutralSite?: boolean;
  ratingMode?: RatingMode;
  nSims?: number;
  /** Reproduce an existing run instead of spawning a fresh one. */
  runId?: string;
  /** Only used when spawning: makes two taps on Sim different games. */
  nonce?: string;
}

export interface MatchupRun {
  summary: SimSummary;
  box: BoxscoreResult;
  meta: HoopsMeta;
}

interface Resolved {
  coords: RunCoordinates;
  runId: string;
  rows: TeamRow[];
  meta: HoopsMeta;
  homeOff: number;
  homeDef: number;
  awayOff: number;
  awayDef: number;
}

function resolve(input: MatchupInput): Resolved {
  const home = input.home.toUpperCase();
  const away = input.away.toUpperCase();
  if (home === away) throw new Error("home and away must be different teams");

  const rows = getTeamRows();
  const homeRow = rows.find((r) => r.tri === home);
  const awayRow = rows.find((r) => r.tri === away);
  if (!homeRow) throw new UnknownTeamError(home);
  if (!awayRow) throw new UnknownTeamError(away);

  // 🔴 With no mode asked for, take the best read available tonight: the
  // nightly one where the bundle carries a complete set and the sender vouched
  // for it, otherwise the blend — which is what every caller got before hub-v2.
  // The chosen mode is baked into the run_id and printed on every result
  // surface, so this is never a silent substitution.
  const ratingMode = input.ratingMode ?? resolveRatingMode(rows);
  const neutralSite = input.neutralSite ?? false;
  const coords: RunCoordinates = { home, away, neutralSite, ratingMode };

  const h = offDefOf(homeRow, ratingMode);
  const a = offDefOf(awayRow, ratingMode);

  return {
    coords,
    runId: input.runId ?? encodeRunId(coords, input.nonce ?? "0"),
    rows,
    meta: getHoopsMeta(),
    homeOff: h.off,
    homeDef: h.def,
    awayOff: a.off,
    awayDef: a.def,
  };
}

/**
 * The core verb: sim a matchup and build the EXPECTED box score off the same
 * replicates. Deliberately one simulation, not two — running the engine again
 * for the box score would produce a box score describing a different set of
 * games than the histogram above it.
 */
export function runMatchup(input: MatchupInput): MatchupRun {
  const r = resolve(input);
  const params = getDecodedParams();
  const nSims = input.nSims ?? N_SIMS_EXPECTED_DEFAULT;

  const simulation = simulateGame({
    params,
    runId: r.runId,
    gameId: boxscoreGameId(r.coords.home, r.coords.away),
    homeTeam: r.coords.home,
    awayTeam: r.coords.away,
    homeOff: r.homeOff,
    homeDef: r.homeDef,
    awayOff: r.awayOff,
    awayDef: r.awayDef,
    hcaPts: r.meta.hcaPts,
    nSims,
    neutralSite: r.coords.neutralSite,
  });

  const box = buildBoxscore({
    params,
    runId: r.runId,
    home: r.coords.home,
    away: r.coords.away,
    homeRoster: getBoxRoster(r.coords.home),
    awayRoster: getBoxRoster(r.coords.away),
    homeOff: r.homeOff,
    homeDef: r.homeDef,
    awayOff: r.awayOff,
    awayDef: r.awayDef,
    hcaPts: r.meta.hcaPts,
    neutralSite: r.coords.neutralSite,
    mode: "expected",
    nSims,
    simulation,
  });

  return { summary: summarizeSim(simulation, r.coords.ratingMode), box, meta: r.meta };
}

export interface SampledGame {
  box: BoxscoreResult;
  coords: RunCoordinates;
  meta: HoopsMeta;
}

/**
 * One specific night: a single replicate, integer lines that sum exactly to
 * the realised score. `runId` carries its own coordinates, so this is a pure
 * function of the URL plus whatever parameter blob is currently live.
 */
export function runSampledGame(runId: string, coords: RunCoordinates): SampledGame {
  const r = resolve({ ...coords, runId });
  const params = getDecodedParams();

  const box = buildBoxscore({
    params,
    runId,
    home: r.coords.home,
    away: r.coords.away,
    homeRoster: getBoxRoster(r.coords.home),
    awayRoster: getBoxRoster(r.coords.away),
    homeOff: r.homeOff,
    homeDef: r.homeDef,
    awayOff: r.awayOff,
    awayDef: r.awayDef,
    hcaPts: r.meta.hcaPts,
    neutralSite: r.coords.neutralSite,
    mode: "sample",
  });

  return { box, coords: r.coords, meta: r.meta };
}
