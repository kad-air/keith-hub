// The nightly rest-of-season projection: validation, ordering and the small
// amount of arithmetic the page needs. PURE — no fs, no DB, no Next — so the
// build gate (scripts/check-hoops-projections.ts) drives the real functions
// under plain node, and the page cannot order a table differently from the
// gate.
//
// Wire contract (receiver half; the sender is hoops-sim's nightly publish):
// feature token `season_projection`, file `projections.json`. The receiver
// ships FIRST — a bundle without the token must keep importing exactly as it
// does today, and a bundle WITH it must carry a file this validator accepts,
// or the whole push is refused (fail closed, like every other malformed blob).
//
// 🔴 What is validated is not just the shape but the ARITHMETIC a projection
// cannot violate, as second-source facts about the NBA rather than the
// file agreeing with itself: 30 franchises each exactly once, with the
// conference this receiver already knows (nba-franchises.ts); 82 games a
// team; one champion, two finalists, four conference finalists, eight
// playoff teams and six top-6 seeds per conference; 1,230 wins in the league.
// A sender that mislabels a probability (a percentage where a fraction was
// promised, a play-in chance that double-counts the top six) is caught here,
// on the wire, instead of rendering as a plausible-looking column.

import { FRANCHISES } from "./nba-franchises.ts";
import type { RawProjectionTeam, RawProjectionsFile } from "./types";

export class ProjectionRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionRejection";
  }
}

export const N_TEAMS = 30;
export const GAMES_PER_TEAM = 82;
/** Every team's 82 games, each producing exactly one win — an NBA fact. */
export const LEAGUE_WINS = (N_TEAMS * GAMES_PER_TEAM) / 2;

/** How far a published sum may sit from its exact value. The sender rounds
 *  each figure (a probability to ~3 places, a win total to ~1), so a sum over
 *  15 or 30 teams accumulates rounding — these are wide enough for that and
 *  still far too tight for a mislabelled column (percent vs. fraction is a
 *  factor of 100; a missing team is a whole unit). */
export const SUM_TOLERANCE = {
  /** per-conference sums of playoff/top6/playin/conf_finals; league finals/title */
  pct: 0.05,
  /** per-team proj_wins + proj_losses, and the league total of proj_wins */
  wins: 0.15,
  leagueWins: 2.0,
} as const;

/** Slack on the nesting inequalities for the sender's own rounding (one unit
 *  of a 3-decimal probability, doubled). */
export const NEST_EPS = 2e-3;

const PCT_FIELDS = [
  "playoff_pct",
  "playin_pct",
  "top6_pct",
  "conf_finals_pct",
  "finals_pct",
  "title_pct",
] as const;

