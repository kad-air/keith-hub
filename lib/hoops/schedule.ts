// The schedule file's shape rules, and what a PARTIAL slate means
// (`partial_schedule`, 2026-10-28).
//
// Pure: no DB, no fs, imports only the franchise list, so the build gate
// (scripts/check-hoops-partial-schedule.ts) drives the real module and the
// client bundle can import the formatter without dragging anything else in.
//
// WHY THIS EXISTS. The receiver used to demand exactly 1,230 games of every
// push — 30 teams × 82 / 2, an NBA fact — and that single rule kept the hub
// on LAST season's schedule for the whole of October 2026: the 2026-27 slate
// hoops-sim could send had 1,200 real fixtures, every team at exactly 80,
// because the NBA Cup knockout week (the week after group play) is drawn
// from the group results and the league had not drawn it yet. The sender
// could have padded the file with 30 placeholders and sailed through; it
// deliberately did not, because a placeholder game is a lie the matchup page
// would then print as a meeting with a date.
//
// So the contract gained a token. A bundle that declares `partial_schedule`
// may send FEWER than 1,230 games, but it must then account for every one of
// the missing games, per team, and the arithmetic has to close:
//
//     games.length + n_pending                       == 1,230
//     scheduled(team) + pending_per_team[team]        == 82     for all 30
//     Σ pending_per_team                              == 2 × n_pending
//     complete                                        == (n_pending == 0)
//     n_games                                         == games.length
//     pending_window.from <= pending_window.to                 when n_pending > 0
//
// A bundle WITHOUT the token is held to the old exact-1,230 rule, untouched,
// so today's sender keeps importing exactly as it did. Both paths share the
// fixture-level rules a sane validator should have had all along (known
// franchises only, nobody plays itself, no duplicate game id, dates parse).
//
// 🔴 Strict and fail-closed, like every other blob this receiver takes: the
// first problem names itself and nothing is written. A partial slate that
// does not add up is a truncated bundle wearing a token.

import { FRANCHISES } from "./nba-franchises.ts";
import type { RawScheduleFile, RawScheduleGame } from "./types";

export const N_TEAMS = 30;
export const GAMES_PER_TEAM = 82;
/** 30 teams × 82 games, each game counted once — an NBA fact. */
export const N_SEASON_GAMES = (N_TEAMS * GAMES_PER_TEAM) / 2;

const KNOWN_TRIS: ReadonlySet<string> = new Set(Object.keys(FRANCHISES));

export class ScheduleRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleRejection";
  }
}

function fail(msg: string): never {
  throw new ScheduleRejection(`hoops_schedule.json: ${msg}`);
}

/** The window the missing games fall in, as the sender states it. `why` is
 *  rendered verbatim, the `method` precedent from the projection. */
export interface PendingWindow {
  from: string;
  to: string;
  why: string;
}

/** What the hub knows about how whole the stored schedule is. */
export interface ScheduleStatus {
  complete: boolean;
  /** Games the league has not scheduled yet; 0 when the slate is whole. */
  nPending: number;
  /** Present exactly when nPending > 0 and the sender said where they fall. */
  pendingWindow: PendingWindow | null;
}

