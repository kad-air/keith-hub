import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { markReadBulk } from "@/lib/queries";

export const dynamic = "force-dynamic";

interface BulkBody {
  ids?: unknown;
  unread?: unknown;
}

// Bulk dismiss / bulk undo. Body: { ids: string[], unread?: boolean }.
// Backs every dismiss flow in FeedClient via the dismiss outbox
// (lib/dismiss-outbox.ts), which replays a batch until it lands — so this
// must be idempotent and must tolerate ids that no longer exist (see
// markReadBulk). Sets only read_at, never consumed_at.
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

    const count = markReadBulk(getDb(), ids, { unread });
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    console.error("[api/items/read-bulk] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
