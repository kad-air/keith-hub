#!/usr/bin/env node
//
// THE PROJECTION'S SEASON — the receiver half of `projection_history`, and the
// sim team page's Projection card.
//
//   npm run check:hoops:projection-history   (standalone)
//   npm run build                            (runs via prebuild)
//
// WHAT THIS PROVES. The team page draws a line of how a team's projection moved
// night by night. Every way that can go quietly wrong still draws a plausible
// line:
//
//   • the validator lets a broken night through (a percentage for a fraction,
//     Σ title ≠ 1 on one date, nights out of order or doubled, a record that
//     goes BACKWARDS from one night to the next) and the line shows it,
//   • a bundle WITHOUT the token stops importing (receiver-first deploy order),
//     or one WITH it but no file is accepted,
//   • the importer forgets to record each pushed projections.json as a night
//     (the line never grows), or the history file appends instead of replacing
//     (rebuilt nights doubled under nightly ones), or a push without either
//     wipes the line,
//   • the chart's maths is upside down (more wins drawn LOWER), the band does
//     not contain the line, or time runs right-to-left,
//   • the card's sentence calls a falling team "playing above" expectations.
//
// Second source: an NBA record only ever grows, and Σ title = 1 every night —
// both written down here a second time over the raw fixture, not via the
// validator, before the validator is asked anything.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  ContractRejection,
  FEATURE_FILES,
  SUPPORTED_FEATURES,
  checkFeatureFiles,
  checkFeatures,
  describeContract,
} from "../lib/hoops/contract.ts";
import { validateProjections } from "../lib/hoops/projections.ts";
import {
  MAX_SNAPSHOTS,
  ProjectionHistoryRejection,
  VERDICT_WINS,
  dayNumber,
  fmtPctPoints,
  fmtWinsDelta,
  trendChart,
  trendPointOf,
  trendSummary,
  trendVerdict,
  validateProjectionHistory,
} from "../lib/hoops/projectionHistory.ts";
import type { TrendPoint } from "../lib/hoops/projectionHistory.ts";
import type {
  HoopsBundle,
  RawProjectionHistoryFile,
  RawProjectionSnapshot,
  RawProjectionsFile,
} from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "hoops-data", "hoops_projections_fixture.json");

const problems: string[] = [];
const notes: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) problems.push(msg);
};

const base = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as RawProjectionsFile;

// ── the fixture: three nights built from the committed projection fixture ──
// Night 1 is the fixture as committed. Night 2 adds one game: the fixture's
// first team beats its second (record +1 win / +1 loss), and that winner's
// projected wins rise a full win while the loser's fall one, so the league's
// 1,230 still closes. Night 3 repeats night 2's records with the shift doubled.
const [A, B] = [base.teams[0].team, base.teams[1].team];
function night(date: string, shift: number, played: boolean, source: "nightly" | "rebuilt"): RawProjectionSnapshot {
  const teams = base.teams.map((t) => {
    const c = { ...t };
    if (c.team === A) {
      if (played) {
        c.wins += 1;
      }
      c.proj_wins = Math.round((c.proj_wins + shift) * 10) / 10;
      c.proj_losses = Math.round((82 - c.proj_wins) * 10) / 10;
      c.wins_p10 = Math.max(c.wins, Math.min(c.wins_p10, Math.floor(c.proj_wins)));
      c.wins_p90 = Math.max(c.wins_p90, Math.ceil(c.proj_wins));
    }
    if (c.team === B) {
      if (played) {
        c.losses += 1;
      }
      c.proj_wins = Math.round((c.proj_wins - shift) * 10) / 10;
      c.proj_losses = Math.round((82 - c.proj_wins) * 10) / 10;
      c.wins_p10 = Math.max(c.wins, Math.min(c.wins_p10, Math.floor(c.proj_wins)));
      c.wins_p90 = Math.max(c.wins_p90, Math.ceil(c.proj_wins));
    }
    return c;
  });
  return { as_of_date: date, source, replicates: base.replicates, method: base.method, teams };
}
const d1 = base.as_of_date;
const plusDays = (iso: string, n: number) => {
  const ms = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
};
const [d2, d3, d4] = [plusDays(d1, 1), plusDays(d1, 6), plusDays(d1, 7)];
const goodRaw: RawProjectionHistoryFile = {
  season_start_year: base.season_start_year,
  generated_at: "2026-11-11T10:00:00Z",
  snapshots: [night(d1, 0, false, "rebuilt"), night(d2, 1, true, "rebuilt"), night(d3, 2, true, "nightly")],
};
const clone = (): RawProjectionHistoryFile => JSON.parse(JSON.stringify(goodRaw));

