import type { Metadata } from "next";
import { isAuthenticated } from "@/lib/auth";
import { listSetlists } from "@/lib/setlists";
import SetlistsClient from "./SetlistsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Setlists — hub" };

export default async function SetlistsPage() {
  const readOnly = !(await isAuthenticated());
  return (
    <SetlistsClient initialSetlists={listSetlists()} readOnly={readOnly} />
  );
}
