import type { Metadata } from "next";
import Link from "next/link";
import HoopsNav from "@/components/hoops/HoopsNav";
import { FRANCHISES } from "@/lib/hoops/nba-franchises";

export const metadata: Metadata = { title: "Hoops · Teams — hub" };

const CONFERENCES = ["East", "West"] as const;

/**
 * The 30 real clubs by conference and division, each linking to its page
 * (roster, recent and upcoming games, schedule). A fixed list
 * (nba-franchises.ts), so it renders without a fetch — and shows no records:
 * those live on the team pages, where the spoiler guard can leave last
 * night's results out.
 */
export default function HoopsScoresTeamsPage() {
  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav area="scores" active="teams" />
      <div className="grid gap-8 sm:grid-cols-2">
        {CONFERENCES.map((conf) => {
          const tris = Object.keys(FRANCHISES).filter((t) => FRANCHISES[t].conference === conf);
          const divisions = [...new Set(tris.map((t) => FRANCHISES[t].division))].sort();
          return (
            <section key={conf}>
              <h3 className="mb-3 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">{conf}</h3>
              {divisions.map((d) => (
                <div key={d} className="mb-4">
                  <p className="mb-1 font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">{d}</p>
                  <ul>
                    {tris
                      .filter((t) => FRANCHISES[t].division === d)
                      .sort((a, b) => FRANCHISES[a].name.localeCompare(FRANCHISES[b].name))
                      .map((t) => (
                        <li key={t} className="border-b border-rule/40">
                          <Link
                            href={`/hoops/scores/teams/${t.toLowerCase()}`}
                            className="flex items-baseline gap-2 py-1.5 hover:text-cat-hoops"
                            data-kb-item
                          >
                            <span className="w-9 font-mono text-[0.72rem] text-cream">{t}</span>
                            <span className="font-display text-sm text-cream-dim">{FRANCHISES[t].name}</span>
                          </Link>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </article>
  );
}
