import Link from "next/link";
import { NOTABLE_RULES } from "@/lib/hoops/scores/notable";
import type { NotableLine } from "@/lib/hoops/scores/types";

/** Standout lines from the day's finished games, best first. Finite: it is
 *  one day's games, so it ends. */
export default function NotableList({
  lines,
  missing,
  title = "Notable",
}: {
  lines: NotableLine[];
  missing: number;
  title?: string;
}) {
  return (
    <section className="mt-8">
      <h3 className="font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">{title}</h3>
      {lines.length === 0 ? (
        <p className="mt-2 font-display text-sm text-cream-dim">Nothing over the bar.</p>
      ) : (
        <ol className="mt-2">
          {lines.map((n) => {
            const p = n.line;
            return (
              <li key={`${n.gameId}-${n.playerId}`} className="border-b border-rule/40">
                <Link href={n.href} className="block py-1.5 hover:bg-ink-raised/60">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="min-w-0 font-display text-sm text-cream">
                      {n.name}{" "}
                      <span className="font-mono text-[0.62rem] text-cream-dimmer">
                        {n.tri} v {n.opp}
                      </span>
                    </span>
                    <span className="font-mono text-[0.6rem] uppercase tracking-kicker text-cat-hoops">
                      {n.reasons.join(" · ")}
                    </span>
                  </div>
                  <p className="font-mono text-[0.66rem] tabular-nums text-cream-dim">
                    {p.pts} pts · {p.reb} reb · {p.ast} ast · {p.stl} stl · {p.blk} blk · {p.fgm}-{p.fga} fg ·{" "}
                    {p.tpm}-{p.tpa} 3p · {p.min} min
                  </p>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-2 font-mono text-[0.58rem] text-cream-dimmer">
        The bar: {NOTABLE_RULES.join(", ")}. Finished games only.
        {missing > 0 && ` ${missing} box score${missing === 1 ? "" : "s"} couldn't be loaded.`}
      </p>
    </section>
  );
}
