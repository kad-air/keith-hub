import { NextRequest, NextResponse } from "next/server";
import { reorderSetlist } from "@/lib/setlists";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const body = await request.json();
    if (
      !Array.isArray(body.ids) ||
      body.ids.some((x: unknown) => typeof x !== "string")
    ) {
      return NextResponse.json(
        { error: "ids must be an array of strings" },
        { status: 400 },
      );
    }
    reorderSetlist(params.id, body.ids);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/setlists/[id]/reorder] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
