import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;
    const db = getDb();

    const existing = db
      .prepare("SELECT saved_at FROM item_state WHERE item_id = ?")
      .get(id) as { saved_at: string | null } | undefined;

    let saved_at: string | null;

    if (existing?.saved_at) {
      // Already saved — toggle off
      db.prepare(
        "UPDATE item_state SET saved_at = NULL WHERE item_id = ?"
      ).run(id);
      saved_at = null;
    } else {
      // Not saved — save it
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO item_state (item_id, saved_at)
        VALUES (?, ?)
        ON CONFLICT(item_id) DO UPDATE SET saved_at = excluded.saved_at
      `).run(id, now);
      saved_at = now;
    }

    return NextResponse.json({ ok: true, saved_at });
  } catch (err) {
    console.error("[api/items/save] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
