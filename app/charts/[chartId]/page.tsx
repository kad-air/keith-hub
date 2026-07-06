import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { getChart } from "@/lib/charts";
import { getChartSetlistContexts } from "@/lib/setlists";
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

export default async function ChartPage({
  params,
}: {
  params: { chartId: string };
}) {
  const chart = getChart(params.chartId);
  if (!chart) notFound();
  const readOnly = !(await isAuthenticated());

  // The setlist context (named back link, "Next ▸" shortcut, auto-start) is
  // deliberately NOT derived from searchParams here. The offline SW cache
  // stores ONE query-less render per chart (warming fetches /charts/<id>;
  // matching uses ignoreSearch), so anything derived server-side from
  // ?setlist= would be missing from the cached page — offline opens from a
  // setlist used to lose the Next button and auto-start. Instead we bake
  // EVERY membership into the render and the client resolves the active one
  // from location.search after mount.
  const setlists = getChartSetlistContexts(chart.id);

  // key on chart.id so navigating song→song within a setlist remounts cleanly:
  // fresh scroll position, per-song speed reload, and a new auto-start countdown.
  return (
    <ChartViewerClient
      key={chart.id}
      chart={chart}
      setlists={setlists}
      readOnly={readOnly}
    />
  );
}
