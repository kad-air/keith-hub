// Structural completeness gate for a PUSHED bundle (kad-air/keith-hub#73),
// run before the write transaction. Deliberately narrower than
// scripts/check-hoops.ts (the build-time gate over the COMMITTED bundle,
// which checks probability sums, CDF monotonicity, conference/division
// assignments, and more) — this only has to catch "a truncated or corrupt
// bundle almost made it into the read model," the specific failure mode
// #73 requires never reach the previous read model.
//
// 🔴 Found by falsification while building this endpoint, not assumed:
// `decodeParams` alone (the pre-existing stale-blob guard) validates
// hoops_params.json's OWN internal shape, but says nothing about whether
// hoops_teams.json/hoops_players.json/hoops_schedule.json actually have a
// plausible AMOUNT of content. A bundle with hoops_players.json truncated
// to 5 players (of a real ~530) parsed fine, passed decodeParams, and wrote
// successfully — silently replacing a full read model with a nearly-empty
// one. This module is what catches that case now.

import { FRANCHISES } from "./nba-franchises.ts";
import { validateSchedule } from "./schedule.ts";
import type { HoopsBundle } from "./types";

export class BundleRejection extends Error {}

const KNOWN_TRIS = new Set(Object.keys(FRANCHISES));
const N_TEAMS = 30;
const MIN_PLAYERS_PER_TEAM = 8; // an NBA team carries >= 14 under contract; 8 is a floor no
// real roster can fall below on a healthy night, chosen with margin below check-hoops.ts's
// own stricter 10-player floor over the COMMITTED bundle (this gate runs on every push, not
// just at merge time, so it stays intentionally a little more permissive).

function fail(msg: string): never {
  throw new BundleRejection(msg);
}

export interface ValidateOptions {
  /** The bundle declared `partial_schedule`: hoops_schedule.json may be short
   *  of 1,230 games if it accounts for every missing one. Default false — the
   *  exact rule every bundle before 2026-10-28 was held to. */
  partialSchedule?: boolean;
}

/** Throws BundleRejection, naming the problem, on anything that looks like a
 *  truncated or structurally incomplete bundle. Never mutates its input. */
export function validatePushedBundle(bundle: HoopsBundle, opts: ValidateOptions = {}): void {
  const teamTris = Object.keys(bundle.teams?.teams ?? {});
  if (teamTris.length !== N_TEAMS) {
    fail(`hoops_teams.json: expected ${N_TEAMS} teams, got ${teamTris.length}`);
  }
  const missingTeams = [...KNOWN_TRIS].filter((t) => !teamTris.includes(t));
  if (missingTeams.length > 0) {
    fail(`hoops_teams.json: missing franchise(s) ${missingTeams.join(", ")}`);
  }
  const unknownTeams = teamTris.filter((t) => !KNOWN_TRIS.has(t));
  if (unknownTeams.length > 0) {
    fail(`hoops_teams.json: unknown tri code(s) ${unknownTeams.join(", ")}`);
  }

  const players = bundle.players?.players ?? [];
  const perTeam = new Map<string, number>();
  for (const p of players) {
    perTeam.set(p.team, (perTeam.get(p.team) ?? 0) + 1);
  }
  const short = [...KNOWN_TRIS].filter((t) => (perTeam.get(t) ?? 0) < MIN_PLAYERS_PER_TEAM);
  if (short.length > 0) {
    fail(
      `hoops_players.json: ${short
        .map((t) => `${t}=${perTeam.get(t) ?? 0}`)
        .join(", ")} — fewer than ${MIN_PLAYERS_PER_TEAM} players (truncated bundle?)`,
    );
  }

  // The schedule's rules live in lib/hoops/schedule.ts (pure, gate-driven):
  // exactly 1,230 games without `partial_schedule`, or every missing game
  // accounted for with it. Its rejection is re-thrown as this module's so
  // the route's error prefix stays "invalid bundle:".
  try {
    validateSchedule(bundle.schedule, { partial: opts.partialSchedule === true });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const results = bundle.results?.games ?? [];
  if (results.length === 0) {
    fail("hoops_results.json: no games");
  }
  const tied = results.find((g) => g.home_score === g.away_score);
  if (tied) {
    fail(`hoops_results.json: ${tied.game_id} ended tied — NBA games cannot end tied`);
  }

  const lines = bundle.lines?.lines ?? [];
  if (lines.length === 0) {
    fail("hoops_lines.json: no lines");
  }
}
