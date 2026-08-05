import type { Metadata } from "next";
import HoopsNav from "@/components/hoops/HoopsNav";
import MatchupClient from "@/components/hoops/MatchupClient";
import {
  DEFAULT_RATING_MODE,
  getHoopsMeta,
  getTeamRows,
  isRatingMode,
} from "@/lib/hoops/queries";
import { rankTeams } from "@/lib/hoops/rating";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hoops · Matchup — hub" };

/**
 * The section home and the core verb: pick two teams, tap Sim.
 *
 * Deliberately does NOT simulate on load. A sim is ~600ms of CPU and the
 * answer is only meaningful once you've chosen the matchup — rendering a
 * default one would spend the budget on a question nobody asked and make the
 * Sim button look decorative.
 */
export default function HoopsMatchupPage({
  searchParams,
}: {
  searchParams: { home?: string; away?: string; mode?: string };
}) {
  const rows = getTeamRows();
  const meta = getHoopsMeta();
  const mode = isRatingMode(searchParams.mode) ? searchParams.mode : DEFAULT_RATING_MODE;

  // Default to the two best teams by the chosen rating — the matchup someone
  // opening this screen cold is most likely to want, and it makes the shape of
  // the answer obvious immediately.
  const ranked = rankTeams(rows, mode);
  const known = new Set(rows.map((r) => r.tri));
  const pick = (raw: string | undefined, fallback: string): string => {
    const tri = raw?.toUpperCase();
    return tri && known.has(tri) ? tri : fallback;
  };
  const defaultHome = pick(searchParams.home, ranked[0]?.tri ?? "DEN");
  const defaultAway = pick(searchParams.away, ranked[1]?.tri ?? "OKC");

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="matchup" />
      <MatchupClient
        teams={rows}
        meta={meta}
        defaultHome={defaultHome}
        defaultAway={defaultAway === defaultHome ? (ranked[2]?.tri ?? "BOS") : defaultAway}
        defaultMode={mode}
      />
    </article>
  );
}
