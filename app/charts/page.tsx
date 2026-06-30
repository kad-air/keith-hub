import type { Metadata } from "next";
import { isAuthenticated } from "@/lib/auth";
import { listCharts } from "@/lib/charts";
import { getOfflineSetlists, listSetlists } from "@/lib/setlists";
import ChartsClient from "./ChartsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Charts — hub" };

export default async function ChartsPage() {
  const readOnly = !(await isAuthenticated());
  return (
    <ChartsClient
      initialCharts={listCharts()}
      setlistCount={listSetlists().length}
      offlineSetlists={getOfflineSetlists()}
      readOnly={readOnly}
    />
  );
}
