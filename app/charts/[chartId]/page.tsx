import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { getChart } from "@/lib/charts";
import { getSetlist } from "@/lib/setlists";
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
  searchParams,
}: {
  params: { chartId: string };
  searchParams: { setlist?: string };
}) {
  const chart = getChart(params.chartId);
  if (!chart) notFound();
  const readOnly = !(await isAuthenticated());

  // When opened from a setlist, the back link returns there (and names it);
  // otherwise it returns to the library. Pulling the full setlist (not just its
  // meta) also lets us wire the "Next ▸" shortcut and the auto-start: both are
  // gated on this chart actually being a member of the named setlist.
  const setlistData = searchParams.setlist
    ? getSetlist(searchParams.setlist)
    : null;
  const setlist = setlistData?.setlist ?? null;
  const back = setlist
    ? { href: `/charts/setlists/${setlist.id}`, label: `← ${setlist.name}` }
    : { href: "/charts", label: "← Charts" };

  // Position within the setlist drives both features. autoStart only fires for
  // members (stepping into a song from the setlist), and the Next shortcut
  // carries the ?setlist= chain forward so the next song auto-starts too.
  let next: { href: string; title: string } | null = null;
  let autoStart = false;
  if (setlistData && setlist) {
    const idx = setlistData.charts.findIndex((c) => c.id === chart.id);
    if (idx >= 0) {
      autoStart = true;
      const upcoming = setlistData.charts[idx + 1];
      if (upcoming) {
        next = {
          href: `/charts/${upcoming.id}?setlist=${setlist.id}`,
          title: upcoming.title,
        };
      }
    }
  }

  // key on chart.id so navigating song→song within a setlist remounts cleanly:
  // fresh scroll position, per-song speed reload, and a new auto-start countdown.
  return (
    <ChartViewerClient
      key={chart.id}
      chart={chart}
      back={back}
      next={next}
      autoStart={autoStart}
      readOnly={readOnly}
    />
  );
}
