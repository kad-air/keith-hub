import { NextRequest, NextResponse } from "next/server";
import { N_SIMS_MAX, N_SIMS_EXPECTED_DEFAULT } from "@/lib/hoops/boxscore";
import { runMatchup, UnknownTeamError } from "@/lib/hoops/run";
import { isRatingMode, DEFAULT_RATING_MODE } from "@/lib/hoops/queries";

export const dynamic = "force-dynamic";

/**
 * POST /api/hoops/sim — the core verb.
 *
 * Body: `{ home, away, neutral?, mode?, nSims?, nonce? }`.
 * Returns the distribution summary AND the expected box score, off ONE
 * simulation — the histogram and the box score describe the same set of
 * games, which they would not if the box score re-ran the engine.
 *
 * `nonce` is what makes two taps different games: it feeds the run_id, which
 * is the RNG key. Omit it and you get the same game back, which is the
 * property that makes a shared link reproducible.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      home?: unknown;
      away?: unknown;
      neutral?: unknown;
      mode?: unknown;
      nSims?: unknown;
      nonce?: unknown;
      runId?: unknown;
    };

    const home = typeof body.home === "string" ? body.home.toUpperCase() : "";
    const away = typeof body.away === "string" ? body.away.toUpperCase() : "";
    if (!home || !away) {
      return NextResponse.json({ error: "home and away are required" }, { status: 400 });
    }
    if (home === away) {
      return NextResponse.json({ error: "home and away must differ" }, { status: 400 });
    }

    const rawMode = typeof body.mode === "string" ? body.mode : null;
    const nSims =
      typeof body.nSims === "number" && Number.isFinite(body.nSims)
        ? Math.max(1, Math.min(Math.floor(body.nSims), N_SIMS_MAX))
        : N_SIMS_EXPECTED_DEFAULT;

    const started = Date.now();
    const run = runMatchup({
      home,
      away,
      neutralSite: body.neutral === true,
      ratingMode: isRatingMode(rawMode) ? rawMode : DEFAULT_RATING_MODE,
      nSims,
      runId: typeof body.runId === "string" ? body.runId : undefined,
      nonce: typeof body.nonce === "string" ? body.nonce : undefined,
    });

    return NextResponse.json({
      summary: run.summary,
      box: run.box,
      meta: run.meta,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    if (err instanceof UnknownTeamError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[api/hoops/sim] Error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
