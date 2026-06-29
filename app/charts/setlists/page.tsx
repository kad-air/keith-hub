import type { Metadata } from "next";
import { listSetlists } from "@/lib/setlists";
import SetlistsClient from "./SetlistsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Setlists — hub" };

export default function SetlistsPage() {
  return <SetlistsClient initialSetlists={listSetlists()} />;
}
