import type { PlayerBoxLine, TeamBoxScore, TeamTotals } from "@/lib/hoops/scores/types";

/**
 * A REAL box score — one team's full lines off the upstream, starters first.
 * Same visual language as BoxScoreTable.tsx (the simulated one), but its own
 * component: the sim's table is shaped around expected/sampled lines and must
 * stay untouched.
 *
 * Every column is kept at every width and the table scrolls sideways on a
 * phone, with the name column pinned — a real box score is read across, and
 * dropping FT or +/- would lose the line. Names go first-initial below `sm`.
 */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${[...parts[0]][0]}. ${parts.slice(1).join(" ")}`;
}

const pm = (v: number | null) => (v == null ? "" : v > 0 ? `+${v}` : String(v));

const HEAD = ["MIN", "PTS", "REB", "AST", "STL", "BLK", "TO", "FG", "3P", "FT", "+/-"];

function cells(p: TeamTotals & { min?: number; plusMinus?: number | null }): string[] {
  return [
    p.min == null ? "" : String(p.min),
    String(p.pts),
    String(p.reb),
    String(p.ast),
    String(p.stl),
    String(p.blk),
    String(p.to),
    `${p.fgm}-${p.fga}`,
    `${p.tpm}-${p.tpa}`,
    `${p.ftm}-${p.fta}`,
    p.plusMinus === undefined ? "" : pm(p.plusMinus),
  ];
}

const pct = (m: number, a: number) => (a ? `${((m / a) * 100).toFixed(1)}%` : "–");

export default function RealBoxTable({ team }: { team: TeamBoxScore }) {
  const played = team.players.filter((p) => !p.dnp);
  const dnp = team.players.filter((p) => p.dnp);
  const firstBench = played.findIndex((p) => !p.starter);

  const row = (p: PlayerBoxLine, i: number) => (
    <tr
      key={p.id || p.name}
      className={`border-b border-rule/40 ${i === firstBench && i > 0 ? "border-t border-t-rule" : ""}`}
    >
      <td className="sticky left-0 whitespace-nowrap bg-ink py-1.5 pr-3 text-left font-display text-sm text-cream">
        <span className="sm:hidden">{shortName(p.name)}</span>
        <span className="max-sm:hidden">{p.name}</span>
        {p.starter && <span className="ml-1 font-mono text-[0.55rem] text-cream-dimmer">S</span>}
        {p.ejected && <span className="ml-1 font-mono text-[0.55rem] text-cat-hoops">EJ</span>}
      </td>
      {cells(p).map((c, j) => (
        <td
          key={j}
          className={`px-1.5 text-right text-[0.72rem] ${j === 1 ? "text-cream" : "text-cream-dim"}`}
        >
          {c}
        </td>
      ))}
    </tr>
  );

  return (
    <section className="mt-6">
      <h3 className="font-display text-lg text-cream">
        <span className="font-mono text-[0.72rem] text-cat-hoops">{team.tri}</span> {team.name}
      </h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full whitespace-nowrap font-mono tabular-nums">
          <thead>
            <tr className="border-b border-rule/60 text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
              <th className="sticky left-0 bg-ink pb-1 text-left font-normal">Player</th>
              {HEAD.map((h) => (
                <th key={h} className="px-1.5 pb-1 text-right font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {played.map(row)}
            <tr className="border-b-2 border-rule">
              <td className="sticky left-0 bg-ink py-1.5 text-left text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                Team
              </td>
              {cells({ ...team.totals, min: undefined, plusMinus: undefined }).map((c, j) => (
                <td key={j} className="px-1.5 text-right text-[0.72rem] text-cream">
                  {c}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-1 font-mono text-[0.6rem] text-cream-dimmer">
        FG {pct(team.totals.fgm, team.totals.fga)} · 3P {pct(team.totals.tpm, team.totals.tpa)} · FT{" "}
        {pct(team.totals.ftm, team.totals.fta)} · {team.totals.oreb} off reb · {team.totals.pf} fouls
      </p>
      {dnp.length > 0 && (
        <p className="mt-1 font-mono text-[0.6rem] text-cream-dimmer">
          DNP: {dnp.map((p) => (p.dnpReason ? `${p.name} (${p.dnpReason.toLowerCase()})` : p.name)).join(", ")}
        </p>
      )}
    </section>
  );
}
