import { NextRequest, NextResponse } from "next/server";
import { addChartToSetlist, getSetlist } from "@/lib/setlists";

export const dynamic = "force-dynamic";

// Add a library chart to this setlist (appends to the end). Returns the
// refreshed setlist + charts so the client can reconcile in one round-trip.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const body = await request.json();
    const chartId = typeof body.chartId === "string" ? body.chartId : "";
    if (!chartId) {
      return NextResponse.json(
        { error: "chartId is required" },
        { status: 400 },
      );
    }
    const ok = addChartToSetlist(params.id, chartId);
    if (!ok) {
      return NextResponse.json(
        { error: "Setlist or chart not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(getSetlist(params.id));
  } catch (err) {
    console.error("[api/setlists/[id]/charts POST] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
