import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listCharts } from "@/lib/charts";
import { getSetlist } from "@/lib/setlists";
import SetlistDetailClient from "./SetlistDetailClient";

export const dynamic = "force-dynamic";

export function generateMetadata({
  params,
}: {
  params: { id: string };
}): Metadata {
  const result = getSetlist(params.id);
  return { title: result ? `${result.setlist.name} — hub` : "Setlist — hub" };
}

export default function SetlistDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const result = getSetlist(params.id);
  if (!result) notFound();
  return (
    <SetlistDetailClient
      initialSetlist={result.setlist}
      initialCharts={result.charts}
      library={listCharts()}
    />
  );
}