function fail(msg: string): never {
  throw new ProjectionRejection(`projections.json: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isFinite_(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A real calendar date in YYYY-MM-DD — "2026-02-30" is refused, not rolled. */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

function nearly(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/**
 * Validate a raw `projections.json`. Returns the typed file (the same object,
 * narrowed) or throws ProjectionRejection naming the FIRST problem found.
 * Never mutates its input.
 */
export function validateProjections(raw: unknown): RawProjectionsFile {
  if (!isPlainObject(raw)) fail("expected an object");

  if (!isInt(raw.season_start_year) || raw.season_start_year < 1946) {
    fail(`season_start_year must be an integer season (got ${JSON.stringify(raw.season_start_year)})`);
  }
  if (!isCalendarDate(raw.as_of_date)) {
    fail(`as_of_date must be a real YYYY-MM-DD date (got ${JSON.stringify(raw.as_of_date)})`);
  }
  if (typeof raw.generated_at !== "string" || Number.isNaN(Date.parse(raw.generated_at))) {
    fail(`generated_at must be an ISO-8601 timestamp (got ${JSON.stringify(raw.generated_at)})`);
  }
  if (!isInt(raw.replicates) || raw.replicates < 1) {
    fail(`replicates must be a positive integer (got ${JSON.stringify(raw.replicates)})`);
  }
  if (typeof raw.method !== "string" || raw.method.trim().length === 0) {
    fail("method must be a non-empty string");
  }
  if (!Array.isArray(raw.teams)) fail("teams must be an array");
  if (raw.teams.length !== N_TEAMS) fail(`expected ${N_TEAMS} teams, got ${raw.teams.length}`);

  const seen = new Set<string>();
  const teams: RawProjectionTeam[] = [];
  for (const [i, t] of (raw.teams as unknown[]).entries()) {
    if (!isPlainObject(t)) fail(`teams[${i}]: expected an object`);
    const tri = t.team;
    if (typeof tri !== "string") fail(`teams[${i}]: team must be a tri code string`);
    const franchise = FRANCHISES[tri];
    if (!franchise) fail(`teams[${i}]: unknown tri code "${tri}"`);
    if (seen.has(tri)) fail(`${tri} appears more than once`);
    seen.add(tri);
    if (t.conference !== franchise.conference) {
      fail(
        `${tri}: conference ${JSON.stringify(t.conference)} but ${franchise.name} play in the ` +
          `${franchise.conference}`,
      );
    }

    for (const f of ["wins", "losses", "wins_p10", "wins_p90"] as const) {
      if (!isInt(t[f]) || (t[f] as number) < 0 || (t[f] as number) > GAMES_PER_TEAM) {
        fail(`${tri}: ${f} must be an integer in 0..${GAMES_PER_TEAM} (got ${JSON.stringify(t[f])})`);
      }
    }
    for (const f of ["proj_wins", "proj_losses"] as const) {
      if (!isFinite_(t[f]) || (t[f] as number) < 0 || (t[f] as number) > GAMES_PER_TEAM) {
        fail(`${tri}: ${f} must be a number in 0..${GAMES_PER_TEAM} (got ${JSON.stringify(t[f])})`);
      }
    }
    for (const f of PCT_FIELDS) {
      if (!isFinite_(t[f]) || (t[f] as number) < 0 || (t[f] as number) > 1) {
        fail(`${tri}: ${f} must be a probability in [0, 1] (got ${JSON.stringify(t[f])})`);
      }
    }

    const team = t as unknown as RawProjectionTeam;
    const played = team.wins + team.losses;
    if (played > GAMES_PER_TEAM) {
      fail(`${tri}: ${team.wins}-${team.losses} is ${played} games, a season is ${GAMES_PER_TEAM}`);
    }
    // Games already won stay won: the projection can only add to the record.
    if (team.proj_wins + 1e-9 < team.wins) {
      fail(`${tri}: proj_wins ${team.proj_wins} is below the ${team.wins} already won`);
    }
    if (team.proj_losses + 1e-9 < team.losses) {
      fail(`${tri}: proj_losses ${team.proj_losses} is below the ${team.losses} already lost`);
    }
    if (!nearly(team.proj_wins + team.proj_losses, GAMES_PER_TEAM, SUM_TOLERANCE.wins)) {
      fail(
        `${tri}: proj_wins + proj_losses = ${(team.proj_wins + team.proj_losses).toFixed(3)}, ` +
          `a season is ${GAMES_PER_TEAM}`,
      );
    }
    if (team.wins_p10 > team.wins_p90) {
      fail(`${tri}: wins_p10 ${team.wins_p10} is above wins_p90 ${team.wins_p90}`);
    }
    if (team.wins_p10 < team.wins) {
      fail(`${tri}: wins_p10 ${team.wins_p10} is below the ${team.wins} already won`);
    }
    if (team.wins_p90 > GAMES_PER_TEAM - team.losses) {
      fail(
        `${tri}: wins_p90 ${team.wins_p90} exceeds the ${GAMES_PER_TEAM - team.losses} still reachable ` +
          `after ${team.losses} losses`,
      );
    }
    // The mean must sit inside the 80% band, which is a real constraint on a
    // unimodal-ish win distribution and the easiest way to catch p10/p90
    // shipped in the wrong units.
    if (team.proj_wins < team.wins_p10 - 1e-9 || team.proj_wins > team.wins_p90 + 1e-9) {
      fail(`${tri}: proj_wins ${team.proj_wins} lies outside its own p10..p90 ${team.wins_p10}..${team.wins_p90}`);
    }

    // Nesting: you cannot win the title without reaching the finals, etc.
    // NEST_EPS, not 1e-9: the sender rounds each probability on its own, so
    // two figures that were equal before rounding can land a thousandth
    // apart in the wrong order. Still a hundred times tighter than any real
    // inversion.
    const eps = NEST_EPS;
    if (team.title_pct > team.finals_pct + eps) {
      fail(`${tri}: title_pct ${team.title_pct} exceeds finals_pct ${team.finals_pct}`);
    }
    if (team.finals_pct > team.conf_finals_pct + eps) {
      fail(`${tri}: finals_pct ${team.finals_pct} exceeds conf_finals_pct ${team.conf_finals_pct}`);
    }
    if (team.conf_finals_pct > team.playoff_pct + eps) {
      fail(`${tri}: conf_finals_pct ${team.conf_finals_pct} exceeds playoff_pct ${team.playoff_pct}`);
    }
    if (team.top6_pct > team.playoff_pct + eps) {
      fail(`${tri}: top6_pct ${team.top6_pct} exceeds playoff_pct ${team.playoff_pct}`);
    }
    // A top-6 seed and a play-in berth are exclusive outcomes.
    if (team.top6_pct + team.playin_pct > 1 + eps) {
      fail(`${tri}: top6_pct + playin_pct = ${(team.top6_pct + team.playin_pct).toFixed(3)} > 1`);
    }
    // You cannot make the playoffs as a 7-10 seed without being in the play-in.
    if (team.playoff_pct > team.top6_pct + team.playin_pct + eps) {
      fail(
        `${tri}: playoff_pct ${team.playoff_pct} exceeds top6_pct + playin_pct ` +
          `${(team.top6_pct + team.playin_pct).toFixed(3)} — a playoff team is a top-6 seed or came through the play-in`,
      );
    }
    teams.push(team);
  }
  const missing = Object.keys(FRANCHISES).filter((t) => !seen.has(t));
  if (missing.length > 0) fail(`missing franchise(s) ${missing.join(", ")}`);

  // League-level identities. One champion; two finalists; four conference
  // finalists; per conference eight playoff teams, six top-6 seeds and four
  // play-in teams; every game produces one win.
  const sum = (rows: RawProjectionTeam[], f: keyof RawProjectionTeam): number =>
    rows.reduce((acc, r) => acc + (r[f] as number), 0);
  const expectSum = (rows: RawProjectionTeam[], f: keyof RawProjectionTeam, want: number, tol: number, label: string) => {
    const got = sum(rows, f);
    if (!nearly(got, want, tol)) {
      fail(`${label} ${String(f)} sums to ${got.toFixed(3)}, expected ${want}`);
    }
  };
  expectSum(teams, "title_pct", 1, SUM_TOLERANCE.pct, "league");
  expectSum(teams, "finals_pct", 2, SUM_TOLERANCE.pct, "league");
  expectSum(teams, "conf_finals_pct", 4, SUM_TOLERANCE.pct, "league");
  expectSum(teams, "proj_wins", LEAGUE_WINS, SUM_TOLERANCE.leagueWins, "league");
  for (const conf of ["East", "West"] as const) {
    const rows = teams.filter((t) => t.conference === conf);
    expectSum(rows, "playoff_pct", 8, SUM_TOLERANCE.pct, conf);
    expectSum(rows, "top6_pct", 6, SUM_TOLERANCE.pct, conf);
    expectSum(rows, "playin_pct", 4, SUM_TOLERANCE.pct, conf);
    expectSum(rows, "finals_pct", 1, SUM_TOLERANCE.pct, conf);
    expectSum(rows, "conf_finals_pct", 2, SUM_TOLERANCE.pct, conf);
  }
  // Games played so far: every completed game gave one team a win and the
  // other a loss, so the league's wins and losses to date are equal.
  if (sum(teams, "wins") !== sum(teams, "losses")) {
    fail(`league wins ${sum(teams, "wins")} != league losses ${sum(teams, "losses")} — every game has one of each`);
  }

  return {
    season_start_year: raw.season_start_year,
    as_of_date: raw.as_of_date,
    generated_at: raw.generated_at,
    replicates: raw.replicates,
    method: raw.method,
    teams,
  };
}

// ---------------------------------------------------------------------------
// Ordering + display
// ---------------------------------------------------------------------------

/**
 * The table order: projected wins, descending; title odds then tri break the
 * ties. NOT the current record — the page is a projection, and today's
 * standings are one tab over.
 */
export function orderForTable<T extends Pick<RawProjectionTeam, "proj_wins" | "title_pct" | "team">>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => b.proj_wins - a.proj_wins || b.title_pct - a.title_pct || a.team.localeCompare(b.team),
  );
}

/** Rows for one conference, in table order. */
export function conferenceTable<T extends RawProjectionTeam>(rows: readonly T[], conference: "East" | "West"): T[] {
  return orderForTable(rows.filter((r) => r.conference === conference));
}

/**
 * A probability as the page prints it. Whole percentages, with the two ends
 * kept honest: a projection that says 0.4% is not "0%", and one that says
 * 99.6% has not promised anything.
 */
export function fmtPct(p: number): string {
  if (p <= 0) return "0%";
  if (p >= 1) return "100%";
  if (p < 0.005) return "<1%";
  if (p > 0.995) return ">99%";
  return `${Math.round(p * 100)}%`;
}

/** "52.3-29.7" — one decimal, the way a projected record is usually quoted. */
export function fmtProjRecord(t: Pick<RawProjectionTeam, "proj_wins" | "proj_losses">): string {
  return `${t.proj_wins.toFixed(1)}-${t.proj_losses.toFixed(1)}`;
}

/** The 80% band on wins, "47–58". */
export function fmtWinRange(t: Pick<RawProjectionTeam, "wins_p10" | "wins_p90">): string {
  return `${t.wins_p10}–${t.wins_p90}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-27" → "Oct 27, 2026". String maths, never a Date round-trip (a
 *  Mountain-time date must not drift a day through UTC). */
export function fmtAsOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}
