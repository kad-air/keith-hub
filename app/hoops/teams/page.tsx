import type { Metadata } from "next";
import { Suspense } from "react";
import HoopsNav from "@/components/hoops/HoopsNav";
import TeamsClient from "@/components/hoops/TeamsClient";
import {
  availableRatingModes,
  getHoopsMeta,
  getLeagueFormSummaries,
  getNightlyMeta,
  getResultsWindow,
  getRosterSizes,
  getTeamRows,
  isRatingMode,
  resolveRatingMode,
} from "@/lib/hoops/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hoops · Teams — hub" };

export default function HoopsTeamsPage({
  searchParams,
}: {
  searchParams: { mode?: string };
}) {
  const rows = getTeamRows();
  const meta = getHoopsMeta();
  const sizes = Object.fromEntries(getRosterSizes());
  const modes = availableRatingModes(rows);
  const nightly = getNightlyMeta();
  // A ?mode= a bundle cannot honour (a shared link to the nightly lens landing
  // on an older bundle) falls back rather than 404s or shows an empty column.
  const asked = isRatingMode(searchParams.mode) ? searchParams.mode : null;
  const initialMode = asked && modes.includes(asked) ? asked : resolveRatingMode(rows);

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="teams" />
      <Suspense>
        <TeamsClient
          rows={rows}
          rosterSizes={sizes}
          form={getLeagueFormSummaries()}
          resultsWindow={getResultsWindow()}
          meta={meta}
          modes={modes}
          nightly={nightly}
          initialMode={initialMode}
        />
      </Suspense>
    </article>
  );
}
