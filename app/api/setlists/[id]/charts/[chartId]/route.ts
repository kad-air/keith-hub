import { NextRequest, NextResponse } from "next/server";
import { removeChartFromSetlist } from "@/lib/setlists";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string; chartId: string } },
): Promise<NextResponse> {
  try {
    removeChartFromSetlist(params.id, params.chartId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/setlists/[id]/charts/[chartId] DELETE] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
