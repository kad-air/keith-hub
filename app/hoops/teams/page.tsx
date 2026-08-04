import type { Metadata } from "next";
import { Suspense } from "react";
import HoopsNav from "@/components/hoops/HoopsNav";
import TeamsClient from "@/components/hoops/TeamsClient";
import {
  DEFAULT_RATING_MODE,
  getHoopsMeta,
  getRosterSizes,
  getTeamRows,
  isRatingMode,
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
  const initialMode = isRatingMode(searchParams.mode) ? searchParams.mode : DEFAULT_RATING_MODE;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="teams" />
      <Suspense>
        <TeamsClient
          rows={rows}
          rosterSizes={sizes}
          meta={meta}
          initialMode={initialMode}
        />
      </Suspense>
    </article>
  );
}