export const COMPLETE_SCHEDULE: ScheduleStatus = Object.freeze({
  complete: true,
  nPending: 0,
  pendingWindow: null,
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** A real YYYY-MM-DD, not just something Date.parse will swallow. */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

/**
 * Validate the schedule file. `partial` is whether the bundle DECLARED
 * `partial_schedule` — the file's own fields are read only under the token,
 * exactly as projections.json is read only under its token. Returns the
 * status the importer stores; throws ScheduleRejection naming the first
 * problem. Never mutates its input.
 */
export function validateSchedule(file: unknown, opts: { partial: boolean }): ScheduleStatus {
  if (!isPlainObject(file)) fail("expected an object");
  const games = file.games;
  if (!Array.isArray(games)) fail("missing `games`");

  // ── the fixtures themselves, token or not ───────────────────────────────
  const scheduled = new Map<string, number>();
  for (const t of KNOWN_TRIS) scheduled.set(t, 0);
  const ids = new Set<string>();
  for (const raw of games as unknown[]) {
    if (!isPlainObject(raw)) fail("a game is not an object");
    const g = raw as unknown as RawScheduleGame;
    if (typeof g.game_id !== "string" || g.game_id.length === 0) fail("a game has no game_id");
    if (ids.has(g.game_id)) fail(`duplicate game_id ${g.game_id}`);
    ids.add(g.game_id);
    if (!KNOWN_TRIS.has(g.home)) fail(`${g.game_id}: unknown home team ${String(g.home)}`);
    if (!KNOWN_TRIS.has(g.away)) fail(`${g.game_id}: unknown away team ${String(g.away)}`);
    if (g.home === g.away) fail(`${g.game_id}: ${g.home} is playing itself`);
    if (!isCalendarDate(g.date)) fail(`${g.game_id}: date ${String(g.date)} is not YYYY-MM-DD`);
    scheduled.set(g.home, scheduled.get(g.home)! + 1);
    scheduled.set(g.away, scheduled.get(g.away)! + 1);
  }
  if (file.n_games !== games.length) {
    fail(`n_games says ${String(file.n_games)} but games has ${games.length}`);
  }

  // ── without the token: the old exact rule, untouched ────────────────────
  if (!opts.partial) {
    if (games.length !== N_SEASON_GAMES) {
      fail(`${games.length} games, an NBA regular season is ${N_SEASON_GAMES}`);
    }
    const wrong = [...scheduled].filter(([, n]) => n !== GAMES_PER_TEAM);
    if (wrong.length > 0) {
      fail(
        `${wrong.map(([t, n]) => `${t}=${n}`).join(", ")} — every team plays ${GAMES_PER_TEAM}`,
      );
    }
    return COMPLETE_SCHEDULE;
  }

  // ── with the token: every missing game accounted for ────────────────────
  if (typeof file.complete !== "boolean") fail("partial_schedule declared but `complete` is not a boolean");
  if (!isNonNegInt(file.n_pending)) fail("partial_schedule declared but `n_pending` is not a non-negative integer");
  const nPending = file.n_pending;
  if (!isPlainObject(file.pending_per_team)) fail("partial_schedule declared but `pending_per_team` is missing");
  const perTeam = file.pending_per_team;
  const keys = Object.keys(perTeam);
  const missing = [...KNOWN_TRIS].filter((t) => !(t in perTeam));
  if (missing.length > 0) fail(`pending_per_team is missing ${missing.join(", ")}`);
  const unknown = keys.filter((t) => !KNOWN_TRIS.has(t));
  if (unknown.length > 0) fail(`pending_per_team has unknown team(s) ${unknown.join(", ")}`);
  for (const t of keys) {
    if (!isNonNegInt(perTeam[t])) fail(`pending_per_team.${t} is not a non-negative integer`);
  }

  if (games.length + nPending !== N_SEASON_GAMES) {
    fail(
      `${games.length} scheduled + ${nPending} pending = ${games.length + nPending}, ` +
        `an NBA regular season is ${N_SEASON_GAMES}`,
    );
  }
  const short = [...KNOWN_TRIS]
    .map((t) => ({ t, s: scheduled.get(t)!, p: perTeam[t] as number }))
    .filter(({ s, p }) => s + p !== GAMES_PER_TEAM);
  if (short.length > 0) {
    fail(
      short.map(({ t, s, p }) => `${t} ${s} scheduled + ${p} pending = ${s + p}`).join(", ") +
        ` — every team plays ${GAMES_PER_TEAM}`,
    );
  }
  // Implied by the two rules above (Σ pending = 2,460 − 2 × scheduled =
  // 2 × n_pending), so it can never be the FIRST to fire — kept as the
  // contract's own restatement, and the gate says so rather than pretending
  // falsification convicted its removal.
  const pendingSum = keys.reduce((acc, t) => acc + (perTeam[t] as number), 0);
  if (pendingSum !== 2 * nPending) {
    fail(`pending_per_team sums to ${pendingSum}, n_pending ${nPending} means ${2 * nPending} team-games`);
  }
  if (file.complete !== (nPending === 0)) {
    fail(`complete is ${String(file.complete)} with n_pending ${nPending}`);
  }

  let pendingWindow: PendingWindow | null = null;
  if (nPending > 0) {
    const w = file.pending_window;
    if (!isPlainObject(w)) fail(`n_pending is ${nPending} but pending_window is missing`);
    if (!isCalendarDate(w.from)) fail(`pending_window.from ${String(w.from)} is not YYYY-MM-DD`);
    if (!isCalendarDate(w.to)) fail(`pending_window.to ${String(w.to)} is not YYYY-MM-DD`);
    if (w.from > w.to) fail(`pending_window runs backwards (${w.from} to ${w.to})`);
    if (typeof w.why !== "string" || w.why.trim().length === 0) fail("pending_window.why is empty");
    pendingWindow = { from: w.from, to: w.to, why: w.why.trim() };
  }

  return { complete: nPending === 0, nPending, pendingWindow };
}

/**
 * The status to STORE for a file that has already been validated under the
 * given token state — the importer's read, kept beside the validator so the
 * two can't drift about which fields mean what. Without the token the file's
 * own fields are ignored and the schedule is whole by the old rule.
 */
export function scheduleStatusOf(file: RawScheduleFile, partial: boolean): ScheduleStatus {
  if (!partial) return COMPLETE_SCHEDULE;
  const nPending = typeof file.n_pending === "number" ? file.n_pending : 0;
  const w = file.pending_window;
  return {
    complete: nPending === 0,
    nPending,
    pendingWindow:
      nPending > 0 && w && typeof w.from === "string" && typeof w.to === "string"
        ? { from: w.from, to: w.to, why: typeof w.why === "string" ? w.why.trim() : "" }
        : null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12-04" to "2026-12-11" → "Dec 4 to 11"; across months "Dec 28 to Jan 3".
 *  String maths, never a Date round-trip (the HoopsNav rule). */
export function fmtPendingWindow(w: Pick<PendingWindow, "from" | "to">): string {
  const [, fm, fd] = w.from.split("-").map(Number);
  const [, tm, td] = w.to.split("-").map(Number);
  const a = `${MONTHS[(fm ?? 1) - 1]} ${fd}`;
  if (w.from === w.to) return a;
  return fm === tm ? `${a} to ${td}` : `${a} to ${MONTHS[(tm ?? 1) - 1]} ${td}`;
}

/**
 * The one line every schedule surface prints for a partial slate, so the
 * Teams footer and the matchup's head-to-head cannot phrase it two ways:
 * "30 games not scheduled yet (Dec 4 to 11)". The sender's `why` is appended
 * verbatim by the caller where there is room. Null when nothing is pending.
 */
export function pendingNote(status: ScheduleStatus): string | null {
  if (status.nPending <= 0) return null;
  const n = status.nPending;
  const head = `${n} game${n === 1 ? "" : "s"} not scheduled yet`;
  return status.pendingWindow ? `${head} (${fmtPendingWindow(status.pendingWindow)})` : head;
}
