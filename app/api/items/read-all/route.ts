import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { markAllUnreadAsRead } from "@/lib/queries";

export const dynamic = "force-dynamic";

// Marks every unread item in scope as read in a single transaction.
// Body: { category?: string } — omit for "everything"; pass a category id
// (e.g. "podcasts") to scope to one category.
//
// Returns the list of item IDs that were marked, so the caller can build
// an undo by passing them back to /api/items/read-bulk with unread:true.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      category?: string;
    };
    const category = body.category && body.category !== "all" ? body.category : null;

    const db = getDb();
    const ids = markAllUnreadAsRead(db, category);

    return NextResponse.json({ ok: true, count: ids.length, ids });
  } catch (err) {
    console.error("[api/items/read-all] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
