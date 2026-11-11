import Link from "next/link";
import { fmtAsOf, fmtPct, fmtProjRecord, fmtWinRange } from "@/lib/hoops/projections";
import { trendChart, trendSummary, trendVerdict } from "@/lib/hoops/projectionHistory";
import type { TrendPoint } from "@/lib/hoops/projectionHistory";
import type { ProjectionMeta } from "@/lib/hoops/projectionStore";
import type { RawProjectionTeam } from "@/lib/hoops/types";

/**
 * The sim team page's PROJECTION card: tonight's rest-of-season projection for
 * this team (the same numbers as its row on /hoops/sim/projections) and the
 * line of how that projection has moved night by night this season.
 *
 * The chart is a plain server-rendered SVG stretched to its box
 * (preserveAspectRatio="none", strokes non-scaling); every coordinate comes
 * from `trendChart` in lib/hoops/projectionHistory.ts as a percentage, and the
 * axis labels are HTML placed at those same percentages, so text stays a
 * readable size on a phone. Every sentence comes from that module too.
 */
export default function TeamProjection({
  tri,
  current,
  meta,
  trend,
}: {
  tri: string;
  current: RawProjectionTeam | null;
  meta: ProjectionMeta | null;
  trend: TrendPoint[];
}) {
  if (!current && trend.length === 0) {
    return (
      <section className="mt-8">
        <h3 className="font-display text-lg text-cream">Projection</h3>
        <p className="mt-1 text-xs text-cream-dimmer">No rest-of-season projection has been received yet.</p>
      </section>
    );
  }
  const summary = trendSummary(trend);
  const chart = summary ? trendChart(trend) : null;
  const last = trend[trend.length - 1];

  return (
    <section className="mt-8" aria-label="Season projection">
      <h3 className="font-display text-lg text-cream">Projection</h3>
      {meta && (
        <p className="mt-1 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          as of {fmtAsOf(meta.asOfDate)} · {meta.replicates.toLocaleString("en-US")} simulated seasons
        </p>
      )}

      {current && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Proj record" value={fmtProjRecord(current)} sub={`${current.wins}-${current.losses} now`} accent />
          <Stat label="80% range" value={fmtWinRange(current)} sub="wins" />
          <Stat label="Playoffs" value={fmtPct(current.playoff_pct)} sub={`${fmtPct(current.top6_pct)} top 6`} />
          <Stat label="Title" value={fmtPct(current.title_pct)} sub={`${fmtPct(current.finals_pct)} Finals`} />
        </div>
      )}

      {summary && chart ? (
        <>
          <p className="mt-4 border-l-2 border-cat-hoops/50 pl-3 text-sm text-cream-dim">
            {trendVerdict(summary)} Playoff odds {fmtPct(summary.first.playoffPct)} →{" "}
            {fmtPct(summary.last.playoffPct)}, title {fmtPct(summary.first.titlePct)} →{" "}
            {fmtPct(summary.last.titlePct)}.
          </p>

          <div className="mt-4 flex gap-2" role="img" aria-label={`${tri} projected wins by night`}>
            {/* y labels, in a gutter, at the chart's own percentages */}
            <div className="relative h-44 w-6 shrink-0">
              {chart.yTicks.map((t) => (
                <span
                  key={t.label}
                  className="absolute right-0 -translate-y-1/2 font-mono text-[0.58rem] tabular-nums text-cream-dimmer"
                  style={{ top: `${t.y}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <div className="relative h-44 border-b border-l border-rule/60">
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="absolute inset-0 h-full w-full overflow-visible"
                  aria-hidden
                >
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
                  <path d={chart.band} className="fill-cat-hoops/15" />
                  <line
                    x1="0"
                    x2="100"
                    y1={chart.startY}
                    y2={chart.startY}
                    className="stroke-cream-dimmer"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                  />
                  <path
                    d={chart.line}
                    fill="none"
                    className="stroke-cat-hoops"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                {/* tonight's point, as HTML so it stays round */}
                <span
                  className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cat-hoops"
                  style={{ left: `${chart.dots[chart.dots.length - 1].x}%`, top: `${chart.dots[chart.dots.length - 1].y}%` }}
                  title={`${fmtAsOf(last.date)}: ${last.projWins.toFixed(1)} projected wins`}
                />
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
          </div>

          <p className="mt-2 text-xs text-cream-dimmer">
            Projected wins after each night&rsquo;s games, from {fmtAsOf(summary.first.date)} to{" "}
            {fmtAsOf(summary.last.date)}; the shaded band is the 80% range, and the dashed line is where
            the projection started. A line climbing above it means {tri} has been winning more than its
            ratings said it would.
            {summary.rebuiltThrough && (
              <>
                {" "}
                Nights through {fmtAsOf(summary.rebuiltThrough)} were re-run afterwards with today&rsquo;s
                model, using only the games and injury list known that night; later nights are as the
                nightly ran them.
              </>
            )}
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs text-cream-dimmer">
          The season&rsquo;s line starts once two nights of projections are stored.
        </p>
      )}

      <p className="mt-3 font-mono text-[0.62rem] uppercase tracking-kicker">
        <Link href="/hoops/sim/projections" className="text-cat-hoops hover:text-cream">
          Whole league&rsquo;s projection →
        </Link>
      </p>
    </section>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={`border px-3 py-2 ${accent ? "border-cat-hoops/70 bg-cat-hoops/10" : "border-rule/60"}`}>
      <p className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">{label}</p>
      <p className={`mt-1 font-display text-xl tabular-nums ${accent ? "text-cat-hoops" : "text-cream"}`}>{value}</p>
      <p className="font-mono text-[0.62rem] text-cream-dimmer">{sub}</p>
    </div>
  );
}
