import { NextRequest, NextResponse } from "next/server";
import { markComicUnread } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    markComicUnread(params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/comics/unread] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
