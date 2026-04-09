import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { fetchAllSources } from "@/lib/fetcher";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    const db = getDb();
    const fetched = await fetchAllSources(db);
    return NextResponse.json({ fetched });
  } catch (err) {
    console.error("[api/refresh] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
