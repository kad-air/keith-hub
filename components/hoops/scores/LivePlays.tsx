"use client";

import type { ReactNode } from "react";
import { useGameView, useLive, useLiveGame } from "./LiveProvider";
import { periodWord } from "@/lib/hoops/scores/spoiler";
import type { WirePlay } from "@/lib/hoops/scores/types";

interface Side {
  tri: string;
  espnId: string;
}

/**
 * The game page's play-by-play tab: every play, newest first, a section per
 * period (newest period on top), with a row of period links to jump down.
 *
 * `guarded` (spoiler mode — today's page, a started game): the server render
 * carries no plays, and each tick brings exactly what the viewer may see —
 * nothing while veiled, the plays up to the synced moment (the server cuts the
 * list; nothing after the moment is on the wire, so neither the length of the
 * list nor a later period's header gives anything away), or all of them once
 * revealed. Unguarded (another day, or a game not protected): the server's
 * plays, then whatever a live tick carries.
 */
export default function LivePlays({
  initial,
  gameId,
  guarded = false,
  away,
  home,
}: {
  initial: WirePlay[];
  gameId: string;
  guarded?: boolean;
  away: Side;
  home: Side;
}) {
  const live = useLive();
  const view = useGameView(gameId, guarded);
  const lg = useLiveGame(gameId);

  if (view === "pending") return <Note>Loading…</Note>;
  if (view === "veiled") {
    return <Note>Plays hidden. Tap the game above to sync it to where you are, or hold it to reveal.</Note>;
  }
  if (view === "early") return <Note>You&rsquo;re before the opening tip, so there are no plays to show yet.</Note>;

  const plays = live.plays ?? (guarded ? null : initial);
  if (!plays) return <Note>Play-by-play unavailable right now.</Note>;
  if (plays.length === 0) return <Note>No plays yet.</Note>;

  const tri = (teamId: string | null) =>
    teamId === away.espnId ? away.tri : teamId === home.espnId ? home.tri : "";

  // Newest period first, newest play first within it.
  const periods: { period: number; plays: WirePlay[] }[] = [];
  for (const p of plays) {
    const last = periods.at(-1);
    if (last && last.period === p.period) last.plays.push(p);
    else periods.push({ period: p.period, plays: [p] });
  }
  periods.reverse();
  for (const q of periods) q.plays.reverse();

  const m = view === "synced" ? lg?.moment : null;
  return (
    <section className="mt-5">
      {m && (
        <p className="mb-2 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          Through {m.clock ?? ""} {periodWord(m.period)} · follows along as you watch
        </p>
      )}
      {periods.length > 1 && (
        <nav className="mb-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.62rem] uppercase tracking-kicker">
          {[...periods].reverse().map((q) => (
            <a key={q.period} href={`#q${q.period}`} className="text-cream-dimmer hover:text-cream">
              {periodWord(q.period)}
            </a>
          ))}
        </nav>
      )}
      {periods.map((q) => (
        <div key={q.period} id={`q${q.period}`} className="mb-4 scroll-mt-4">
          <h3 className="border-b border-rule/60 pb-1 font-mono text-[0.66rem] uppercase tracking-kicker text-cat-hoops">
            {q.period <= 4 ? `${periodWord(q.period)} quarter` : periodWord(q.period)}
            <span className="float-right text-cream-dimmer">
              {away.tri}–{home.tri}
            </span>
          </h3>
          <ol className="font-mono text-[0.7rem] tabular-nums">
            {q.plays.map((p, i) => (
              <li
                key={p.id || `${q.period}-${i}`}
                className={`flex items-baseline gap-2 border-b border-rule/30 py-1 ${p.scoring ? "text-cream" : "text-cream-dim"}`}
              >
                <span className="w-9 shrink-0 text-right text-cream-dimmer">{p.clock ?? ""}</span>
                <span className="w-8 shrink-0 text-cream-dimmer">{tri(p.teamId)}</span>
                <span className="min-w-0 flex-1 font-display text-[0.8rem] leading-snug">{p.text}</span>
                <span className={`shrink-0 text-right ${p.scoring ? "font-semibold" : "text-cream-dimmer"}`}>
                  {p.awayScore}–{p.homeScore}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-6 font-display text-sm text-cream-dim">{children}</p>;
}
