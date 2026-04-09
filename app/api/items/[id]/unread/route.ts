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

    db.prepare(
      "UPDATE item_state SET read_at = NULL WHERE item_id = ?"
    ).run(id);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/items/unread] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
