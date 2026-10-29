#!/usr/bin/env node
//
// THE PARTIAL SCHEDULE — the receiver half of `partial_schedule`.
//
//   npm run check:hoops:partial-schedule   (standalone)
//   npm run build                          (runs via prebuild)
//
// WHAT THIS PROVES. The receiver used to demand exactly 1,230 games of every
// push, and that one rule kept the hub on LAST season's schedule for the
// whole of October 2026: the real 2026-27 slate had 1,200 fixtures, every
// team at exactly 80, because the NBA Cup knockout week is drawn from the
// group results and the league had not drawn it yet. Under the token a
// bundle may be short, but only if it accounts for every missing game and
// the arithmetic closes to 82 a team. The ways this can quietly go wrong:
//
//   • the validator lets a slate through that does NOT add up — a team at 81
//     scheduled with 2 pending, a pending sum that is not twice n_pending,
//     `complete: true` with games still owed, a window that runs backwards —
//     and the pages count it as if it were the season,
//   • a bundle WITHOUT the token stops importing (receiver-first deploy order
//     makes that the sender's outage, on this receiver's deploy), or a short
//     bundle WITHOUT the token starts importing (the old rule silently gone),
//   • the importer drops the status on the floor, so the pages say nothing,
//   • a page note hardcodes "30" or "Dec 4" instead of reading what is stored
//     (the sender said its window is derived from ESPN's TBD rows and can
//     change).
//
// Second source: the arithmetic of an NBA season, written down here a second
// time and asserted over the raw fixture WITHOUT the validator (1,230 games,
// 82 a team, 30 franchises per nba-franchises.ts), so the fixture is anchored
// on facts independent of the code under test. The fixture is the committed
// 1,230-game schedule with a 30-game cycle removed (team i vs team i+1), so
// every team sits at 80 scheduled + 2 pending — the shape of the real slate.
//
// Falsification at merge (2026-10-28): see CLAUDE.md's partial-schedule
// section for the tally.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  FEATURE_FILES,
  SUPPORTED_FEATURES,
  checkFeatures,
  checkFeatureFiles,
  describeContract,
} from "../lib/hoops/contract.ts";
import { FRANCHISES } from "../lib/hoops/nba-franchises.ts";
import {
  COMPLETE_SCHEDULE,
  GAMES_PER_TEAM,
  N_SEASON_GAMES,
  N_TEAMS,
  ScheduleRejection,
  fmtPendingWindow,
  isCalendarDate,
  pendingNote,
  scheduleStatusOf,
  validateSchedule,
} from "../lib/hoops/schedule.ts";
import { BundleRejection, validatePushedBundle } from "../lib/hoops/bundleValidation.ts";
import type { HoopsBundle, RawScheduleFile } from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "hoops-data", "hoops_partial_schedule_fixture.json");

const problems: string[] = [];
const notes: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) problems.push(msg);
};

const TRIS = Object.keys(FRANCHISES).sort();
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "hoops-data", f), "utf-8"));
const fixtureRaw = read("hoops_partial_schedule_fixture.json") as RawScheduleFile;
const fullRaw = read("hoops_schedule.json") as RawScheduleFile;
/** Deep copies to damage. */
const partial = (): RawScheduleFile => JSON.parse(JSON.stringify(fixtureRaw));
const full = (): RawScheduleFile => JSON.parse(JSON.stringify(fullRaw));

