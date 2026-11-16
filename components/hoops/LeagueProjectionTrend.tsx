"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { FRANCHISES } from "@/lib/hoops/nba-franchises";
import { fmtAsOf } from "@/lib/hoops/projections";
import {
  METRICS,
  fmtMetric,
  inScope,
  leagueTrendChart,
  metricValue,
  nearestNight,
  nearestTeam,
  pointAt,
  spreadLabels,
} from "@/lib/hoops/leagueTrend";
import type { TeamSeries, TrendMetric, TrendScope } from "@/lib/hoops/leagueTrend";
import { distinctColors, teamChartColor } from "@/lib/hoops/teamColors";

/**
 * Every team's projection, night by night, on one chart — the league view of
 * the line each sim team page draws for one team.
 *
 * Thirty lines are only readable if the reader can pull a few out, so:
 *   • drag (or hover) across the chart to scrub night by night; the line
 *     nearest the pointer lights up and the tooltip reads it out,
 *   • tap the chart, or a team in the key, to pin it (pin several to compare);
 *     everything not pinned fades back, the y axis closes in on the pinned
 *     lines (animated), and pinned lines get colours that stay apart even
 *     where two teams' own colours are alike,
 *   • hovering (or dragging over) one of several pinned lines brings it
 *     forward and dims the other pinned ones,
 *   • East / West narrows the chart and rescales it to that conference,
 *   • Wins / Playoffs / Title switches what the lines measure.
 * A single focused team on Wins also gets its 80% band. Choices are remembered
 * on this device only.
 *
 * Geometry is lib/hoops/leagueTrend.ts (pure, gated); this file is the state
 * and the drawing.
 */

const STORE_KEY = "hoops:sim:projection-trend:v1";
/** Room each end label needs, in pixels: the 0.6rem label plus a little air. */
const LABEL_PX = 13;
const ZOOM_MS = 320;
const ZOOM_EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";
const DIVISIONS: Record<"East" | "West", string[]> = {
  East: ["Atlantic", "Central", "Southeast"],
  West: ["Northwest", "Pacific", "Southwest"],
};

interface Saved {
  scope: TrendScope;
  metric: TrendMetric;
  pinned: string[];
}

