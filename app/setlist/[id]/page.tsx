import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChart } from "@/lib/charts";
import ChartViewerClient from "./ChartViewerClient";

export const dynamic = "force-dynamic";

export function generateMetadata({
  params,
}: {
  params: { id: string };
}): Metadata {
  const chart = getChart(params.id);
  return { title: chart ? `${chart.title} — hub` : "Setlist — hub" };
}

export default function ChartPage({ params }: { params: { id: string } }) {
  const chart = getChart(params.id);
  if (!chart) notFound();
  return <ChartViewerClient chart={chart} />;
}