// ── 1. the fixture, longhand, without the validator ───────────────────────
{
  check(TRIS.length === N_TEAMS && N_SEASON_GAMES === 1230 && GAMES_PER_TEAM === 82, "the NBA constants moved");
  const games = fixtureRaw.games;
  const per: Record<string, number> = Object.fromEntries(TRIS.map((t) => [t, 0]));
  const ids = new Set<string>();
  for (const g of games) {
    check(!ids.has(g.game_id), `fixture: duplicate game_id ${g.game_id}`);
    ids.add(g.game_id);
    check(g.home !== g.away, `fixture: ${g.game_id} has a team playing itself`);
    check(g.home in per && g.away in per, `fixture: ${g.game_id} names an unknown team`);
    check(/^\d{4}-\d{2}-\d{2}$/.test(g.date), `fixture: ${g.game_id} date ${g.date}`);
    per[g.home]++;
    per[g.away]++;
  }
  check(games.length === 1200, `fixture has ${games.length} games, expected 1200`);
  check(fixtureRaw.n_games === games.length, "fixture n_games disagrees with games");
  check(fixtureRaw.n_pending === 30 && fixtureRaw.complete === false, "fixture: 30 pending, not complete");
  check(games.length + fixtureRaw.n_pending! === 1230, "fixture: scheduled + pending != 1230");
  const ppt = fixtureRaw.pending_per_team!;
  check(Object.keys(ppt).length === 30, "fixture: pending_per_team is not 30 keys");
  check(TRIS.every((t) => per[t] === 80 && ppt[t] === 2), "fixture: not every team is 80 scheduled + 2 pending");
  check(Object.values(ppt).reduce((a, b) => a + b, 0) === 60, "fixture: pending sum != 60");
  check(fixtureRaw.pending_window!.from <= fixtureRaw.pending_window!.to, "fixture: window runs backwards");
  // The fixture is the committed schedule minus 30 games: every fixture game
  // is a real committed game, byte for byte.
  const byId = new Map(fullRaw.games.map((g) => [g.game_id, g]));
  check(
    games.every((g) => JSON.stringify(byId.get(g.game_id)) === JSON.stringify(g)),
    "fixture: a game is not a committed-schedule game",
  );
  check(fullRaw.games.length === 1230, "the committed schedule is not 1,230 games");
  notes.push("fixture: 1,200 real fixtures, every team 80 + 2 pending, Σ pending 60 = 2 × 30 — written longhand");
}

// ── 2. the contract: the token is accepted, no file is demanded with it ───
{
  check(SUPPORTED_FEATURES.has("partial_schedule"), "SUPPORTED_FEATURES lacks partial_schedule");
  check(!("partial_schedule" in FEATURE_FILES), "partial_schedule demands a file — the contract says no new file");
  const d = describeContract();
  check(d.features.includes("partial_schedule"), "describeContract().features omits partial_schedule");
  check(!("partial_schedule" in d.feature_files), "describeContract().feature_files lists partial_schedule");
  let threw = false;
  try {
    checkFeatures(["symmetric_off_def", "absorption", "partial_schedule"]);
    checkFeatureFiles(["partial_schedule"], {});
  } catch {
    threw = true;
  }
  check(!threw, "a bundle declaring partial_schedule (and no extra file) is refused by the contract");
  // The v1 contract block, exactly as today's sender declares it.
  threw = false;
  try {
    checkFeatures(["symmetric_off_def", "absorption"]);
  } catch {
    threw = true;
  }
  check(!threw, "the v1 contract no longer passes checkFeatures");
  notes.push(`contract: GET discovery lists ${d.features.length} features incl. partial_schedule; no file demanded`);
}

// ── 3. the validator accepts the fixture under the token ──────────────────
{
  let status;
  try {
    status = validateSchedule(fixtureRaw, { partial: true });
  } catch (e) {
    check(false, `validator refused the fixture: ${(e as Error).message}`);
  }
  if (status) {
    check(status.complete === false && status.nPending === 30, "status off the fixture is not 30 pending");
    check(
      status.pendingWindow?.from === fixtureRaw.pending_window!.from &&
        status.pendingWindow?.to === fixtureRaw.pending_window!.to &&
        status.pendingWindow?.why === fixtureRaw.pending_window!.why,
      "status did not carry the window through",
    );
  }
  // A WHOLE slate under the token: complete true, n_pending 0, zeros, and —
  // per the sender — pending_window may be null.
  const whole: RawScheduleFile = {
    ...full(),
    complete: true,
    n_pending: 0,
    pending_per_team: Object.fromEntries(TRIS.map((t) => [t, 0])),
    pending_window: null,
  };
  try {
    const s = validateSchedule(whole, { partial: true });
    check(s.complete && s.nPending === 0 && s.pendingWindow === null, "a whole slate under the token is not complete");
  } catch (e) {
    check(false, `a whole 1,230 slate under the token was refused: ${(e as Error).message}`);
  }
  // And the same file with the window simply omitted.
  const { pending_window: _w, ...wholeNoWindow } = whole;
  try {
    validateSchedule(wholeNoWindow, { partial: true });
  } catch (e) {
    check(false, `a whole slate without a pending_window key was refused: ${(e as Error).message}`);
  }
  notes.push("validator: accepts the 1,200-game fixture and a whole 1,230 slate (window null or absent) under the token");
}

