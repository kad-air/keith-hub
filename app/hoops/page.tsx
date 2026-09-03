import type { Metadata } from "next";
import { Suspense } from "react";
import HoopsNav from "@/components/hoops/HoopsNav";
import MatchupClient from "@/components/hoops/MatchupClient";
import {
  availableRatingModes,
  getHoopsMeta,
  getLeagueFormSummaries,
  getMeetings,
  getResultsWindow,
  getTeamRows,
  isRatingMode,
  resolveRatingMode,
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
  searchParams: { home?: string; away?: string; mode?: string; neutral?: string };
}) {
  const rows = getTeamRows();
  const meta = getHoopsMeta();
  // Same lenses, same default, as /hoops/teams — the matchup used to offer
  // three lenses and default to the blend while the teams page offered four
  // and defaulted to the nightly read the sim actually prices with.
  const modes = availableRatingModes(rows);
  const asked = isRatingMode(searchParams.mode) ? searchParams.mode : null;
  const mode = asked && modes.includes(asked) ? asked : resolveRatingMode(rows);

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
  const rawAway = pick(searchParams.away, ranked[1]?.tri ?? "OKC");
  const defaultAway = rawAway === defaultHome ? (ranked[2]?.tri ?? "BOS") : rawAway;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="matchup" through={getResultsWindow()?.to ?? null} />
      <Suspense>
        <MatchupClient
          teams={rows.map((r) => ({ ...r, nightly_movers_json: null }))}
          form={getLeagueFormSummaries()}
          meta={meta}
          modes={modes}
          defaultHome={defaultHome}
          defaultAway={defaultAway}
          defaultMode={mode}
          defaultNeutral={searchParams.neutral === "1"}
          initialMeetings={getMeetings(defaultHome, defaultAway)}
        />
      </Suspense>
    </article>
  );
}
