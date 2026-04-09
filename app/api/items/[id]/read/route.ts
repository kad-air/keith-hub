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
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO item_state (item_id, read_at)
      VALUES (?, ?)
      ON CONFLICT(item_id) DO UPDATE SET read_at = excluded.read_at
    `).run(id, now);

    return NextResponse.json({ ok: true, read_at: now });
  } catch (err) {
    console.error("[api/items/read] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
