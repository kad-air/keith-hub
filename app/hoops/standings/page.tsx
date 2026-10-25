import type { Metadata } from "next";
import Link from "next/link";
import HoopsNav from "@/components/hoops/HoopsNav";
import { SourceNote } from "@/components/hoops/scores/SourceNote";
import { getStandings, sourceMeta } from "@/lib/hoops/scores/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hoops · Standings — hub" };

/**
 * Real standings by conference, off the same live upstream as /hoops/scores
 * (not the hoops-sim bundle). Order is the source's playoff seed, which
 * carries the tiebreakers. A rule under 6th and 10th marks the play-in.
 */
export default async function HoopsStandingsPage() {
  const st = await getStandings();
  const cols = ["W", "L", "PCT", "GB", "L10", "STRK"];
  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="standings" />
      {st.data?.season && (
        <p className="mb-4 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          {st.data.season} · <Link href="/hoops/scores" className="text-cat-hoops hover:text-cream">Scores</Link>
        </p>
      )}
      {!st.data ? (
        <p className="font-display text-sm text-cream-dim">Standings unavailable right now.</p>
      ) : (
        <div className="grid gap-8">
          {st.data.conferences.map((c) => (
            <section key={c.name}>
              <h3 className="mb-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">{c.name}</h3>
              <table className="w-full font-mono text-[0.74rem] tabular-nums">
                <thead>
                  <tr className="border-b border-rule/60 text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
                    <th className="w-6 pb-1 text-right font-normal">#</th>
                    <th className="pb-1 pl-2 text-left font-normal">Team</th>
                    {cols.map((h) => (
                      <th key={h} className="px-1 pb-1 text-right font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((r, i) => (
                    <tr
                      key={r.tri}
                      className={`border-b ${i === 5 || i === 9 ? "border-rule" : "border-rule/30"}`}
                    >
                      <td className="py-1 text-right text-cream-dimmer">{i + 1}</td>
                      <td className="whitespace-nowrap pl-2 text-left">
                        <span className="text-cream">{r.tri}</span>
                        <span className="ml-1.5 font-display text-[0.8rem] text-cream-dimmer max-sm:hidden">
                          {r.name}
                        </span>
                      </td>
                      <td className="px-1 text-right text-cream">{r.wins}</td>
                      <td className="px-1 text-right text-cream">{r.losses}</td>
                      <td className="px-1 text-right text-cream-dim">{r.pct}</td>
                      <td className="px-1 text-right text-cream-dim">{r.gb}</td>
                      <td className="px-1 text-right text-cream-dim">{r.l10}</td>
                      <td className="px-1 text-right text-cream-dim">{r.streak}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
      {st.data && (
        <p className="mt-3 font-mono text-[0.6rem] text-cream-dimmer">
          Rules under 6th and 10th: 1–6 go straight to the playoffs, 7–10 to the play-in.
        </p>
      )}
      <SourceNote fetched={[sourceMeta(st)]} />
    </article>
  );
}
