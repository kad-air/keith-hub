import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { listCharts } from "@/lib/charts";
import { getSetlist, getSetlistMeta } from "@/lib/setlists";
import SetlistDetailClient from "./SetlistDetailClient";

export const dynamic = "force-dynamic";

export function generateMetadata({
  params,
}: {
  params: { id: string };
}): Metadata {
  // Title only needs the name — use the metadata query, not the full
  // members JOIN that the page component runs.
  const setlist = getSetlistMeta(params.id);
  return { title: setlist ? `${setlist.name} — hub` : "Charts — hub" };
}

export default async function SetlistDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const result = getSetlist(params.id);
  if (!result) notFound();
  const readOnly = !(await isAuthenticated());
  return (
    <SetlistDetailClient
      initialSetlist={result.setlist}
      initialCharts={result.charts}
      library={listCharts()}
      readOnly={readOnly}
    />
  );
}
