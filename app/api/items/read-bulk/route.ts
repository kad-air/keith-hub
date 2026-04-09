import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

interface BulkBody {
  ids?: unknown;
  unread?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as BulkBody;
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === "string")
      : [];
    const unread = body.unread === true;

    if (ids.length === 0) {
      return NextResponse.json({ ok: true, count: 0 });
    }

    const db = getDb();
    const now = new Date().toISOString();

    if (unread) {
      // Bulk undo — clear read_at for all the given ids
      const stmt = db.prepare(
        "UPDATE item_state SET read_at = NULL WHERE item_id = ?"
      );
      const tx = db.transaction((rowIds: string[]) => {
        for (const id of rowIds) stmt.run(id);
      });
      tx(ids);
    } else {
      // Bulk dismiss — upsert read_at for all the given ids
      const stmt = db.prepare(`
        INSERT INTO item_state (item_id, read_at)
        VALUES (?, ?)
        ON CONFLICT(item_id) DO UPDATE SET read_at = excluded.read_at
      `);
      const tx = db.transaction((rowIds: string[]) => {
        for (const id of rowIds) stmt.run(id, now);
      });
      tx(ids);
    }

    return NextResponse.json({ ok: true, count: ids.length });
  } catch (err) {
    console.error("[api/items/read-bulk] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
