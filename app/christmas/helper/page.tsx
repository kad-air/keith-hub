import type { Metadata } from "next";
import { isAuthenticated } from "@/lib/auth";
import { isPending, listTurns } from "@/lib/christmas/helperStore";
import ChristmasHeader from "@/components/christmas/ChristmasHeader";
import GuestChrome from "@/components/christmas/GuestChrome";
import HelperClient from "@/components/christmas/HelperClient";
import { whoIsAsking } from "@/lib/christmas/identity";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Christmas helper — hub",
};

export default async function ChristmasHelperPage() {
  const hubUser = process.env.FEED_PASSWORD ? await isAuthenticated() : false;
  const turns = listTurns();
  return (
    <div className="xmas-page mx-auto max-w-[720px] px-4 pt-6 sm:px-6">
      {!hubUser && <GuestChrome />}
      <ChristmasHeader active="helper" />
      <HelperClient initial={{ turns, pending: isPending(turns), configured: Boolean(process.env.ANTHROPIC_API_KEY), me: await whoIsAsking() }} />
    </div>
  );
}
