import Link from "next/link";
import { FRANCHISES } from "@/lib/hoops/nba-franchises";
import { conferenceTable, fmtPct, fmtProjRecord, fmtWinRange } from "@/lib/hoops/projections";
import type { RawProjectionTeam } from "@/lib/hoops/types";

/**
 * One conference of the rest-of-season projection, in the order
 * lib/hoops/projections.ts decides (projected wins, descending — the gate
 * asserts the same function, so the page and the check cannot disagree).
 * Dense monospace, the /hoops/scores/standings shape, so the two tables read as a
 * pair one tab apart. Below `sm` the three deep-playoff columns fold away:
 * seven columns of short numbers fit a 280px cover screen, ten do not.
 */
export default function ProjectionTable({
  conference,
  rows,
}: {
  conference: "East" | "West";
  rows: readonly RawProjectionTeam[];
}) {
  const table = conferenceTable(rows, conference);
  return (
    <section>
      <h3 className="mb-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">{conference}</h3>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[0.74rem] tabular-nums">
          <thead>
            <tr className="border-b border-rule/60 text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
              <th className="w-6 pb-1 text-right font-normal">#</th>
              <th className="pb-1 pl-2 text-left font-normal">Team</th>
              <th className="px-1 pb-1 text-right font-normal">W-L</th>
              <th className="px-1 pb-1 text-right font-normal">Proj</th>
              <th className="px-1 pb-1 text-right font-normal">80%</th>
              <th className="px-1 pb-1 text-right font-normal">Playoffs</th>
              <th className="px-1 pb-1 text-right font-normal max-sm:hidden">Play-in</th>
              <th className="px-1 pb-1 text-right font-normal max-sm:hidden">Conf F</th>
              <th className="px-1 pb-1 text-right font-normal max-sm:hidden">Finals</th>
              <th className="px-1 pb-1 text-right font-normal">Title</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r, i) => (
              <tr
                key={r.team}
                className={`border-b ${i === 5 || i === 9 ? "border-rule" : "border-rule/30"}`}
              >
                <td className="py-1 text-right text-cream-dimmer">{i + 1}</td>
                <td className="whitespace-nowrap pl-2 text-left">
                  <Link href={`/hoops/sim/teams/${r.team}`} className="text-cream hover:text-cat-hoops">
                    {r.team}
                  </Link>
                  <span className="ml-1.5 font-display text-[0.8rem] text-cream-dimmer max-sm:hidden">
                    {FRANCHISES[r.team]?.name ?? ""}
                  </span>
                </td>
                <td className="px-1 text-right text-cream-dim">
                  {r.wins}-{r.losses}
                </td>
                <td className="px-1 text-right text-cream">{fmtProjRecord(r)}</td>
                <td className="px-1 text-right text-cream-dim">{fmtWinRange(r)}</td>
                <td className="px-1 text-right text-cream">{fmtPct(r.playoff_pct)}</td>
                <td className="px-1 text-right text-cream-dim max-sm:hidden">{fmtPct(r.playin_pct)}</td>
                <td className="px-1 text-right text-cream-dim max-sm:hidden">{fmtPct(r.conf_finals_pct)}</td>
                <td className="px-1 text-right text-cream-dim max-sm:hidden">{fmtPct(r.finals_pct)}</td>
                <td className={`px-1 text-right ${r.title_pct >= 0.1 ? "text-cat-hoops" : "text-cream-dim"}`}>
                  {fmtPct(r.title_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