// ── 0. second source: the fixture is real NBA arithmetic, longhand ─────────
{
  let prev: Map<string, [number, number]> | null = null;
  for (const s of goodRaw.snapshots) {
    const title = s.teams.reduce((a, t) => a + t.title_pct, 0);
    check(Math.abs(title - 1) < 0.02, `fixture ${s.as_of_date}: Σ title = ${title}, not 1`);
    const wins = s.teams.reduce((a, t) => a + t.wins, 0);
    const losses = s.teams.reduce((a, t) => a + t.losses, 0);
    check(wins === losses, `fixture ${s.as_of_date}: league wins ${wins} ≠ losses ${losses}`);
    const proj = s.teams.reduce((a, t) => a + t.proj_wins, 0);
    check(Math.abs(proj - 1230) < 1, `fixture ${s.as_of_date}: league projected wins ${proj}, not 1,230`);
    const rec = new Map(s.teams.map((t) => [t.team, [t.wins, t.losses] as [number, number]]));
    if (prev) for (const [k, v] of rec) check(v[0] >= prev.get(k)![0] && v[1] >= prev.get(k)![1], `fixture: ${k}'s record shrank`);
    prev = rec;
  }
  notes.push("fixture: three nights, every one closes the league's arithmetic longhand; records only grow");
}

// ── 1. the contract ────────────────────────────────────────────────────────
{
  check(SUPPORTED_FEATURES.has("projection_history"), "SUPPORTED_FEATURES lacks projection_history");
  check(
    (FEATURE_FILES.projection_history ?? []).includes("projection_history.json"),
    "FEATURE_FILES.projection_history does not demand projection_history.json",
  );
  let threw = false;
  try {
    checkFeatures(["symmetric_off_def", "projection_history"]);
  } catch {
    threw = true;
  }
  check(!threw, "checkFeatures refuses projection_history");
  threw = false;
  try {
    checkFeatureFiles(["projection_history"], {});
  } catch (e) {
    threw = e instanceof ContractRejection && /projection_history\.json/.test((e as Error).message);
  }
  check(threw, "a declared projection_history with no file is not refused, naming the file");
  threw = false;
  try {
    checkFeatureFiles(["symmetric_off_def"], {});
  } catch {
    threw = true;
  }
  check(!threw, "a bundle WITHOUT the token is asked for projection_history.json");
  const d = describeContract();
  check(d.features.includes("projection_history"), "GET discovery does not list projection_history");
  check(
    (d.feature_files.projection_history ?? []).includes("projection_history.json"),
    "GET discovery does not list the history file",
  );
  notes.push("contract: token accepted, file demanded with it and only with it, discovery lists both");
}

// ── 2. the validator ───────────────────────────────────────────────────────
{
  let ok: RawProjectionHistoryFile | null = null;
  try {
    ok = validateProjectionHistory(clone());
  } catch (e) {
    problems.push(`validator refused the good fixture: ${(e as Error).message}`);
  }
  check(ok?.snapshots.length === 3, "validator did not return three nights");
  check(ok?.snapshots[1].source === "rebuilt", "validator lost a night's source");

  const refuse = (name: string, damage: (h: RawProjectionHistoryFile) => unknown, expect: RegExp) => {
    const h = clone();
    const damaged = damage(h) ?? h;
    try {
      validateProjectionHistory(damaged);
      problems.push(`validator ACCEPTED ${name}`);
    } catch (e) {
      if (!(e instanceof ProjectionHistoryRejection)) problems.push(`${name}: threw ${(e as Error).name}, not a rejection`);
      else if (!expect.test(e.message)) problems.push(`${name}: refused for the wrong reason — ${e.message}`);
    }
  };
  refuse("not an object", () => [], /expected an object/);
  refuse("a fractional season", (h) => void (h.season_start_year = 2026.5), /season_start_year/);
  refuse("a bad generated_at", (h) => void (h.generated_at = "yesterday"), /generated_at/);
  refuse("no snapshots", (h) => void (h.snapshots = []), /empty/);
  refuse(
    "too many snapshots",
    (h) => void (h.snapshots = Array.from({ length: MAX_SNAPSHOTS + 1 }, () => h.snapshots[0])),
    /more than a season/,
  );
  refuse("nights out of order", (h) => void h.snapshots.reverse(), /date order/);
  refuse("the same night twice", (h) => void (h.snapshots[1].as_of_date = h.snapshots[0].as_of_date), /date order/);
  refuse("a date that is not a date", (h) => void (h.snapshots[1].as_of_date = "2026-11-31"), /real YYYY-MM-DD/);
  refuse("an unknown source", (h) => void ((h.snapshots[0] as { source: string }).source = "guess"), /source/);
  refuse(
    "a percentage where a fraction was promised, on one night",
    (h) => void (h.snapshots[2].teams.reduce((m, t) => (t.title_pct > m.title_pct ? t : m)).title_pct *= 100),
    new RegExp(d3),
  );
  refuse("one night missing a team", (h) => void h.snapshots[1].teams.pop(), new RegExp(`${d2}.*30 teams`));
  refuse(
    "a record that goes backwards",
    (h) => {
      const t = h.snapshots[2].teams.find((x) => x.team === A)!;
      t.wins -= 1;
      // keep that night's own arithmetic closed, so ONLY the series rule can catch it
      h.snapshots[2].teams.find((x) => x.team === B)!.losses -= 1;
    },
    /was already/,
  );
  // And a night whose own numbers are fine must stay fine through the
  // delegated validator (the history validator adds nothing a single night
  // would refuse).
  try {
    validateProjections({ ...base });
  } catch (e) {
    problems.push(`the committed projections fixture no longer validates: ${(e as Error).message}`);
  }
  notes.push("validator: accepts the fixture, refuses 12 damage patterns each for its named reason");
}

