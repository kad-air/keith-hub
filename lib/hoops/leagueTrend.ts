// The all-teams projection trend on /hoops/sim/projections: every team's
// projection, night by night, as one chart.
//
// Pure, like the team card's maths in projectionHistory.ts, so the gate
// (scripts/check-hoops-projection-history.ts) checks the real picture. The
// chart is drawn in PERCENT coordinates (0..100 both ways) for an SVG stretched
// to its box with non-scaling strokes, the same approach as the team card: the
// axis labels, dots, end labels and tooltip are HTML at the same percentages,
// so text stays a readable size on a phone.

import { dayNumber, type TrendPoint } from "./projectionHistory.ts";

export type TrendMetric = "wins" | "playoffs" | "title";
export type TrendScope = "all" | "East" | "West";

export const METRICS: ReadonlyArray<{ key: TrendMetric; label: string; long: string }> = [
  { key: "wins", label: "Wins", long: "Projected wins" },
  { key: "playoffs", label: "Playoffs", long: "Playoff odds" },
  { key: "title", label: "Title", long: "Title odds" },
];

/** One team's season, as the page hands it to the chart. */
export interface TeamSeries {
  tri: string;
  conference: "East" | "West";
  division: string;
  points: TrendPoint[];
}

/** The number a metric plots for one night: wins as wins, odds as 0..100. */
export function metricValue(p: TrendPoint, m: TrendMetric): number {
  if (m === "wins") return p.projWins;
  if (m === "playoffs") return p.playoffPct * 100;
  return p.titlePct * 100;
}

/** "47.3" for wins; "62%", "<1%", "0%" for odds. */
export function fmtMetric(v: number, m: TrendMetric): string {
  if (m === "wins") return v.toFixed(1);
  if (v <= 0) return "0%";
  if (v < 0.5) return "<1%";
  if (v > 99.5 && v < 100) return ">99%";
  return `${Math.round(v)}%`;
}

export function inScope(s: { conference: string }, scope: TrendScope): boolean {
  return scope === "all" || s.conference === scope;
}

