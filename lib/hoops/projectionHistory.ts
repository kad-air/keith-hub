// THE PROJECTION'S SEASON — the receiver half of `projection_history`, and the
// pure half of the sim team page's "Projection" card.
//
// Keith's ask (2026-11-11): "the sim section needs the projection for each team
// on the team page. i also want the trend of the projection over the course of
// the season, as they outplay or underplay their ratings ... backdate it to the
// start of the season."
//
// Two sources fill the history (lib/hoops/projectionStore.ts writes both):
//
//   • every push that carries a projections.json records that night under its
//     own as_of_date (source `nightly`), so the line grows by itself from the
//     day this ships, with no sender change at all;
//   • a push that declares `projection_history` carries projection_history.json,
//     the sender's whole archive for the season — every night it kept plus the
//     nights it REBUILT (opening night onward, re-run with only what was known
//     through each date) — and REPLACES the season's stored history with it.
//
// 🔴 Every snapshot is held to exactly the NBA arithmetic projections.json is
// (validateProjections, reused, not retyped), plus the one fact only a SERIES
// can break: a team's real record never shrinks from one night to the next.
//
// Imports nothing with side effects — the build gate drives it under plain node.

import { ProjectionRejection, isCalendarDate, validateProjections } from "./projections.ts";
import type {
  ProjectionSource,
  RawProjectionHistoryFile,
  RawProjectionSnapshot,
  RawProjectionTeam,
} from "./types";

export class ProjectionHistoryRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionHistoryRejection";
  }
}

/** A regular season plus a preseason point is ~180 nights; this is slack, not a target. */
export const MAX_SNAPSHOTS = 400;

export const SOURCES: ReadonlySet<string> = new Set<ProjectionSource>(["nightly", "rebuilt"]);