// ── 3. the card's view and words ───────────────────────────────────────────
{
  const pts = (deltas: number[]): TrendPoint[] =>
    deltas.map((d, i) => ({
      date: plusDays("2026-10-20", i * 3),
      source: i < 2 ? "rebuilt" : "nightly",
      wins: i,
      losses: i,
      projWins: 41 + d,
      p10: 30 + d,
      p90: 52 + d,
      playoffPct: 0.5 + d / 40,
      titlePct: 0.03,
    }));
  check(trendSummary(pts([0])) === null, "one night is reported as a trend");
  const up = trendSummary(pts([0, 1, VERDICT_WINS + 1]))!;
  const down = trendSummary(pts([0, -1, -(VERDICT_WINS + 1)]))!;
  const flat = trendSummary(pts([0, 1, VERDICT_WINS - 1]))!;
  check(up.winsDelta === VERDICT_WINS + 1, `winsDelta is ${up.winsDelta}, not last − first`);
  check(/above/.test(trendVerdict(up)), `a rising team reads "${trendVerdict(up)}"`);
  check(/below/.test(trendVerdict(down)), `a falling team reads "${trendVerdict(down)}"`);
  check(/About where/.test(trendVerdict(flat)), `a flat team reads "${trendVerdict(flat)}"`);
  check(up.rebuiltThrough === "2026-10-23", `rebuiltThrough is ${up.rebuiltThrough}, not the last rebuilt night`);
  check(up.startsPreseason && /opening night/.test(trendVerdict(up)), "a line that starts 0-0 does not say opening night");
  check(fmtWinsDelta(4.24) === "+4.2" && fmtWinsDelta(-1) === "−1.0" && fmtWinsDelta(0.04) === "0.0", "fmtWinsDelta");
  check(fmtPctPoints(0.12) === "+12 pts" && fmtPctPoints(-0.031) === "−3 pts" && fmtPctPoints(0.001) === "no change", "fmtPctPoints");
  // trendPointOf reads the right fields
  const t = base.teams[0];
  const p = trendPointOf("2026-10-27", "nightly", t);
  check(p.projWins === t.proj_wins && p.p10 === t.wins_p10 && p.p90 === t.wins_p90 && p.playoffPct === t.playoff_pct && p.titlePct === t.title_pct, "trendPointOf mixed up a field");
  notes.push("card: one night is not a trend; above / below / about-where follow the sign and the threshold");
}

