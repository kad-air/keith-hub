"use client";

import RealBoxTable from "./RealBoxTable";
import { useLive } from "./LiveProvider";
import type { TeamBoxScore } from "@/lib/hoops/scores/types";

/** The game page's two box scores: the server render until the first live
 *  tick lands, then whatever the tick carried. */
export default function LiveBoxScores({ initial }: { initial: TeamBoxScore[] }) {
  const { box } = useLive();
  const teams = box?.teams?.length ? box.teams : initial;
  if (teams.length === 0) {
    return <p className="mt-6 font-display text-sm text-cream-dim">Box score unavailable right now.</p>;
  }
  return (
    <>
      {teams.map((t) => (
        <RealBoxTable key={t.tri} team={t} />
      ))}
    </>
  );
}
