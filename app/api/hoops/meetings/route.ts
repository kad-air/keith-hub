import { NextRequest, NextResponse } from "next/server";
import { getMeetings } from "@/lib/hoops/queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/hoops/meetings?a=DEN&b=OKC — every scheduled game between two
 * teams this season, with the closing market line and (inside the results
 * window) the real final. The matchup screen fetches this when a picker
 * changes so the sim's number can sit next to what the market and the
 * scoreboard actually said the last time these two met.
 */
export function GET(request: NextRequest): NextResponse {
  const a = request.nextUrl.searchParams.get("a")?.toUpperCase() ?? "";
  const b = request.nextUrl.searchParams.get("b")?.toUpperCase() ?? "";
  if (!a || !b || a === b) {
    return NextResponse.json({ error: "a and b must be two different teams" }, { status: 400 });
  }
  return NextResponse.json({ meetings: getMeetings(a, b) });
}