// ── 4. without the token: the old exact rule, untouched ───────────────────
{
  try {
    const s = validateSchedule(fullRaw, { partial: false });
    check(s === COMPLETE_SCHEDULE, "the committed schedule without the token is not COMPLETE_SCHEDULE");
  } catch (e) {
    check(false, `the committed 1,230 schedule is refused without the token: ${(e as Error).message}`);
  }
  let msg = "";
  try {
    validateSchedule(fixtureRaw, { partial: false });
  } catch (e) {
    msg = (e as Error).message;
  }
  check(
    /1200 games, an NBA regular season is 1230/.test(msg),
    `a 1,200-game file WITHOUT the token must be refused by the exact rule; got: ${msg || "(accepted)"}`,
  );
  // The fields are ignored without the token, in both directions.
  check(scheduleStatusOf(fixtureRaw, false) === COMPLETE_SCHEDULE, "scheduleStatusOf reads the fields without the token");
  check(scheduleStatusOf(fixtureRaw, true).nPending === 30, "scheduleStatusOf ignores the fields with the token");
  notes.push("without the token: 1,230 accepted, 1,200 refused by the exact rule, the partial fields ignored");
}

// ── 5. every damage pattern, refused for its named reason ─────────────────
{
  const damage: Array<{ name: string; make: () => unknown; expect: RegExp }> = [
    {
      name: "wrong total (one game dropped, n_pending unchanged)",
      make: () => {
        const f = partial();
        f.games = f.games.slice(1);
        f.n_games = f.games.length;
        return f;
      },
      expect: /1199 scheduled \+ 30 pending = 1229/,
    },
    {
      name: "one team at 81 scheduled with 2 pending (a game moved onto another pair)",
      make: () => {
        const f = partial();
        // Re-point one game: its away team becomes a third team, so one team
        // drops to 79 and another rises to 81 while the total stays 1,200.
        const g = f.games.find((x) => x.home === "DEN" && x.away !== "OKC" && x.away !== "BOS")!;
        const third = TRIS.find((t) => t !== g.home && t !== g.away)!;
        g.away = third;
        return f;
      },
      expect: /scheduled \+ 2 pending = 8[13].*every team plays 82/,
    },
    {
      name: "pending sum not 2 × n_pending",
      make: () => {
        const f = partial();
        f.pending_per_team!.DEN = 3;
        f.pending_per_team!.OKC = 1;
        return f;
      },
      // DEN 80+3 = 83 trips the per-team rule first; that is the right order
      // (name the team), and the sum rule is reached by the next case.
      expect: /DEN 80 scheduled \+ 3 pending = 83/,
    },
    // 🔴 Stated, not smoothed: the sum rule is IMPLIED by the other two. If
    // every team's scheduled + pending is 82 and scheduled + n_pending is
    // 1,230, then Σ pending = 2,460 − 2 × scheduled = 2 × n_pending, so no
    // input can trip the sum rule alone and falsification cannot convict its
    // removal (the probe was run; it passed). It stays as a cheap restatement
    // of the contract, and these two cases pin that a sum that is wrong is
    // refused — by whichever of the three rules names it first.
    {
      name: "pending sum not 2 × n_pending (per-team consistent, n_pending lies)",
      make: () => {
        const f = partial();
        f.n_pending = 29;
        f.games.push({ ...f.games[0], game_id: "0022599999" });
        f.n_games = f.games.length;
        return f;
      },
      expect: /every team plays 82|pending_per_team sums to 60, n_pending 29 means 58/,
    },
    {
      name: "complete: true with n_pending > 0",
      make: () => ({ ...partial(), complete: true }),
      expect: /complete is true with n_pending 30/,
    },
    {
      name: "complete: false with n_pending 0 on a whole slate",
      make: () => ({
        ...full(),
        complete: false,
        n_pending: 0,
        pending_per_team: Object.fromEntries(TRIS.map((t) => [t, 0])),
      }),
      expect: /complete is false with n_pending 0/,
    },
    {
      name: "missing team key in pending_per_team",
      make: () => {
        const f = partial();
        delete f.pending_per_team!.MIA;
        return f;
      },
      expect: /pending_per_team is missing MIA/,
    },
    {
      name: "unknown team key in pending_per_team",
      make: () => {
        const f = partial();
        f.pending_per_team!.SEA = 0;
        return f;
      },
      expect: /pending_per_team has unknown team\(s\) SEA/,
    },
    {
      name: "negative pending",
      make: () => {
        const f = partial();
        f.pending_per_team!.DEN = -2;
        return f;
      },
      expect: /pending_per_team\.DEN is not a non-negative integer/,
    },
    {
      name: "duplicate game_id",
      make: () => {
        const f = partial();
        f.games[5] = { ...f.games[5], game_id: f.games[4].game_id };
        return f;
      },
      expect: /duplicate game_id/,
    },
    {
      name: "team playing itself",
      make: () => {
        const f = partial();
        f.games[7] = { ...f.games[7], away: f.games[7].home };
        return f;
      },
      expect: /is playing itself/,
    },
    {
      name: "unknown franchise in a game",
      make: () => {
        const f = partial();
        f.games[9] = { ...f.games[9], home: "SEA" };
        return f;
      },
      expect: /unknown home team SEA/,
    },
    {
      name: "bad window date",
      make: () => {
        const f = partial();
        f.pending_window = { ...f.pending_window!, to: "2025-12-32" };
        return f;
      },
      expect: /pending_window\.to 2025-12-32 is not YYYY-MM-DD/,
    },
    {
      name: "window runs backwards",
      make: () => {
        const f = partial();
        f.pending_window = { ...f.pending_window!, from: "2025-12-20" };
        return f;
      },
      expect: /pending_window runs backwards/,
    },
    {
      name: "window missing while games are pending",
      make: () => {
        const f = partial();
        delete f.pending_window;
        return f;
      },
      expect: /n_pending is 30 but pending_window is missing/,
    },
    {
      name: "window with an empty why",
      make: () => {
        const f = partial();
        f.pending_window = { ...f.pending_window!, why: "  " };
        return f;
      },
      expect: /pending_window\.why is empty/,
    },
    {
      name: "n_games disagrees with games",
      make: () => ({ ...partial(), n_games: 1230 }),
      expect: /n_games says 1230 but games has 1200/,
    },
    {
      name: "a game date that is not a calendar date",
      make: () => {
        const f = partial();
        f.games[3] = { ...f.games[3], date: "2025-02-30" };
        return f;
      },
      expect: /date 2025-02-30 is not YYYY-MM-DD/,
    },
    {
      name: "token declared but the partial fields absent (today's file shape, 1,200 games)",
      make: () => {
        const f = partial();
        delete f.complete;
        delete f.n_pending;
        delete f.pending_per_team;
        delete f.pending_window;
        return f;
      },
      expect: /`complete` is not a boolean/,
    },
    {
      name: "n_pending a string",
      make: () => ({ ...partial(), n_pending: "30" }),
      expect: /`n_pending` is not a non-negative integer/,
    },
  ];
  let caught = 0;
  for (const d of damage) {
    let msg = "";
    let kind = "";
    try {
      validateSchedule(d.make(), { partial: true });
    } catch (e) {
      msg = (e as Error).message;
      kind = (e as Error).name;
    }
    if (!msg) {
      problems.push(`damage "${d.name}" was ACCEPTED`);
    } else if (kind !== "ScheduleRejection") {
      problems.push(`damage "${d.name}" threw ${kind}, not ScheduleRejection: ${msg}`);
    } else if (!d.expect.test(msg)) {
      problems.push(`damage "${d.name}" refused for the wrong reason: ${msg}`);
    } else {
      caught++;
    }
  }
  check(new ScheduleRejection("x").name === "ScheduleRejection", "ScheduleRejection has the wrong name");
  notes.push(`damage: ${caught}/${damage.length} patterns refused, each for its named reason`);
}