function fail(msg: string): never {
  throw new ProjectionHistoryRejection(`projection_history.json: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a raw `projection_history.json`. Returns the typed file or throws
 * ProjectionHistoryRejection naming the FIRST problem (and the night it is on).
 * Never mutates its input.
 */
export function validateProjectionHistory(raw: unknown): RawProjectionHistoryFile {
  if (!isPlainObject(raw)) fail("expected an object");
  const season = raw.season_start_year;
  if (typeof season !== "number" || !Number.isInteger(season) || season < 1946) {
    fail(`season_start_year must be an integer season (got ${JSON.stringify(season)})`);
  }
  if (typeof raw.generated_at !== "string" || Number.isNaN(Date.parse(raw.generated_at))) {
    fail(`generated_at must be an ISO-8601 timestamp (got ${JSON.stringify(raw.generated_at)})`);
  }
  if (!Array.isArray(raw.snapshots)) fail("snapshots must be an array");
  if (raw.snapshots.length === 0) fail("snapshots is empty");
  if (raw.snapshots.length > MAX_SNAPSHOTS) {
    fail(`${raw.snapshots.length} snapshots is more than a season can have (max ${MAX_SNAPSHOTS})`);
  }

  const snapshots: RawProjectionSnapshot[] = [];
  let prevDate: string | null = null;
  let prevRecord: Map<string, { wins: number; losses: number }> | null = null;
  for (const [i, s] of (raw.snapshots as unknown[]).entries()) {
    if (!isPlainObject(s)) fail(`snapshots[${i}]: expected an object`);
    const date = s.as_of_date;
    if (!isCalendarDate(date)) {
      fail(`snapshots[${i}]: as_of_date must be a real YYYY-MM-DD date (got ${JSON.stringify(date)})`);
    }
    if (typeof s.source !== "string" || !SOURCES.has(s.source)) {
      fail(`${date}: source must be "nightly" or "rebuilt" (got ${JSON.stringify(s.source)})`);
    }
    if (prevDate !== null && date <= prevDate) {
      fail(`${date} follows ${prevDate}: snapshots must be in date order, one a night`);
    }

    // The whole projections.json rulebook, on this one night.
    let file;
    try {
      file = validateProjections({
        season_start_year: season,
        as_of_date: date,
        generated_at: raw.generated_at,
        replicates: s.replicates,
        method: s.method,
        teams: s.teams,
      });
    } catch (err) {
      if (err instanceof ProjectionRejection) fail(`${date}: ${err.message.replace(/^projections\.json: /, "")}`);
      throw err;
    }

    // A record only ever grows: a team cannot have fewer wins, or fewer
    // losses, on a later night than an earlier one.
    const record = new Map(file.teams.map((t) => [t.team, { wins: t.wins, losses: t.losses }]));
    if (prevRecord) {
      for (const [tri, r] of record) {
        const p = prevRecord.get(tri)!;
        if (r.wins < p.wins || r.losses < p.losses) {
          fail(`${date}: ${tri} is ${r.wins}-${r.losses}, but was already ${p.wins}-${p.losses} on ${prevDate}`);
        }
      }
    }

    snapshots.push({
      as_of_date: date,
      source: s.source as ProjectionSource,
      replicates: file.replicates,
      method: file.method,
      teams: file.teams,
    });
    prevDate = date;
    prevRecord = record;
  }

  return { season_start_year: season, generated_at: raw.generated_at, snapshots };
}

// ---------------------------------------------------------------------------
// The team page's view
// ---------------------------------------------------------------------------

/** One night of one team's projection, as the page reads it. */
export interface TrendPoint {
  date: string;
  source: ProjectionSource;
  wins: number;
  losses: number;
  projWins: number;
  p10: number;
  p90: number;
  playoffPct: number;
  titlePct: number;
}

export function trendPointOf(date: string, source: ProjectionSource, t: RawProjectionTeam): TrendPoint {
  return {
    date,
    source,
    wins: t.wins,
    losses: t.losses,
    projWins: t.proj_wins,
    p10: t.wins_p10,
    p90: t.wins_p90,
    playoffPct: t.playoff_pct,
    titlePct: t.title_pct,
  };
}

export interface TrendSummary {
  first: TrendPoint;
  last: TrendPoint;
  /** last.projWins − first.projWins: wins gained (+) or lost (−) since the line began. */
  winsDelta: number;
  playoffDelta: number;
  titleDelta: number;
  /** The last night that was rebuilt rather than kept as it ran, or null. */
  rebuiltThrough: string | null;
  /** True when the line starts before any game was played (every team 0-0). */
  startsPreseason: boolean;
}

/** Null below two nights — one point is not a trend. Points must be date-ascending. */
export function trendSummary(points: readonly TrendPoint[]): TrendSummary | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  let rebuiltThrough: string | null = null;
  for (const p of points) if (p.source === "rebuilt") rebuiltThrough = p.date;
  return {
    first,
    last,
    winsDelta: last.projWins - first.projWins,
    playoffDelta: last.playoffPct - first.playoffPct,
    titleDelta: last.titlePct - first.titlePct,
    rebuiltThrough,
    startsPreseason: first.wins === 0 && first.losses === 0,
  };
}

/** "+4.2" / "−1.0" / "0.0" — a real minus sign, one decimal. */
export function fmtWinsDelta(d: number): string {
  const r = Math.round(d * 10) / 10;
  if (r === 0) return "0.0";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}`;
}

/** Percentage-point change, "+12 pts" / "−3 pts" / "no change". */
export function fmtPctPoints(d: number): string {
  const r = Math.round(d * 100);
  if (r === 0) return "no change";
  return `${r > 0 ? "+" : "−"}${Math.abs(r)} pts`;
}

// ---------------------------------------------------------------------------
// The chart's geometry — pure, so the gate checks the real picture's maths
// ---------------------------------------------------------------------------

export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The default box is 0..100 both ways, so every coordinate is a PERCENTAGE:
 *  the page stretches the SVG to its container (preserveAspectRatio="none",
 *  strokes non-scaling) and places the axis labels as HTML at the same
 *  percentages, so the text stays readable at phone width. */
export const CHART_BOX: ChartBox = { width: 100, height: 100, left: 0, right: 0, top: 0, bottom: 0 };

export interface TrendChart {
  /** Projected wins, night by night. */
  line: string;
  /** The 80% band on wins, a closed polygon. */
  band: string;
  /** Where the line began, as a horizontal reference (y). */
  startY: number;
  dots: Array<{ x: number; y: number; date: string; source: ProjectionSource }>;
  yTicks: Array<{ y: number; label: string }>;
  xTicks: Array<{ x: number; label: string }>;
  yMin: number;
  yMax: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Days since the epoch for a YYYY-MM-DD, by arithmetic (no local-time drift). */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Lay the trend out in `box`. x is real calendar time (a week without games is
 * a week of width); y is wins, 0 at the bottom, padded to whole fives around
 * the 80% band. Needs ≥ 2 points.
 */
export function trendChart(points: readonly TrendPoint[], box: ChartBox = CHART_BOX): TrendChart {
  const lo = Math.min(...points.map((p) => p.p10));
  const hi = Math.max(...points.map((p) => p.p90));
  const yMin = Math.max(0, Math.floor((lo - 1) / 5) * 5);
  const yMax = Math.min(82, Math.ceil((hi + 1) / 5) * 5);
  const d0 = dayNumber(points[0].date);
  const d1 = dayNumber(points[points.length - 1].date);
  const span = Math.max(1, d1 - d0);
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const x = (date: string) => r1(box.left + ((dayNumber(date) - d0) / span) * plotW);
  const y = (wins: number) => r1(box.top + (1 - (wins - yMin) / Math.max(1, yMax - yMin)) * plotH);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.date)},${y(p.projWins)}`).join(" ");
  const upper = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.date)},${y(p.p90)}`).join(" ");
  const lower = [...points].reverse().map((p) => `L${x(p.date)},${y(p.p10)}`).join(" ");
  const band = `${upper} ${lower} Z`;

  const step = yMax - yMin > 30 ? 10 : 5;
  const yTicks: TrendChart["yTicks"] = [];
  for (let w = Math.ceil(yMin / step) * step; w <= yMax; w += step) yTicks.push({ y: y(w), label: String(w) });

  // The first night, labelled with its date, then a tick on the 1st of every
  // month inside the span, labelled by month — skipping a 1st so close to the
  // start that the two labels would collide.
  const [sy, sm, sd] = points[0].date.split("-").map(Number);
  const xTicks: TrendChart["xTicks"] = [{ x: x(points[0].date), label: `${MONTHS[sm - 1]} ${sd}` }];
  for (let yy = sy, mm = sm + 1; ; mm++) {
    if (mm > 12) {
      mm = 1;
      yy++;
    }
    const iso = `${yy}-${String(mm).padStart(2, "0")}-01`;
    if (dayNumber(iso) > d1) break;
    if (x(iso) - xTicks[0].x >= 12) xTicks.push({ x: x(iso), label: MONTHS[mm - 1] });
  }

  return {
    line,
    band,
    startY: y(points[0].projWins),
    dots: points.map((p) => ({ x: x(p.date), y: y(p.projWins), date: p.date, source: p.source })),
    yTicks,
    xTicks,
    yMin,
    yMax,
  };
}

/** How far the line has to move before the page says the team is playing
 *  above or below where it started, in projected wins. Two wins is about one
 *  game of an 80% band's worth of noise either side at this point in a season. */
export const VERDICT_WINS = 2;

/**
 * The card's one plain sentence about the line, as data — the page renders it
 * verbatim, so the gate can read the real words.
 */
export function trendVerdict(s: TrendSummary): string {
  const since = s.startsPreseason ? "opening night" : `the line began`;
  const d = Math.round(s.winsDelta * 10) / 10;
  if (d >= VERDICT_WINS) {
    return `Playing above what we expected: ${fmtWinsDelta(d)} projected wins since ${since}.`;
  }
  if (d <= -VERDICT_WINS) {
    return `Playing below what we expected: ${fmtWinsDelta(d)} projected wins since ${since}.`;
  }
  return `About where we expected: ${fmtWinsDelta(d)} projected wins since ${since}.`;
}