// ── 4. the chart's geometry ────────────────────────────────────────────────
{
  const pts: TrendPoint[] = [
    { date: "2026-10-21", source: "rebuilt", wins: 0, losses: 0, projWins: 44, p10: 33, p90: 55, playoffPct: 0.6, titlePct: 0.02 },
    { date: "2026-10-30", source: "rebuilt", wins: 4, losses: 1, projWins: 48, p10: 38, p90: 58, playoffPct: 0.7, titlePct: 0.03 },
    { date: "2026-11-10", source: "nightly", wins: 7, losses: 4, projWins: 46, p10: 36, p90: 56, playoffPct: 0.65, titlePct: 0.02 },
  ];
  const c = trendChart(pts);
  const [a, b, z] = c.dots;
  check(a.x === 0 && z.x === 100, `x runs ${a.x}..${z.x}, not 0..100`);
  check(a.x < b.x && b.x < z.x, "time does not run left to right");
  const frac = (dayNumber("2026-10-30") - dayNumber("2026-10-21")) / (dayNumber("2026-11-10") - dayNumber("2026-10-21"));
  check(Math.abs(b.x - frac * 100) < 0.11, `x is not calendar time (night 2 at ${b.x}, expected ${(frac * 100).toFixed(1)})`);
  check(b.y < a.y && b.y < z.y, "more projected wins are not drawn HIGHER");
  check(c.startY === a.y, "the dashed start line is not at the first night");
  check(c.yMin <= 33 && c.yMax >= 58 && c.yMin % 5 === 0 && c.yMax % 5 === 0, `y range ${c.yMin}..${c.yMax} does not hold the band on whole fives`);
  check(c.yTicks.every((t, i, arr) => i === 0 || t.y < arr[i - 1].y), "y ticks are not ascending wins going up");
  check(c.xTicks.some((t) => t.label === "Nov"), "no month tick for Nov 1");
  check(c.xTicks.every((t) => t.x >= 0 && t.x <= 100), "a month tick falls off the chart");
  // The band must contain the line, night by night: parse the polygon.
  const coords = (d: string) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const band = coords(c.band);
  const line = coords(c.line);
  check(band.length === 2 * pts.length && line.length === pts.length, "band/line point counts are wrong");
  for (let i = 0; i < pts.length; i++) {
    const upper = band[i][1];
    const lower = band[band.length - 1 - i][1];
    check(upper <= line[i][1] && line[i][1] <= lower, `night ${i}: the line is outside its own 80% band`);
    // and the edges ARE the 80% range, on the same wins scale as the axis
    const yOf = (w: number) => (1 - (w - c.yMin) / (c.yMax - c.yMin)) * 100;
    check(Math.abs(upper - yOf(pts[i].p90)) < 0.11 && Math.abs(lower - yOf(pts[i].p10)) < 0.11, `night ${i}: the band's edges are not p10 / p90`);
    check(Math.abs(line[i][1] - yOf(pts[i].projWins)) < 0.11, `night ${i}: the line is not at projected wins`);
  }
  notes.push("chart: calendar-time x, more wins drawn higher, band holds the line, month ticks on the chart");
}