// ── 6. the real validatePushedBundle, with and without the option ─────────
{
  const bundle: HoopsBundle = {
    params: read("hoops_params.json"),
    teams: read("hoops_teams.json"),
    players: read("hoops_players.json"),
    schedule: read("hoops_schedule.json"),
    results: read("hoops_results.json"),
    lines: read("hoops_lines.json"),
  };
  const attempt = (b: HoopsBundle, opts?: { partialSchedule?: boolean }): string => {
    try {
      validatePushedBundle(b, opts);
      return "";
    } catch (e) {
      return e instanceof BundleRejection ? e.message : `WRONG TYPE ${(e as Error).name}: ${(e as Error).message}`;
    }
  };
  check(attempt(bundle) === "", `the committed bundle no longer validates: ${attempt(bundle)}`);
  check(attempt(bundle, { partialSchedule: false }) === "", "the committed bundle fails with partialSchedule:false");
  const shortBundle = { ...bundle, schedule: fixtureRaw };
  const refused = attempt(shortBundle);
  check(/1200 games, an NBA regular season is 1230/.test(refused), `a 1,200-game bundle without the option: ${refused || "(accepted)"}`);
  check(attempt(shortBundle, { partialSchedule: true }) === "", `the fixture bundle with the option: ${attempt(shortBundle, { partialSchedule: true })}`);
  // A damaged schedule under the option comes back as a BundleRejection (the
  // route prefixes "invalid bundle:"), not a bare ScheduleRejection.
  const damaged = { ...bundle, schedule: { ...partial(), complete: true } };
  check(/complete is true with n_pending 30/.test(attempt(damaged, { partialSchedule: true })), "a damaged partial slate is not a BundleRejection naming the problem");
  notes.push("validatePushedBundle: exact rule without the option, the arithmetic with it, rejections typed for the route");
}

