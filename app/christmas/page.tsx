import type { Metadata } from "next";
import { isAuthenticated } from "@/lib/auth";
import { getListState } from "@/lib/christmas/store";
import ChristmasClient from "@/components/christmas/ChristmasClient";
import ChristmasHeader from "@/components/christmas/ChristmasHeader";
import GuestChrome from "@/components/christmas/GuestChrome";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Christmas — hub",
};

// The shared gift list. The middleware has already checked the passcode (or
// the hub cookie); this renders the list as it stands so the page opens full,
// then the client polls for the other parent's edits.
export default async function ChristmasPage() {
  const hubUser = process.env.FEED_PASSWORD ? await isAuthenticated() : false;
  return (
    <div className="xmas-page mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6 lg:max-w-[960px]">
      {!hubUser && <GuestChrome />}
      <ChristmasHeader active="list" />
      <ChristmasClient initial={getListState()} />
    </div>
  );
}