// ── 5. the store and the REAL importer ────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-projection-history-check-"));
  const cwd = process.cwd();
  let db: import("better-sqlite3").Database | null = null;
  try {
    process.chdir(tmp);
    const { getDb } = await import(path.join(ROOT, "lib/db.ts"));
    db = getDb() as import("better-sqlite3").Database;
    const { readTeamTrend, storedProjectionHistoryGeneratedAt } = await import(path.join(ROOT, "lib/hoops/projectionStore.ts"));
    const { importPushedBundle } = await import(path.join(ROOT, "lib/hoops/import.ts"));

    for (const t of ["hoops_projection_history", "hoops_projection_history_meta"]) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      check(cols.length > 0, `lib/db.ts: no ${t} table`);
    }
    const nights = () =>
      (db!.prepare(`SELECT COUNT(DISTINCT as_of_date) AS n FROM hoops_projection_history`).get() as { n: number }).n;
    const rows = () => (db!.prepare(`SELECT COUNT(*) AS n FROM hoops_projection_history`).get() as { n: number }).n;
    check(nights() === 0, "a fresh DB has history");

    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "hoops-data", f), "utf-8"));
    const bundle: HoopsBundle = {
      params: read("hoops_params.json"),
      teams: read("hoops_teams.json"),
      players: read("hoops_players.json"),
      schedule: read("hoops_schedule.json"),
      results: read("hoops_results.json"),
      lines: read("hoops_lines.json"),
    };
    const meta = (hash: string) => ({
      hash,
      generatedAt: "2026-11-11T10:00:00Z",
      pricingVersion: 1,
      features: ["symmetric_off_def", "absorption", "fictional_values"],
      constants: { ...(bundle.params.constants as unknown as Record<string, unknown>), replacement_per36: bundle.players.replacement_per36 },
    });

    // (a) a push carrying only tonight's projection records tonight
    importPushedBundle({ ...bundle, projections: validateProjections(base) }, meta("sha256:a"));
    check(nights() === 1 && rows() === 30, `one projection push left ${nights()} nights / ${rows()} rows, not 1 / 30`);
    const t1 = readTeamTrend(db, base.season_start_year, A);
    check(t1.length === 1 && t1[0].source === "nightly" && t1[0].date === d1, "the pushed projection was not recorded as a nightly point");

    // (b) the history file REPLACES the season (not appends): a stored night the
    // file does not carry must be gone afterwards; 3 nights, sources kept.
    const stray = plusDays(d1, 3);
    importPushedBundle(
      { ...bundle, projections: validateProjections({ ...base, as_of_date: stray, generated_at: "2026-11-10T10:00:00Z" }) },
      meta("sha256:a2"),
    );
    check(nights() === 2, `a second night's push left ${nights()} nights, not 2`);
    const hist = validateProjectionHistory(clone());
    importPushedBundle({ ...bundle, projectionHistory: hist }, meta("sha256:b"));
    check(nights() === 3 && rows() === 90, `the history push left ${nights()} nights / ${rows()} rows, not 3 / 90`);
    const t2 = readTeamTrend(db, base.season_start_year, A);
    check(t2.map((p: TrendPoint) => p.date).join() === [d1, d2, d3].join(), "readTeamTrend is not oldest-first");
    check(t2[0].source === "rebuilt", "the history file did not replace the nightly night it covers");
    check(t2[2].projWins === hist.snapshots[2].teams.find((x) => x.team === A)!.proj_wins, "a stored night lost its projected wins");
    check(storedProjectionHistoryGeneratedAt(db) === hist.generated_at, "the history meta did not record generated_at");

    // (c) a later push without either keeps the line
    importPushedBundle(bundle, meta("sha256:c"));
    check(nights() === 3, "a push without a projection or history wiped the line");

    // (d) the next night's projection appends to it
    importPushedBundle(
      { ...bundle, projections: validateProjections({ ...base, as_of_date: d4, generated_at: "2026-11-12T10:00:00Z" }) },
      meta("sha256:d"),
    );
    check(nights() === 4, "the next night's projection did not extend the line");
    const t3 = readTeamTrend(db, base.season_start_year, A);
    check(t3[3].date === d4 && t3[3].source === "nightly", "the appended night is not the newest, nightly point");

    // (e) the same night pushed twice is one night, the newer numbers
    importPushedBundle(
      { ...bundle, projections: validateProjections({ ...base, as_of_date: d4, generated_at: "2026-11-12T11:00:00Z" }) },
      meta("sha256:e"),
    );
    check(nights() === 4 && rows() === 120, "re-pushing a night doubled it");
    notes.push("store: each projection push records its night; the history file replaces the season; nothing else wipes it");
  } finally {
    db?.close();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 6. wiring: the route validates it, the page renders it ────────────────
{
  const route = fs.readFileSync(path.join(ROOT, "app/api/hoops/import/route.ts"), "utf-8");
  check(/includes\("projection_history"\)/.test(route) && /validateProjectionHistory\(/.test(route), "the import route does not validate a declared history");
  check(/historySettled/.test(route), "the route's same-hash no-op would drop a new history file");
  const page = fs.readFileSync(path.join(ROOT, "app/hoops/sim/teams/[tri]/page.tsx"), "utf-8");
  check(/<TeamProjection\b/.test(page) && /getTeamProjection\(/.test(page), "the sim team page does not render the Projection card");
  const card = fs.readFileSync(path.join(ROOT, "components/hoops/TeamProjection.tsx"), "utf-8");
  check(/trendChart\(/.test(card) && /trendVerdict\(/.test(card), "the card does not draw from the pure module");
  const mobile = fs.readFileSync(path.join(ROOT, "scripts/check-hoops-mobile.mjs"), "utf-8");
  check(/path: "\/hoops\/sim\/teams\/DEN"/.test(mobile), "check:hoops:mobile no longer walks a sim team page");
  notes.push("wiring: route validates and settles it; the team page renders the card; the phone walk covers the page");
}

for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error("hoops projection history check: FAIL");
  for (const p of problems.slice(0, 15)) console.error(`  ✗ ${p}`);
  if (problems.length > 15) console.error(`  … and ${problems.length - 15} more`);
  process.exit(1);
}
console.log("hoops projection history check: PASS");