export default function LeagueProjectionTrend({ series }: { series: TeamSeries[] }) {
  const [scope, setScope] = useState<TrendScope>("all");
  const [metric, setMetric] = useState<TrendMetric>("wins");
  const [pinned, setPinned] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  // Whether `hover` is under a live pointer (a mouse over the plot or a key
  // chip, a finger while it's down) rather than left over from a tap.
  const [hoverLive, setHoverLive] = useState(false);
  const [plotH, setPlotH] = useState(256);
  const [zooming, setZooming] = useState(false);
  const zoomRef = useRef<SVGGElement>(null);
  const lastDomain = useRef<{ min: number; max: number; metric: TrendMetric } | null>(null);
  const renderedDomain = useRef<{ min: number; max: number; metric: TrendMetric } | null>(null);
  const glideUntil = useRef(0);
  const clipId = `trend-clip-${useId().replace(/:/g, "")}`;
  const [cursor, setCursor] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; moved: boolean; touch: boolean } | null>(null);

  // Remembered choices — per device, a convenience only; the page renders the
  // default view without them.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Saved>;
        if (s.scope === "all" || s.scope === "East" || s.scope === "West") setScope(s.scope);
        if (s.metric === "wins" || s.metric === "playoffs" || s.metric === "title") setMetric(s.metric);
        if (Array.isArray(s.pinned)) {
          const known = new Set(series.map((x) => x.tri));
          setPinned(s.pinned.filter((t): t is string => typeof t === "string" && known.has(t)));
        }
      }
    } catch {
      /* storage unavailable: defaults stand */
    }
    setLoaded(true);
  }, [series]);
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ scope, metric, pinned } satisfies Saved));
    } catch {
      /* ignore */
    }
  }, [loaded, scope, metric, pinned]);

  const visible = useMemo(() => series.filter((s) => inScope(s, scope)), [series, scope]);
  const visibleSet = useMemo(() => new Set(visible.map((s) => s.tri)), [visible]);
  const pinnedInView = useMemo(() => pinned.filter((t) => visibleSet.has(t)), [pinned, visibleSet]);
  // Pinned teams in view: the y axis fits them. Nothing pinned: the full view.
  const chart = useMemo(
    () => leagueTrendChart(visible, metric, { zoomTo: pinnedInView }),
    [visible, metric, pinnedInView],
  );

  // The plot's height in pixels, so end labels are spaced by what they need.
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      if (e.contentRect.height > 0) setPlotH(e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [chart != null]);

  // The HTML on the chart (dots, end labels, axis numbers) glides to its new
  // place on the render where the range changes, in step with the lines. This
  // has to be known on that very render — a transition added a render later
  // would come after the jump — so it's read from a ref here, not from state.
  let gliding = false;
  if (chart) {
    const rd = renderedDomain.current;
    if (rd && rd.metric === metric && (rd.min !== chart.yMin || rd.max !== chart.yMax) && !reducedMotion()) {
      glideUntil.current = Date.now() + ZOOM_MS;
    }
    renderedDomain.current = { min: chart.yMin, max: chart.yMax, metric };
    gliding = zooming || Date.now() < glideUntil.current;
  }

  // Zoom animation (FLIP): the lines are drawn on the new y range at once; the
  // group holding them starts transformed back to where the old range had
  // them and eases to rest. Only across the same metric — a switch to another
  // measure is different numbers, not a zoom.
  const yMin = chart?.yMin;
  const yMax = chart?.yMax;
  useLayoutEffect(() => {
    if (yMin == null || yMax == null) return;
    const prev = lastDomain.current;
    lastDomain.current = { min: yMin, max: yMax, metric };
    const g = zoomRef.current;
    if (!prev || !g || prev.metric !== metric || (prev.min === yMin && prev.max === yMax)) return;
    if (reducedMotion()) return;
    // y on the old range of a point drawn at y on the new one: y' = a·y + b.
    const a = (yMax - yMin) / (prev.max - prev.min);
    const b = (100 * (prev.max - yMax)) / (prev.max - prev.min);
    g.style.transition = "none";
    g.style.transform = `translate(0px, ${b}px) scale(1, ${a})`;
    g.getBoundingClientRect();
    const raf = requestAnimationFrame(() => {
      g.style.transition = `transform ${ZOOM_MS}ms ${ZOOM_EASE}`;
      g.style.transform = "";
    });
    setZooming(true);
    const t = window.setTimeout(() => setZooming(false), ZOOM_MS + 40);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      g.style.transition = "";
      g.style.transform = "";
    };
  }, [yMin, yMax, metric]);
  const focus = useMemo(() => {
    const f = new Set(pinnedInView);
    if (hover && visibleSet.has(hover)) f.add(hover);
    return f;
  }, [pinnedInView, hover, visibleSet]);

  const togglePin = useCallback((tri: string) => {
    setPinned((p) => (p.includes(tri) ? p.filter((t) => t !== tri) : [...p, tri]));
  }, []);

  const toggleDivision = useCallback(
    (tris: string[]) => {
      setPinned((p) => {
        const all = tris.every((t) => p.includes(t));
        return all ? p.filter((t) => !tris.includes(t)) : [...p, ...tris.filter((t) => !p.includes(t))];
      });
    },
    [],
  );

  // ── pointer: scrub on move, pin on a tap ──
  const locate = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = plotRef.current;
    if (!el || !chart) return null;
    const r = el.getBoundingClientRect();
    const xPct = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    const yPct = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
    const night = nearestNight(chart, xPct);
    return { night, tri: nearestTeam(chart, night, yPct) };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) p.moved = true;
    // A mouse scrubs on hover; a finger only while it's down.
    if (e.pointerType !== "mouse" && !p) return;
    const hit = locate(e);
    if (!hit) return;
    setCursor(hit.night);
    setHover(hit.tri);
    setHoverLive(true);
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    press.current = { x: e.clientX, y: e.clientY, moved: false, touch: e.pointerType !== "mouse" };
    const hit = locate(e);
    if (!hit) return;
    setCursor(hit.night);
    setHover(hit.tri);
    setHoverLive(true);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (p?.touch) setHoverLive(false);
    if (!p || p.moved) return; // a scrub, not a tap: leave the readout up
    const hit = locate(e);
    if (hit?.tri) togglePin(hit.tri);
  };
  const onLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") {
      setCursor(null);
      setHover(null);
      setHoverLive(false);
    }
  };
  const onCancel = () => {
    press.current = null;
    setHoverLive(false);
  };

  if (!chart) {
    return (
      <section className="mb-8" aria-label="Projection trend, all teams">
        <h3 className="mb-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">The season so far</h3>
        <p className="text-xs text-cream-dimmer">The league&rsquo;s line starts once two nights of projections are stored.</p>
      </section>
    );
  }

  const lineByTri = new Map(chart.lines.map((l) => [l.tri, l]));
  const latestOf = (tri: string) => {
    const l = lineByTri.get(tri);
    return l ? l.pts[l.pts.length - 1] : null;
  };
  const anyFocus = focus.size > 0;
  // Colours for the focused lines that stay apart (pin order, so a team keeps
  // its colour as more are pinned); every other line keeps its team colour.
  const lineColors = distinctColors(
    hover && !pinnedInView.includes(hover) && visibleSet.has(hover) ? [...pinnedInView, hover] : pinnedInView,
  );
  const colorOf = (tri: string) => lineColors[tri] ?? teamChartColor(tri);
  // One of several pinned lines under a live pointer comes forward; the other
  // pinned lines dim (but stay readable).
  const emph = hoverLive && hover && pinnedInView.length > 1 && pinnedInView.includes(hover) ? hover : null;
  const dimmed = (tri: string) => emph != null && tri !== emph;
  const glide: CSSProperties = gliding ? { transition: `top ${ZOOM_MS}ms ${ZOOM_EASE}` } : {};
  // Faded lines first, focused on top, the emphasised one topmost (SVG paints in order).
  const rank = (tri: string) => (tri === emph ? 2 : focus.has(tri) ? 1 : 0);
  const order = [...chart.lines].sort((a, b) => rank(a.tri) - rank(b.tri));
  const bandTri = metric === "wins" && focus.size === 1 ? [...focus][0] : null;

  // End labels sit at their own line's end, spread only as far as they must
  // be to not overlap; a short leader joins each to its line when it moved.
  const ends = new Map(
    [...focus].flatMap((tri) => {
      const p = latestOf(tri);
      return p ? [[tri, p.y] as const] : [];
    }),
  );
  const labels = spreadLabels(
    [...ends].map(([tri, y]) => ({ tri, y })),
    (LABEL_PX / Math.max(80, plotH)) * 100,
  );

  // The tooltip: the night under the cursor, read out for the focused teams
  // (pinned plus the one under the pointer), best first.
  const readout =
    cursor == null
      ? null
      : [...focus]
          .flatMap((tri) => {
            const l = lineByTri.get(tri);
            const p = l ? pointAt(l, cursor) : null;
            const s = series.find((x) => x.tri === tri);
            const tp = s?.points.find((x) => x.date === chart.dates[p?.dateIndex ?? -1]);
            return p && tp ? [{ tri, value: p.value, record: `${tp.wins}-${tp.losses}`, stale: p.dateIndex !== cursor }] : [];
          })
          .sort((a, b) => b.value - a.value);
  const cursorX = cursor == null ? null : chart.xs[cursor];
  const metricLong = METRICS.find((m) => m.key === metric)!.long;

  const conferences: Array<"East" | "West"> = scope === "all" ? ["East", "West"] : [scope];

  return (
    <section className="mb-10" aria-label="Projection trend, all teams">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">The season so far</h3>
        <p className="font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
          {fmtAsOf(chart.dates[0])} – {fmtAsOf(chart.dates[chart.dates.length - 1])} · {chart.dates.length} nights
        </p>
      </div>

      {/* controls */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <Segmented
          label="Teams"
          value={scope}
          options={[
            { key: "all", label: "League" },
            { key: "East", label: "East" },
            { key: "West", label: "West" },
          ]}
          onPick={(v) => setScope(v as TrendScope)}
        />
        <Segmented
          label="Measure"
          value={metric}
          options={METRICS.map((m) => ({ key: m.key, label: m.label }))}
          onPick={(v) => setMetric(v as TrendMetric)}
        />
      </div>

      {/* chart */}
      <div className="flex gap-1.5" role="img" aria-label={`${metricLong} by night, ${scope === "all" ? "every team" : `the ${scope}`}`}>
        <div className="relative h-64 w-7 shrink-0 sm:h-80 lg:h-[26rem]">
          {chart.yTicks.map((t) => (
            <span
              key={t.label}
              className="absolute right-0 -translate-y-1/2 font-mono text-[0.58rem] tabular-nums text-cream-dimmer"
              style={{ top: `${t.y}%`, ...glide }}
            >
              {t.label}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div
            ref={plotRef}
            className="relative h-64 cursor-crosshair select-none border-b border-l border-rule/60 sm:h-80 lg:h-[26rem]"
            style={{ touchAction: "pan-y" }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onLeave}
            onPointerCancel={onCancel}
          >
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
              aria-hidden
            >
              <defs>
                <clipPath id={clipId}>
                  <rect x="0" y="0" width="100" height="100" />
                </clipPath>
              </defs>
              <g clipPath={`url(#${clipId})`}>
              <g ref={zoomRef} style={{ transformOrigin: "0 0" }}>
              {chart.yTicks.map((t) => (
                <line
                  key={t.label}
                  x1="0"
                  x2="100"
                  y1={t.y}
                  y2={t.y}
                  className="stroke-rule/40"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {chart.evenY != null && (
                <line
                  x1="0"
                  x2="100"
                  y1={chart.evenY}
                  y2={chart.evenY}
                  className="stroke-cream-dimmer/70"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {bandTri && chart.bands[bandTri] && (
                <path
                  d={chart.bands[bandTri]}
                  className="hoops-team"
                  style={{ "--team": colorOf(bandTri), fill: "var(--team-c)", fillOpacity: 0.14 } as CSSProperties}
                />
              )}
              {order.map((l) => {
                const on = focus.has(l.tri);
                return (
                  <path
                    key={l.tri}
                    d={l.path}
                    fill="none"
                    className="hoops-team transition-[stroke-opacity] duration-150"
                    style={
                      {
                        "--team": colorOf(l.tri),
                        stroke: "var(--team-c)",
                        strokeOpacity: anyFocus ? (on ? (dimmed(l.tri) ? 0.35 : 1) : 0.13) : 0.75,
                      } as CSSProperties
                    }
                    strokeWidth={l.tri === emph ? 3.25 : on ? 2.5 : 1.4}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
              </g>
              </g>
              {cursorX != null && (
                <line
                  x1={cursorX}
                  x2={cursorX}
                  y1="0"
                  y2="100"
                  className="stroke-cream-dim/60"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>

            {/* the focused teams' dots: tonight, or the night under the cursor */}
            {[...focus].map((tri) => {
              const l = lineByTri.get(tri);
              const p = l ? (cursor == null ? l.pts[l.pts.length - 1] : pointAt(l, cursor)) : null;
              if (!p) return null;
              return (
                <span
                  key={tri}
                  className="hoops-team pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-ink transition-opacity duration-150"
                  style={
                    {
                      "--team": colorOf(tri),
                      background: "var(--team-c)",
                      left: `${p.x}%`,
                      top: `${p.y}%`,
                      opacity: dimmed(tri) ? 0.4 : 1,
                      ...glide,
                    } as CSSProperties
                  }
                />
              );
            })}

            {/* end labels for the focused teams, in the right gutter, each
                joined to its own line's end by a short leader */}
            {labels.length > 0 && (
              <svg
                viewBox="0 0 10 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute left-full top-0 h-full w-2.5 overflow-visible"
                aria-hidden
              >
                {labels.map((lb) => {
                  const y0 = ends.get(lb.tri) ?? lb.y;
                  return (
                    <path
                      key={lb.tri}
                      d={`M0,${y0} C5,${y0} 5,${lb.y} 10,${lb.y}`}
                      fill="none"
                      className="hoops-team"
                      style={
                        {
                          "--team": colorOf(lb.tri),
                          stroke: "var(--team-c)",
                          strokeOpacity: dimmed(lb.tri) ? 0.3 : 0.7,
                          ...(gliding ? { transition: `d ${ZOOM_MS}ms ${ZOOM_EASE}` } : {}),
                        } as CSSProperties
                      }
                      strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </svg>
            )}
            {labels.map((lb) => (
              <span
                key={lb.tri}
                className="hoops-team pointer-events-none absolute left-full ml-3 -translate-y-1/2 font-mono text-[0.6rem] font-semibold leading-none transition-opacity duration-150"
                style={
                  {
                    "--team": colorOf(lb.tri),
                    color: "var(--team-c)",
                    top: `${lb.y}%`,
                    opacity: dimmed(lb.tri) ? 0.45 : 1,
                    ...glide,
                  } as CSSProperties
                }
              >
                {lb.tri}
              </span>
            ))}

            {chart.evenY != null && !anyFocus && (
              <span
                className="pointer-events-none absolute left-full ml-1.5 -translate-y-1/2 font-mono text-[0.55rem] text-cream-dimmer"
                style={{ top: `${chart.evenY}%`, ...glide }}
              >
                .500
              </span>
            )}

            {/* tooltip */}
            {cursor != null && cursorX != null && readout && readout.length > 0 && (
              <div
                className={`pointer-events-none absolute top-1 z-10 min-w-[8.5rem] border border-rule-strong bg-ink-raised/95 px-2 py-1.5 shadow-lg ${
                  cursorX > 55 ? "-translate-x-full" : ""
                }`}
                style={{ left: `calc(${cursorX}% ${cursorX > 55 ? "- 8px" : "+ 8px"})` }}
              >
                <p className="mb-1 font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
                  {fmtAsOf(chart.dates[cursor])}
                </p>
                {readout.slice(0, 8).map((r) => (
                  <p key={r.tri} className="flex items-baseline gap-1.5 font-mono text-[0.68rem] tabular-nums">
                    <span
                      className="hoops-team inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ "--team": colorOf(r.tri), background: "var(--team-c)" } as CSSProperties}
                    />
                    <span className={r.tri === hover ? "text-cream" : "text-cream-dim"}>{r.tri}</span>
                    <span className="ml-auto text-cream">{fmtMetric(r.value, metric)}</span>
                    <span className="w-9 text-right text-cream-dimmer">{r.record}</span>
                  </p>
                ))}
                {readout.length > 8 && (
                  <p className="font-mono text-[0.58rem] text-cream-dimmer">+{readout.length - 8} more pinned</p>
                )}
                {readout.length === 1 && (
                  <p className="mt-0.5 font-display text-[0.7rem] text-cream-dimmer">
                    {FRANCHISES[readout[0].tri]?.name ?? readout[0].tri}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="relative h-4">
            {chart.xTicks.map((t) => (
              <span
                key={`${t.label}-${t.x}`}
                className={`absolute top-0.5 ${t.x === 0 ? "" : "-translate-x-1/2"} font-mono text-[0.58rem] uppercase text-cream-dimmer`}
                style={{ left: `${t.x}%` }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>
        {/* room for the end labels */}
        <div className="w-10 shrink-0" aria-hidden />
      </div>

      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="font-mono text-[0.58rem] text-cream-dimmer">
          {pinnedInView.length > 0
            ? `${pinnedInView.length} pinned · tap a line or team to add or drop it`
            : "Drag across to read a night · tap a line or team to pin it"}
        </p>
        {pinned.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setPinned([]);
              setHover(null);
              setHoverLive(false);
              setCursor(null);
            }}
            className="shrink-0 border border-rule/60 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dim hover:border-cat-hoops/40 hover:text-cream"
          >
            Clear
          </button>
        )}
      </div>

      {/* the key: every team in view, by division, best first on the measure */}
      <div className={`mt-4 grid gap-4 ${conferences.length === 2 ? "sm:grid-cols-2" : ""}`}>
        {conferences.map((conf) => (
          <div key={conf}>
            {scope === "all" && (
              <p className="mb-1.5 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">{conf}</p>
            )}
            <div className="grid gap-2">
              {DIVISIONS[conf].map((div) => {
                const teams = visible
                  .filter((s) => s.conference === conf && s.division === div)
                  .map((s) => ({ tri: s.tri, now: latestOf(s.tri)?.value ?? null }))
                  .sort((a, b) => (b.now ?? -1) - (a.now ?? -1));
                if (teams.length === 0) return null;
                const tris = teams.map((t) => t.tri);
                const allPinned = tris.every((t) => pinned.includes(t));
                return (
                  <div key={div} className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => toggleDivision(tris)}
                      aria-pressed={allPinned}
                      className={`w-[4.6rem] shrink-0 text-left font-mono text-[0.58rem] uppercase tracking-kicker transition-colors ${
                        allPinned ? "text-cat-hoops" : "text-cream-dimmer hover:text-cream-dim"
                      }`}
                      title={`${allPinned ? "Unpin" : "Pin"} the ${div}`}
                    >
                      {div}
                    </button>
                    {teams.map((t) => {
                      const on = pinned.includes(t.tri);
                      return (
                        <button
                          key={t.tri}
                          type="button"
                          onClick={() => togglePin(t.tri)}
                          onMouseEnter={() => {
                            setHover(t.tri);
                            setHoverLive(true);
                          }}
                          onMouseLeave={() => {
                            setHover((h) => (h === t.tri ? null : h));
                            setHoverLive(false);
                          }}
                          aria-pressed={on}
                          title={FRANCHISES[t.tri]?.name ?? t.tri}
                          className={`hoops-team flex items-center gap-1 border px-1.5 py-1 font-mono text-[0.64rem] tabular-nums transition-colors ${
                            on ? "bg-ink-raised text-cream" : "border-rule/60 text-cream-dim hover:text-cream"
                          }`}
                          style={
                            {
                              "--team": on ? colorOf(t.tri) : teamChartColor(t.tri),
                              ...(on ? { borderColor: "var(--team-c)" } : {}),
                            } as CSSProperties
                          }
                        >
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--team-c)" }} />
                          {t.tri}
                          {t.now != null && <span className="text-cream-dimmer">{fmtMetric(t.now, metric)}</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 max-w-[80ch] text-xs text-cream-dimmer">
        {metricLong} after each night&rsquo;s games, one line per team
        {metric === "wins" ? "; the dashed line is a .500 season (41 wins)" : ""}. The step each line takes in late
        October lands on that team&rsquo;s third game, when the model first lets this season&rsquo;s results count. Each
        team&rsquo;s own line, with its 80% range, is on its{" "}
        <Link href="/hoops/sim/teams" className="text-cat-hoops hover:text-cream">
          team page
        </Link>
        .
      </p>
    </section>
  );
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function Segmented({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: Array<{ key: string; label: string }>;
  onPick: (key: string) => void;
}) {
  return (
    <div className="flex" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onPick(o.key)}
          aria-pressed={o.key === value}
          className={`-ml-px flex-1 whitespace-nowrap border px-1.5 py-1.5 font-mono text-[0.66rem] uppercase tracking-kicker transition-colors first:ml-0 ${
            o.key === value
              ? "relative border-cat-hoops/70 bg-cat-hoops/10 text-cat-hoops"
              : "border-rule/60 text-cream-dim hover:border-cat-hoops/40 hover:text-cream"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