export interface LeagueTrendChart {
  /** Every night any team has, ascending. */
  dates: string[];
  /** x (percent) of each entry of `dates`. */
  xs: number[];
  lines: Array<{
    tri: string;
    path: string;
    /** One per stored night of this team, in date order. */
    pts: Array<{ dateIndex: number; x: number; y: number; value: number }>;
  }>;
  /** The 80% band on wins, per team (only drawn for a single focused team). */
  bands: Record<string, string>;
  yMin: number;
  yMax: number;
  yTicks: Array<{ y: number; label: string }>;
  xTicks: Array<{ x: number; label: string }>;
  /** y of 41 wins (an .500 season), or null when not on the wins metric or out of range. */
  evenY: number | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The y range a metric is drawn on, from the series in view. Wins pads to whole
 *  fives around the lines; playoff odds are always 0..100; title odds run from 0
 *  to a round ceiling over the best team, since most of the league is near 0. */
export function metricDomain(series: readonly TeamSeries[], m: TrendMetric): { min: number; max: number } {
  const vals = series.flatMap((s) => s.points.map((p) => metricValue(p, m)));
  if (vals.length === 0) return m === "wins" ? { min: 20, max: 60 } : { min: 0, max: 100 };
  if (m === "wins") {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return { min: Math.max(0, Math.floor((lo - 1) / 5) * 5), max: Math.min(82, Math.ceil((hi + 1) / 5) * 5) };
  }
  if (m === "playoffs") return { min: 0, max: 100 };
  const hi = Math.max(...vals);
  const ceil = [5, 10, 20, 30, 40, 50, 60, 80, 100].find((c) => c >= hi + 1) ?? 100;
  return { min: 0, max: ceil };
}

/**
 * Lay out every series in `series` (already filtered to the scope in view).
 * x is calendar time across the union of nights, y is the metric, higher is
 * more. Series with no points are dropped; a series with one point draws a dot.
 */
export function leagueTrendChart(series: readonly TeamSeries[], m: TrendMetric): LeagueTrendChart | null {
  const dateSet = new Set<string>();
  for (const s of series) for (const p of s.points) dateSet.add(p.date);
  const dates = [...dateSet].sort();
  if (dates.length < 2) return null;

  const { min: yMin, max: yMax } = metricDomain(series, m);
  const d0 = dayNumber(dates[0]);
  const d1 = dayNumber(dates[dates.length - 1]);
  const span = Math.max(1, d1 - d0);
  const xOf = (date: string) => r1(((dayNumber(date) - d0) / span) * 100);
  const yOf = (v: number) => r1((1 - (v - yMin) / Math.max(1e-9, yMax - yMin)) * 100);
  const xs = dates.map(xOf);
  const indexOf = new Map(dates.map((d, i) => [d, i]));

  const lines: LeagueTrendChart["lines"] = [];
  const bands: Record<string, string> = {};
  for (const s of series) {
    if (s.points.length === 0) continue;
    const pts = s.points.map((p) => {
      const value = metricValue(p, m);
      return { dateIndex: indexOf.get(p.date)!, x: xOf(p.date), y: yOf(value), value };
    });
    const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
    lines.push({ tri: s.tri, path, pts });
    if (m === "wins") {
      const upper = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.date)},${yOf(p.p90)}`).join(" ");
      const lower = [...s.points].reverse().map((p) => `L${xOf(p.date)},${yOf(p.p10)}`).join(" ");
      bands[s.tri] = `${upper} ${lower} Z`;
    }
  }

  const range = yMax - yMin;
  const step = m === "wins" ? (range > 30 ? 10 : 5) : range > 50 ? 25 : range > 20 ? 10 : 5;
  const yTicks: LeagueTrendChart["yTicks"] = [];
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
    yTicks.push({ y: yOf(v), label: m === "wins" ? String(v) : `${v}%` });
  }

  // The first night with its date, then the 1st of each month in the span —
  // skipping a 1st so close to the start that the two labels would collide.
  const [sy, sm, sd] = dates[0].split("-").map(Number);
  const xTicks: LeagueTrendChart["xTicks"] = [{ x: 0, label: `${MONTHS[sm - 1]} ${sd}` }];
  for (let yy = sy, mm = sm + 1; ; mm++) {
    if (mm > 12) {
      mm = 1;
      yy++;
    }
    const iso = `${yy}-${String(mm).padStart(2, "0")}-01`;
    if (dayNumber(iso) > d1) break;
    if (xOf(iso) >= 14) xTicks.push({ x: xOf(iso), label: MONTHS[mm - 1] });
  }

  const evenY = m === "wins" && yMin < 41 && yMax > 41 ? yOf(41) : null;
  return { dates, xs, lines, bands, yMin, yMax, yTicks, xTicks, evenY };
}

/** The night nearest a horizontal position (percent across the plot). */
export function nearestNight(chart: Pick<LeagueTrendChart, "xs">, xPct: number): number {
  let best = 0;
  for (let i = 1; i < chart.xs.length; i++) {
    if (Math.abs(chart.xs[i] - xPct) < Math.abs(chart.xs[best] - xPct)) best = i;
  }
  return best;
}

/** The team whose line passes closest to (night, yPct), among `candidates`
 *  (every team in view when empty). A team with no point that night is
 *  measured at its nearest earlier night, so a missed night doesn't hide it. */
export function nearestTeam(
  chart: Pick<LeagueTrendChart, "lines">,
  dateIndex: number,
  yPct: number,
  candidates?: ReadonlySet<string>,
): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const l of chart.lines) {
    if (candidates && candidates.size > 0 && !candidates.has(l.tri)) continue;
    const p = pointAt(l, dateIndex);
    if (!p) continue;
    const d = Math.abs(p.y - yPct);
    if (d < bestD) {
      bestD = d;
      best = l.tri;
    }
  }
  return best;
}

/** A line's point on a night, or its last point before it; null before its first. */
export function pointAt<P extends { dateIndex: number }>(line: { pts: P[] }, dateIndex: number): P | null {
  let hit: P | null = null;
  for (const p of line.pts) {
    if (p.dateIndex > dateIndex) break;
    hit = p;
  }
  return hit;
}

/**
 * Vertical positions for the end-of-line labels of the focused teams, pushed
 * apart so no two sit closer than `gap` percent, kept inside 0..100. Input
 * order doesn't matter; output keeps each tri with its label y.
 */
export function spreadLabels(
  items: ReadonlyArray<{ tri: string; y: number }>,
  gap = 7,
): Array<{ tri: string; y: number }> {
  const sorted = [...items].sort((a, b) => a.y - b.y).map((i) => ({ ...i }));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
  }
  const overflow = sorted.length ? sorted[sorted.length - 1].y - 100 : 0;
  if (overflow > 0) {
    for (const s of sorted) s.y -= overflow;
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i + 1].y - sorted[i].y < gap) sorted[i].y = sorted[i + 1].y - gap;
    }
  }
  return sorted.map((s) => ({ tri: s.tri, y: r1(s.y) }));
}
