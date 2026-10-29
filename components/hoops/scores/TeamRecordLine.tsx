"use client";

import { tally, resultFor, type HeldGame, type RecordResult } from "@/lib/hoops/scores/guard";
import { useLive } from "./LiveProvider";

/**
 * A team's record line: W-L, home/road, streak and the last-five strip.
 *
 * 🔴 The server counts it without the team's guarded games (lib/hoops/scores/
 * guard.ts teamRecord) and lists those as `held`. Under a LiveProvider each
 * one the viewer has unlocked on this device — revealed, or synced to a
 * moment that reached the final — comes back on the live tick with its real
 * score, and is added back here. A game still veiled, live, or synced short of
 * the final stays out, and the line says how many.
 */
export default function TeamRecordLine({
  tri,
  label,
  results,
  held,
  recentN = 5,
}: {
  tri: string;
  label: string | null;
  /** The unguarded finished games, oldest first. */
  results: RecordResult[];
  /** The guarded games left out, in tip order. */
  held: HeldGame[];
  recentN?: number;
}) {
  const live = useLive();
  const opened: RecordResult[] = [];
  for (const h of held) {
    const lg = live.games[h.id];
    if (!lg || lg.veiled || (lg.moment && !lg.moment.final)) continue;
    const won = resultFor(lg.game, tri);
    if (won !== null) opened.push({ home: h.home, won });
  }
  // Guarded games are the newest the team has played, so they follow the rest.
  const rec = tally([...results, ...opened], held.length - opened.length, recentN);
  const split = (s: [number, number]) => `${s[0]}-${s[1]}`;
  return (
    <div className="mt-2 font-mono text-[0.72rem] tabular-nums text-cream-dim">
      <p>
        {label && <span className="text-cream-dimmer">{label} </span>}
        <span className="text-base text-cream">
          {rec.wins}-{rec.losses}
        </span>
        <span className="text-cream-dimmer"> · home </span>
        {split(rec.home)}
        <span className="text-cream-dimmer"> · road </span>
        {split(rec.road)}
        {rec.streak && (
          <>
            <span className="text-cream-dimmer"> · </span>
            {rec.streak}
          </>
        )}
        {rec.recent.length > 0 && (
          <span className="ml-2 tracking-[0.15em]">
            {rec.recent.map((r, i) => (
              <span key={i} className={r === "W" ? "text-cat-hoops" : "text-cream-dimmer"}>
                {r}
              </span>
            ))}
          </span>
        )}
      </p>
      {rec.held > 0 && (
        <p className="mt-0.5 text-[0.62rem] text-cream-dimmer">
          Leaves out {rec.held === 1 ? "a game" : `${rec.held} games`} you haven&apos;t unlocked yet.
        </p>
      )}
    </div>
  );
}
