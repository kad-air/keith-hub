import { NextResponse } from "next/server";
import { getListState, getRev } from "@/lib/christmas/store";

export const dynamic = "force-dynamic";

// The whole list, or `{ rev, unchanged: true }` when `?since=` already names
// the current revision — the page polls this every few seconds.
export function GET(request: Request) {
  const since = new URL(request.url).searchParams.get("since");
  const headers = { "Cache-Control": "no-store" };
  if (since != null && Number(since) === getRev()) {
    return NextResponse.json({ rev: Number(since), unchanged: true }, { headers });
  }
  return NextResponse.json(getListState(), { headers });
}
