import { NextRequest, NextResponse } from "next/server";
import { markDone, unmarkDone } from "@/lib/practice/progress";

export const dynamic = "force-dynamic";

// item_id is a composite: "day:NN" or "lick:<slug>". Keep validation loose —
// anything starting with day:/lick: is fine; other prefixes are rejected.
function isValidItemId(id: string): boolean {
  return /^(day|lick):[A-Za-z0-9_\-]+$/.test(id);
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { itemId: string } },
): Promise<NextResponse> {
  const itemId = decodeURIComponent(params.itemId);
  if (!isValidItemId(itemId)) {
    return NextResponse.json({ error: "Invalid item_id" }, { status: 400 });
  }
  try {
    markDone(itemId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/practice/done] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { itemId: string } },
): Promise<NextResponse> {
  const itemId = decodeURIComponent(params.itemId);
  if (!isValidItemId(itemId)) {
    return NextResponse.json({ error: "Invalid item_id" }, { status: 400 });
  }
  try {
    unmarkDone(itemId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/practice/done] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
