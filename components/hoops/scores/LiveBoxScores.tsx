"use client";

import type { ReactNode } from "react";
import RealBoxTable from "./RealBoxTable";
import { useGameView, useLive, useLiveGame } from "./LiveProvider";
import { periodWord } from "@/lib/hoops/scores/spoiler";
import type { TeamBoxScore } from "@/lib/hoops/scores/types";

/** The game page's two box scores: the server render until the first live
 *  tick lands, then whatever the tick carried.
 *
 *  `guarded` (spoiler mode — today's page, a started game): the server render
 *  carries no box at all, and the tick decides — veiled shows nothing, synced
 *  shows the box HELD to the viewer's moment (rebuilt from the plays, no
 *  minutes or +/-), revealed shows the live box. */
export default function LiveBoxScores({
  initial,
  gameId,
  guarded = false,
}: {
  initial: TeamBoxScore[];
  gameId: string;
  guarded?: boolean;
}) {
  const { box, held } = useLive();
  const view = useGameView(gameId, guarded);
  const lg = useLiveGame(gameId);

  if (view === "pending") return <Note>Loading…</Note>;
  if (view === "veiled") {
    return <Note>Box score hidden. Tap the game above to sync it to where you are, or hold it to reveal.</Note>;
  }
  if (view === "early") return <Note>You&rsquo;re before the opening tip, so there&rsquo;s nothing to show yet.</Note>;

  const teams = box?.teams?.length ? box.teams : guarded ? [] : initial;
  if (teams.length === 0) return <Note>Box score unavailable right now.</Note>;
  const m = view === "synced" ? lg?.moment : null;
  return (
    <>
      {m && held && (
        <p className="mt-4 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          As of {m.clock ?? ""} {periodWord(m.period)} · rebuilt from the play-by-play · minutes and +/- appear once
          you&rsquo;re caught up
        </p>
      )}
      {teams.map((t) => (
        <RealBoxTable key={t.tri} team={t} held={guarded && held} />
      ))}
    </>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-6 font-display text-sm text-cream-dim">{children}</p>;
}
