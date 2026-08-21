import type { Metadata } from "next";
import { Suspense } from "react";
import HoopsNav from "@/components/hoops/HoopsNav";
import PlayersClient from "@/components/hoops/PlayersClient";
import {
  DEFAULT_PLAYER_SORT,
  isPlayerSort,
} from "@/lib/hoops/playervalue";
import { getAllPlayers, getHoopsMeta, getTeamRows } from "@/lib/hoops/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hoops · Players — hub" };

export default function HoopsPlayersPage({
  searchParams,
}: {
  searchParams: { sort?: string; team?: string };
}) {
  const rows = getAllPlayers();
  const meta = getHoopsMeta();
  const tris = getTeamRows().map((t) => t.tri);

  const initialSort = isPlayerSort(searchParams.sort) ? searchParams.sort : DEFAULT_PLAYER_SORT;
  // A ?team= naming a franchise this bundle doesn't carry falls back to the
  // whole league rather than rendering an empty ranking.
  const wanted = searchParams.team?.toUpperCase();
  const initialTeam = wanted && tris.includes(wanted) ? wanted : null;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="players" />
      <Suspense>
        <PlayersClient
          rows={rows}
          tris={tris}
          meta={meta}
          initialSort={initialSort}
          initialTeam={initialTeam}
        />
      </Suspense>
    </article>
  );
}
