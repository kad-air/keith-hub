import type { Metadata } from "next";
import { listCharts } from "@/lib/charts";
import { getOfflineSetlists, listSetlists } from "@/lib/setlists";
import ChartsClient from "./ChartsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Charts — hub" };

export default function ChartsPage() {
  return (
    <ChartsClient
      initialCharts={listCharts()}
      setlistCount={listSetlists().length}
      offlineSetlists={getOfflineSetlists()}
    />
  );
}
