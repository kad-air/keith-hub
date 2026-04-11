import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCategoryCounts, getMainFeedItems } from "@/lib/queries";
import type { Item, ItemsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category") || null;
    // Defensive ceiling. The actual feed size is bounded by TTL pruning,
    // not this limit. 2000 is generous enough to never clip a real 7-day window.
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 2000);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    const db = getDb();

    const categoryFilter = category && category !== "all" ? category : null;

    let totalRow: { count: number };
    let rows: Item[];

    if (categoryFilter) {
      totalRow = db
        .prepare(
          `SELECT COUNT(*) as count FROM items i
           LEFT JOIN item_state ist ON ist.item_id = i.id
           JOIN sources s ON s.id = i.source_id
           WHERE ist.read_at IS NULL AND s.category = ?`
        )
        .get(categoryFilter) as { count: number };

      rows = db
        .prepare(
          `SELECT
            i.*,
            s.name as source_name,
            s.category as source_category,
            ist.read_at,
            ist.saved_at,
            ist.consumed_at,
            ist.notes
          FROM items i
          LEFT JOIN item_state ist ON ist.item_id = i.id
          JOIN sources s ON s.id = i.source_id
          WHERE ist.read_at IS NULL AND s.category = ?
          ORDER BY i.published_at DESC
          LIMIT ? OFFSET ?`  // category filter: pure recency
        )
        .all(categoryFilter, limit, offset) as Item[];
    } else {
      totalRow = db
        .prepare(
          `SELECT COUNT(*) as count FROM items i
           LEFT JOIN item_state ist ON ist.item_id = i.id
           JOIN sources s ON s.id = i.source_id
           WHERE ist.read_at IS NULL`
        )
        .get() as { count: number };

      // Main feed: inclusion-based, not order-based — see getMainFeedItems
      // for the rationale. Offset is ignored here; the main feed is a
      // bounded snapshot, not a paginated stream.
      rows = getMainFeedItems(db, limit);
    }

    const total = totalRow.count;
    const counts = getCategoryCounts(db);

    const response: ItemsResponse = {
      items: rows,
      total,
      hasMore: offset + rows.length < total,
      counts,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[api/items] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
