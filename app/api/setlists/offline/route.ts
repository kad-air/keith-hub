import { NextResponse } from "next/server";
import { getOfflineSetlists } from "@/lib/setlists";

export const dynamic = "force-dynamic";

// Feeds the app-shell offline warmer (components/OfflineWarm.tsx): the
// offline-flagged setlists with their member charts' id + updatedAt — the
// same shape ChartsClient receives as a prop. updatedAt is included so the
// warmer can key its "already warmed" guard on chart content, re-warming
// edited charts instead of serving a stale render offline.
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ setlists: getOfflineSetlists() });
  } catch (err) {
    console.error("[api/setlists/offline GET] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
