import { NextRequest, NextResponse } from "next/server";
import { recheckBookHealth } from "@/lib/books/healthData";

export const dynamic = "force-dynamic";

// Force a fresh health check on one book — the "Re-check" button on
// /books/[id]. The lazy backfill already covers a book's FIRST check (a NULL
// cache computes on detail-page open); this exists to re-run at will over a
// current cache.
//
// A read of the stored bytes plus one DB-column write, never a file write —
// the same path the lazy fill uses (see lib/books/healthData.ts), so
// re-checking a book mid-read cannot disturb it. Cookie-gated like the rest
// of /api/books (the manage surface).
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const health = recheckBookHealth(params.id);
    if (!health) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ health });
  } catch (err) {
    console.error("[api/books health] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
