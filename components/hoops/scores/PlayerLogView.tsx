"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { shortDate } from "@/lib/hoops/scores/dates";
import { averages, openLines, type Averages, type ShownLine } from "@/lib/hoops/scores/guard";
import { loadSpoiler } from "@/lib/hoops/scores/spoilerStore";
import type { PlayerGameLine, SeasonKind } from "@/lib/hoops/scores/types";

const KIND_LABEL: Record<SeasonKind, string> = {
  preseason: "Preseason",
  regular: "Regular season",
  postseason: "Playoffs",
  other: "Other",
};
const KIND_ORDER: SeasonKind[] = ["postseason", "regular", "preseason", "other"];
const HEAD = ["MIN", "PTS", "REB", "AST", "STL", "BLK", "TO", "FG", "3P", "FT"];

/**
 * A player's per-game averages and game log, by season type.
 *
 * 🔴 The server ships each guarded line bare (lib/hoops/scores/guard.ts). On
 * mount this reads the viewer's spoiler choices for those lines' dates — the
 * same per-device store the scores pages write — and asks
 * /api/hoops/scores/players/<id>/log for the lines of the games unlocked
 * there (revealed, or synced through the final). Those come back whole and
 * count in the averages; a game still locked stays a bare row and stays out.
 */
export default function PlayerLogView({ playerId, shown: initial }: { playerId: string; shown: ShownLine[] }) {
  const [shown, setShown] = useState(initial);

  useEffect(() => {
    const dates = [...new Set(initial.filter((s) => s.hidden).map((s) => s.line.date))];
    if (dates.length === 0) return;
    const ids = new Set(initial.filter((s) => s.hidden).map((s) => s.line.gameId));
    const reveal: string[] = [];
    const sync: string[] = [];
    for (const d of dates) {
      for (const [id, e] of Object.entries(loadSpoiler(d))) {
        if (!ids.has(id)) continue;
        if (e.mode === "revealed") reveal.push(id);
        else sync.push(`${id}:${e.offsetMs}`);
      }
    }
    if (reveal.length === 0 && sync.length === 0) return;
    const qs = new URLSearchParams();
    if (reveal.length) qs.set("reveal", reveal.join(","));
    if (sync.length) qs.set("sync", sync.join(","));
    let alive = true;
    fetch(`/api/hoops/scores/players/${playerId}/log?${qs}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ lines: PlayerGameLine[] }>) : null))
      .then((body) => {
        if (alive && body?.lines?.length) setShown(openLines(initial, body.lines));
      })
      .catch(() => {
        /* the bare rows stand */
      });
    return () => {
      alive = false;
    };
  }, [playerId, initial]);

  const hidden = shown.filter((s) => s.hidden).length;
  const kinds = KIND_ORDER.filter((k) => shown.some((s) => s.line.seasonKind === k));
  const headKind = kinds.find((k) => averages(shown, k)) ?? null;
  const avg = headKind ? averages(shown, headKind) : null;

  return (
    <>
      {avg && headKind && <AveragesLine kind={headKind} avg={avg} />}
      {hidden > 0 && (
        <p className="mt-1 font-mono text-[0.62rem] text-cream-dimmer">
          {hidden === 1 ? "One game you haven't unlocked is" : `${hidden} games you haven't unlocked are`} hidden
          and left out of the averages.
        </p>
      )}
      {kinds.map((k) => (
        <LogTable key={k} kind={k} lines={shown.filter((s) => s.line.seasonKind === k)} />
      ))}
    </>
  );
}

const one = (n: number) => n.toFixed(1);
const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);

function AveragesLine({ kind, avg }: { kind: SeasonKind; avg: Averages }) {
  const cells: [string, string][] = [
    ["PTS", one(avg.pts)],
    ["REB", one(avg.reb)],
    ["AST", one(avg.ast)],
    ["MIN", one(avg.min)],
    ["FG%", pct(avg.fgPct)],
    ["3P%", pct(avg.tpPct)],
    ["FT%", pct(avg.ftPct)],
  ];
  return (
    <section className="mt-6">
      <h3 className="mb-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">
        Per game · {KIND_LABEL[kind]} · {avg.gp} {avg.gp === 1 ? "game" : "games"}
      </h3>
      <div className="grid grid-cols-3 gap-2 xs:grid-cols-4 sm:grid-cols-7">
        {cells.map(([k, v]) => (
          <div key={k} className="border border-rule/40 px-2 py-1.5 font-mono tabular-nums">
            <p className="text-[0.56rem] uppercase tracking-kicker text-cream-dimmer">{k}</p>
            <p className="text-sm text-cream">{v}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function LogTable({ kind, lines }: { kind: SeasonKind; lines: ShownLine[] }) {
  return (
    <section className="mt-8">
      <h3 className="mb-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">
        Game log · {KIND_LABEL[kind]}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap font-mono text-[0.72rem] tabular-nums">
          <thead>
            <tr className="border-b border-rule/60 text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
              <th className="sticky left-0 bg-ink pb-1 pr-2 text-left font-normal">Date</th>
              <th className="px-1.5 pb-1 text-left font-normal">Opp</th>
              <th className="px-1.5 pb-1 text-left font-normal">Result</th>
              {HEAD.map((h) => (
                <th key={h} className="px-1.5 pb-1 text-right font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((s) => {
              const l = s.line;
              const slug = (l.home ? `${l.opp}-${l.tri}` : `${l.tri}-${l.opp}`).toLowerCase();
              const href = `/hoops/scores/${l.date}/${slug}`;
              return (
                <tr key={l.gameId} className="border-b border-rule/30">
                  <td className="sticky left-0 bg-ink py-1.5 pr-2 text-left text-cream-dimmer">{shortDate(l.date)}</td>
                  <td className="px-1.5 text-left">
                    <span className="text-cream-dimmer">{l.home ? "vs " : "@ "}</span>
                    <Link href={`/hoops/scores/teams/${l.opp.toLowerCase()}`} className="text-cream hover:text-cat-hoops">
                      {l.opp}
                    </Link>
                  </td>
                  {s.hidden ? (
                    <td colSpan={HEAD.length + 1} className="px-1.5 text-left">
                      <Link href={href} className="text-cream-dimmer hover:text-cat-hoops" data-kb-item>
                        Hidden · open the game →
                      </Link>
                    </td>
                  ) : (
                    <>
                      <td className="px-1.5 text-left">
                        <Link href={href} className="hover:text-cat-hoops" data-kb-item>
                          {s.line.result && (
                            <span className={s.line.result === "W" ? "text-cat-hoops" : "text-cream-dim"}>
                              {s.line.result}{" "}
                            </span>
                          )}
                          <span className="text-cream">
                            {s.line.teamScore ?? "–"}-{s.line.oppScore ?? "–"}
                          </span>
                        </Link>
                      </td>
                      {[
                        String(s.line.min),
                        String(s.line.pts),
                        String(s.line.reb),
                        String(s.line.ast),
                        String(s.line.stl),
                        String(s.line.blk),
                        String(s.line.to),
                        `${s.line.fgm}-${s.line.fga}`,
                        `${s.line.tpm}-${s.line.tpa}`,
                        `${s.line.ftm}-${s.line.fta}`,
                      ].map((c, j) => (
                        <td key={j} className={`px-1.5 text-right ${j === 1 ? "text-cream" : "text-cream-dim"}`}>
                          {c}
                        </td>
                      ))}
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
