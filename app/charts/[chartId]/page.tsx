import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChart } from "@/lib/charts";
import { getSetlistMeta } from "@/lib/setlists";
import ChartViewerClient from "./ChartViewerClient";

export const dynamic = "force-dynamic";

export function generateMetadata({
  params,
}: {
  params: { chartId: string };
}): Metadata {
  const chart = getChart(params.chartId);
  return { title: chart ? `${chart.title} — hub` : "Charts — hub" };
}

export default function ChartPage({
  params,
  searchParams,
}: {
  params: { chartId: string };
  searchParams: { setlist?: string };
}) {
  const chart = getChart(params.chartId);
  if (!chart) notFound();

  // When opened from a setlist, the back link returns there (and names it);
  // otherwise it returns to the library. The viewer itself is setlist-agnostic.
  const setlist = searchParams.setlist
    ? getSetlistMeta(searchParams.setlist)
    : null;
  const back = setlist
    ? { href: `/charts/setlists/${setlist.id}`, label: `← ${setlist.name}` }
    : { href: "/charts", label: "← Charts" };

  return <ChartViewerClient chart={chart} back={back} />;
}
