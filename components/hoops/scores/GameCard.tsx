"use client";

import Link from "next/link";
import { gameSlug, tvLabel } from "@/lib/hoops/scores/parse";
import { periodLabels, statusLabel } from "@/lib/hoops/scores/format";
import { useLiveGame } from "./LiveProvider";
import type { Game, TeamLine } from "@/lib/hoops/scores/types";

/**
 * One game, plaintextsports-dense: a status line (tip time in Mountain, the
 * live clock, or Final) with the network on the right, then a row per team —
 * tri, record, points by quarter (overtimes appended), total. Away on top,
 * the US convention. The whole card links to the box score.
 *
 * Renders the server's Game until a LiveProvider tick carries a fresher copy
 * (clock, totals, state — see lib/hoops/scores/live.ts); a live game also
 * prints its last play. Without a provider it is just the server's card.
 */
export default function GameCard({ game: initial, date }: { game: Game; date: string }) {
  const live = useLiveGame(initial.id);
  const game = live?.game ?? initial;
  const n = Math.max(game.away.linescore.length, game.home.linescore.length);
  const started = game.state !== "pre" && n > 0;
  const labels = started ? periodLabels(n) : [];
  const inProgress = game.state === "in";

  const row = (t: TeamLine) => {
    const won = game.state === "post" && t.winner;
    return (
      <tr className={won ? "text-cream" : "text-cream-dim"}>
        <td className="py-0.5 pr-2 text-left">
          <span className={won ? "font-semibold text-cream" : ""}>{t.tri}</span>
          <span className="ml-1.5 font-display text-[0.8rem] text-cream-dimmer max-sm:hidden">
            {t.nickname}
          </span>
        </td>
        <td className="pr-2 text-left text-[0.62rem] text-cream-dimmer">{t.record ?? ""}</td>
        {labels.map((_, i) => (
          <td key={i} className="w-7 text-right text-[0.66rem] text-cream-dimmer">
            {t.linescore[i] ?? ""}
          </td>
        ))}
        <td className={`w-10 text-right ${won ? "font-semibold" : ""}`}>{t.score ?? ""}</td>
      </tr>
    );
  };

  return (
    <Link
      href={`/hoops/scores/${date}/${gameSlug(game)}`}
      className="block border border-rule/60 px-3 py-2 transition-colors hover:border-cat-hoops/40 hover:bg-ink-raised/60"
    >
      <div className="flex items-baseline justify-between gap-2 font-mono text-[0.62rem] uppercase tracking-kicker">
        <span className={inProgress ? "text-cat-hoops" : "text-cream-dimmer"}>
          {inProgress && <span aria-hidden>● </span>}
          {statusLabel(game)}
        </span>
        <span className="truncate text-cream-dimmer">{tvLabel(game.tv)}</span>
      </div>
      {inProgress && live?.lastPlay && (
        <p className="mt-0.5 truncate font-mono text-[0.6rem] text-cream-dim">
          <span className="text-cream-dimmer">
            {live.lastPlay.clock ? `${live.lastPlay.clock} · ` : ""}
          </span>
          {live.lastPlay.text}
        </p>
      )}
      {(game.note || game.series) && (
        <p className="mt-0.5 truncate font-mono text-[0.6rem] text-cream-dimmer">
          {[game.note, game.series].filter(Boolean).join(" · ")}
        </p>
      )}
      <table className="mt-1 w-full font-mono text-[0.78rem] tabular-nums">
        {started && (
          <thead>
            <tr className="text-[0.56rem] uppercase text-cream-dimmer">
              <th className="text-left font-normal" />
              <th className="font-normal" />
              {labels.map((l) => (
                <th key={l} className="w-7 text-right font-normal">
                  {l}
                </th>
              ))}
              <th className="w-10 text-right font-normal">T</th>
            </tr>
          </thead>
        )}
        <tbody>
          {row(game.away)}
          {row(game.home)}
        </tbody>
      </table>
    </Link>
  );
}
