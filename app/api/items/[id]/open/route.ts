import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// Marks an item as opened by the user. Sets BOTH read_at (so it leaves
// the main feed, same as a dismiss) AND consumed_at (which distinguishes
// "I actually clicked through to read this" from "I dismissed it without
// reading"). The /read view queries on consumed_at.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO item_state (item_id, read_at, consumed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        read_at = excluded.read_at,
        consumed_at = excluded.consumed_at
    `).run(id, now, now);

    return NextResponse.json({ ok: true, read_at: now, consumed_at: now });
  } catch (err) {
    console.error("[api/items/open] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