// ── 7. the formatter: the note is built from the data, never a literal ────
{
  check(pendingNote(COMPLETE_SCHEDULE) === null, "a complete schedule has a note");
  check(
    pendingNote({ complete: false, nPending: 30, pendingWindow: { from: "2026-12-04", to: "2026-12-08", why: "x" } }) ===
      "30 games not scheduled yet (Dec 4 to 8)",
    "the sender's real window does not format as 'Dec 4 to 8'",
  );
  check(
    pendingNote({ complete: false, nPending: 1, pendingWindow: { from: "2026-12-28", to: "2027-01-03", why: "x" } }) ===
      "1 game not scheduled yet (Dec 28 to Jan 3)",
    "a cross-month window or the singular does not format",
  );
  check(pendingNote({ complete: false, nPending: 4, pendingWindow: null }) === "4 games not scheduled yet", "a note without a window");
  check(fmtPendingWindow({ from: "2026-12-04", to: "2026-12-04" }) === "Dec 4", "a one-day window");
  check(isCalendarDate("2026-02-29") === false && isCalendarDate("2028-02-29") === true, "isCalendarDate leap years");
  // Nothing on the pages hardcodes the count or the month — the note comes
  // from the stored status through pendingNote.
  for (const f of ["components/hoops/TeamsClient.tsx", "components/hoops/MatchupClient.tsx"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
    check(/pendingNote\(/.test(src), `${f} does not render the schedule note through pendingNote`);
    check(!/NBA Cup|Dec \d|30 games/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f} hardcodes the pending count or dates`);
  }
  notes.push("formatter: '30 games not scheduled yet (Dec 4 to 8)' from data; both pages render through it, nothing hardcoded");
}

// ── 8. the read model: schema, the real importer, the stored status ───────
{
  const importer = fs.readFileSync(path.join(ROOT, "lib/hoops/import.ts"), "utf-8");
  check(/scheduleSettled/.test(importer) && /hasScheduleStatus/.test(importer), "the importer has no schedule-status no-op marker");
  const noop = importer.slice(importer.indexOf("if (\n    !force &&"), importer.indexOf("writeBundle(db, bundle, {"));
  check(/scheduleSettled/.test(noop), "scheduleSettled is declared but not in the seed path's no-op condition");
  const route = fs.readFileSync(path.join(ROOT, "app/api/hoops/import/route.ts"), "utf-8");
  check(/validatePushedBundle\(bundle, \{ partialSchedule \}\)/.test(route), "the route does not pass the token state to the validator");
  check(/contract\.features\.includes\("partial_schedule"\)/.test(route), "the route does not read the token");
  const routeNoop = route.slice(route.indexOf("if (existing && existing.content_hash === contentHash"), route.indexOf("return NextResponse.json({\n      imported: false"));
  check(route.includes("if (existing && existing.content_hash === contentHash"), "the route's rule-6 no-op moved — re-anchor this check");
  check(/scheduleSettled/.test(routeNoop), "the route's rule-6 no-op does not consider an unset schedule status");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-partial-schedule-check-"));
  const cwd = process.cwd();
  let db: import("better-sqlite3").Database | null = null;
  try {
    process.chdir(tmp);
    const { getDb } = await import(path.join(ROOT, "lib/db.ts"));
    db = getDb() as import("better-sqlite3").Database;
    const { importPushedBundle } = await import(path.join(ROOT, "lib/hoops/import.ts"));
    const { scheduleStatusFromRow } = await import(path.join(ROOT, "lib/hoops/queries.ts"));

    const cols = (db.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["schedule_complete", "schedule_n_pending", "schedule_pending_from", "schedule_pending_to", "schedule_pending_why", "schedule_season_start_year"]) {
      check(cols.includes(c), `lib/db.ts: hoops_params has no ${c}`);
    }

    const bundle: HoopsBundle = {
      params: read("hoops_params.json"),
      teams: read("hoops_teams.json"),
      players: read("hoops_players.json"),
      schedule: fixtureRaw,
      results: read("hoops_results.json"),
      lines: read("hoops_lines.json"),
    };
    const meta = (hash: string, features: string[]) => ({
      hash,
      generatedAt: "2026-10-28T10:00:00Z",
      pricingVersion: 1,
      features,
      constants: { ...(bundle.params.constants as unknown as Record<string, unknown>), replacement_per36: bundle.players.replacement_per36 },
    });
    const rowSql = `SELECT schedule_complete, schedule_n_pending, schedule_pending_from, schedule_pending_to, schedule_pending_why, schedule_season_start_year FROM hoops_params WHERE id = 1`;
    type Row = {
      schedule_complete: number | null;
      schedule_n_pending: number | null;
      schedule_pending_from: string | null;
      schedule_pending_to: string | null;
      schedule_pending_why: string | null;
      schedule_season_start_year: number | null;
    };

    // A partial push.
    const s1 = importPushedBundle(bundle, meta("sha256:partial", ["symmetric_off_def", "absorption", "partial_schedule"]));
    check(s1.imported && s1.counts.schedule === 1200, `the partial bundle did not import 1,200 schedule rows (${s1.counts.schedule})`);
    const n1 = (db.prepare(`SELECT COUNT(*) AS n FROM hoops_schedule`).get() as { n: number }).n;
    check(n1 === 1200, `hoops_schedule holds ${n1} rows after the partial push`);
    const r1 = db.prepare(rowSql).get() as Row;
    check(r1.schedule_complete === 0 && r1.schedule_n_pending === 30, `stored status after the partial push: ${JSON.stringify(r1)}`);
    check(r1.schedule_pending_from === fixtureRaw.pending_window!.from && r1.schedule_pending_to === fixtureRaw.pending_window!.to, "the window did not land");
    check(r1.schedule_pending_why === fixtureRaw.pending_window!.why, "the why did not land verbatim");
    check(r1.schedule_season_start_year === fixtureRaw.season_start_year, "season_start_year did not land");
    const st1 = scheduleStatusFromRow(r1);
    check(st1.complete === false && st1.nPending === 30 && pendingNote(st1) === "30 games not scheduled yet (Dec 9 to 16)", `the page reads ${JSON.stringify(st1)}`);

    // The same partial FILE pushed WITHOUT the token — the route would have
    // refused it, but the importer's read must not trust the fields either:
    // the status is decided by the token, so this stores "complete".
    // (Falsification found the first draft pushing the FULL file here, which
    // has no fields to mistrust — an importer that read them anyway passed.)
    importPushedBundle(bundle, meta("sha256:fields-no-token", ["symmetric_off_def", "absorption"]));
    const r1b = db.prepare(rowSql).get() as Row;
    check(r1b.schedule_complete === 1 && r1b.schedule_n_pending === 0 && r1b.schedule_pending_from === null, `the fixture without the token stored ${JSON.stringify(r1b)} — the importer read the fields`);

    // A full push without the token: complete, 1,230 rows, no note.
    importPushedBundle({ ...bundle, schedule: read("hoops_schedule.json") }, meta("sha256:full", ["symmetric_off_def", "absorption"]));
    const r2 = db.prepare(rowSql).get() as Row;
    check(r2.schedule_complete === 1 && r2.schedule_n_pending === 0 && r2.schedule_pending_from === null, `a full push without the token stored ${JSON.stringify(r2)}`);
    check(scheduleStatusFromRow(r2).complete === true && pendingNote(scheduleStatusFromRow(r2)) === null, "a whole schedule still shows a note");
    const n2 = (db.prepare(`SELECT COUNT(*) AS n FROM hoops_schedule`).get() as { n: number }).n;
    check(n2 === 1230, `hoops_schedule holds ${n2} rows after the full push`);

    // A pre-migration row (NULL) reads complete, never a note.
    const nullRow: Row = { schedule_complete: null, schedule_n_pending: null, schedule_pending_from: null, schedule_pending_to: null, schedule_pending_why: null, schedule_season_start_year: null };
    check(scheduleStatusFromRow(nullRow) === COMPLETE_SCHEDULE, "a NULL row does not read as complete");

    // A whole slate under the token, window null: complete, no window stored.
    const whole: RawScheduleFile = { ...read("hoops_schedule.json"), complete: true, n_pending: 0, pending_per_team: Object.fromEntries(TRIS.map((t) => [t, 0])), pending_window: null };
    importPushedBundle({ ...bundle, schedule: whole }, meta("sha256:whole", ["symmetric_off_def", "absorption", "partial_schedule"]));
    const r3 = db.prepare(rowSql).get() as Row;
    check(r3.schedule_complete === 1 && r3.schedule_n_pending === 0 && r3.schedule_pending_from === null, `a whole slate under the token stored ${JSON.stringify(r3)}`);

    // The read model's other tables are intact after three pushes.
    const teamCount = (db.prepare(`SELECT COUNT(*) AS n FROM hoops_teams`).get() as { n: number }).n;
    check(teamCount === 30, `the read model has ${teamCount} teams after three imports`);
    notes.push("read model: six columns present; the real importer stores 1,200 rows + the status on a partial push, complete on a full one, and ignores the fields without the token");
  } finally {
    db?.close();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── report ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error("hoops partial-schedule check: FAIL");
  for (const p of problems.slice(0, 12)) console.error(`  ✗ ${p}`);
  if (problems.length > 12) console.error(`  … and ${problems.length - 12} more`);
  process.exit(1);
}
console.log("hoops partial-schedule check: PASS");
