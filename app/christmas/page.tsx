import type { Metadata } from "next";
import { isAuthenticated } from "@/lib/auth";
import { getListState } from "@/lib/christmas/store";
import ChristmasClient from "@/components/christmas/ChristmasClient";
import GuestChrome from "@/components/christmas/GuestChrome";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Adair Christmas 2026",
};

// The shared gift list. The middleware has already checked the passcode (or
// the hub cookie); this renders the list as it stands so the page opens full,
// then the client polls for the other parent's edits.
export default async function ChristmasPage() {
  const hubUser = process.env.FEED_PASSWORD ? await isAuthenticated() : false;
  return (
    <>
      {!hubUser && <GuestChrome />}
      <ChristmasClient initial={getListState()} />
    </>
  );
}
