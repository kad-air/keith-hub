import type { Metadata } from "next";
import { listCharts } from "@/lib/charts";
import SetlistClient from "./SetlistClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Setlist — hub" };

export default function SetlistPage() {
  const charts = listCharts();
  return <SetlistClient initialCharts={charts} />;
}
