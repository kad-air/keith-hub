import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_RATING_MODE,
  getHoopsMeta,
  getModeDisagreement,
  getRankedTeams,
  getRosterSizes,
  isRatingMode,
} from "@/lib/hoops/queries";

export const dynamic = "force-dynamic";

/** GET /api/hoops/teams?mode=results|roster|blend — 30 teams ranked. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const raw = request.nextUrl.searchParams.get("mode");
    const mode = isRatingMode(raw) ? raw : DEFAULT_RATING_MODE;

    const teams = getRankedTeams(mode);
    const sizes = getRosterSizes();

    return NextResponse.json({
      mode,
      teams: teams.map((t) => ({ ...t, rosterSize: sizes.get(t.tri) ?? 0 })),
      disagreement: getModeDisagreement(),
      meta: getHoopsMeta(),
    });
  } catch (err) {
    console.error("[api/hoops/teams] Error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
