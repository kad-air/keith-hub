import type { Histogram } from "@/lib/hoops/matchup";

/** A margin value → "DEN by 12" / "OKC by 8" / "level". */
function edgeLabel(margin: number, home: string, away: string): string {
  const n = Math.round(margin);
  if (n === 0) return "level";
  return `${n > 0 ? home : away} by ${Math.abs(n)}`;
}

/**
 * The margin distribution, in bars.
 *
 * 🔴 This is the point of the matchup screen, not decoration. "Denver by 6" is
 * the middle of a cloud roughly 16 points wide, and a single number on screen
 * reads as a prediction while the same number sitting on top of its own spread
 * reads as what it is. The mean line is drawn ON the histogram for that
 * reason.
 *
 * Rendered as plain divs rather than a chart library: it is one series of
 * counts, it has to be server-renderable, and the section already avoids
 * runtime dependencies.
 */
export default function MarginHistogram({
  hist,
  home,
  away,
  meanMargin,
}: {
  hist: Histogram;
  home: string;
  away: string;
  meanMargin: number;
}) {
  const max = Math.max(1, ...hist.counts);
  const total = hist.counts.reduce((s, c) => s + c, 0) || 1;
  const width = hist.counts.length * hist.binWidth;

  // Where the mean and the zero line fall, as a fraction across the bars.
  const frac = (v: number): number => Math.min(1, Math.max(0, (v - hist.min) / width));

  return (
    <figure className="mt-5">
      <div className="flex items-end gap-px" style={{ height: "88px" }} aria-hidden>
        {hist.counts.map((c, i) => {
          const left = hist.min + i * hist.binWidth;
          const homeSide = left + hist.binWidth / 2 > 0;
          return (
            <div
              key={i}
              className={`flex-1 ${homeSide ? "bg-cat-hoops/70" : "bg-cream-dimmer/40"}`}
              style={{ height: `${Math.max(1, (c / max) * 100)}%` }}
            />
          );
        })}
      </div>

      {/* Zero and mean markers, under the bars where they can't obscure them. */}
      <div className="relative h-4">
        <span
          className="absolute top-0 -translate-x-1/2 font-mono text-[0.58rem] text-cream-dimmer"
          style={{ left: `${frac(0) * 100}%` }}
        >
          |
        </span>
        <span
          className="absolute top-0 -translate-x-1/2 font-mono text-[0.58rem] text-cat-hoops"
          style={{ left: `${frac(meanMargin) * 100}%` }}
        >
          ▲
        </span>
      </div>

      <figcaption className="flex justify-between font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
        {/* Labelled from the margin's own sign rather than assuming the range
            straddles zero — a lopsided enough matchup can put every simulated
            game on one side, and "OKC by -12" would be nonsense. */}
        <span>{edgeLabel(hist.min, home, away)}</span>
        <span className="normal-case tracking-normal text-cream-dim">
          {total.toLocaleString()} simulated games
        </span>
        <span>{edgeLabel(hist.min + width, home, away)}</span>
      </figcaption>
    </figure>
  );
}
