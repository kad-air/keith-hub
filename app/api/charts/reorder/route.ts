import { NextRequest, NextResponse } from "next/server";
import { reorderCharts } from "@/lib/charts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    if (!Array.isArray(body.ids) || body.ids.some((x: unknown) => typeof x !== "string")) {
      return NextResponse.json(
        { error: "ids must be an array of strings" },
        { status: 400 },
      );
    }
    reorderCharts(body.ids);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/charts/reorder] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
