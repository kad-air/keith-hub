import { NextRequest, NextResponse } from "next/server";
import { N_SIMS_MAX, N_SIMS_EXPECTED_DEFAULT } from "@/lib/hoops/boxscore";
import { encodeRunId, parseRunId } from "@/lib/hoops/matchup";
import { DEFAULT_RATING_MODE, isRatingMode } from "@/lib/hoops/queries";
import { runMatchup, runSampledGame, UnknownTeamError } from "@/lib/hoops/run";

export const dynamic = "force-dynamic";

/**
 * POST /api/hoops/boxscore — `{ home, away, mode, ratingMode?, neutral?, runId?, nSims? }`.
 *
 * `mode` is the honesty-carrying one and is NOT a display toggle:
 *   • `expected` — the mean line over many replicates. "What does a typical
 *     night look like." Fractional by nature.
 *   • `sample`   — ONE specific night. Integer lines that sum exactly to a
 *     realised final score, with a realised OT count.
 *
 * A `runId` alone is enough for sample mode: it carries its own teams, court
 * and rating mode (see lib/hoops/matchup.ts), so a shared link reproduces the
 * game without needing this device's database.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      home?: unknown;
      away?: unknown;
      mode?: unknown;
      ratingMode?: unknown;
      neutral?: unknown;
      runId?: unknown;
      nSims?: unknown;
      nonce?: unknown;
    };

    const mode = body.mode === "sample" ? "sample" : "expected";
    const runId = typeof body.runId === "string" ? body.runId : null;

    if (mode === "sample") {
      // A run_id is self-describing, so it wins over any teams in the body —
      // otherwise a mismatched pair would silently produce a game that is not
      // the one the id names.
      let coords = runId ? parseRunId(runId) : null;
      let effectiveRunId = runId;

      if (!coords) {
        const home = typeof body.home === "string" ? body.home.toUpperCase() : "";
        const away = typeof body.away === "string" ? body.away.toUpperCase() : "";
        if (!home || !away) {
          return NextResponse.json(
            { error: "sample mode needs either a runId or home and away" },
            { status: 400 },
          );
        }
        if (home === away) {
          return NextResponse.json({ error: "home and away must differ" }, { status: 400 });
        }
        const rawMode = typeof body.ratingMode === "string" ? body.ratingMode : null;
        coords = {
          home,
          away,
          neutralSite: body.neutral === true,
          ratingMode: isRatingMode(rawMode) ? rawMode : DEFAULT_RATING_MODE,
        };
        effectiveRunId = encodeRunId(
          coords,
          typeof body.nonce === "string" ? body.nonce : "0",
        );
      }

      const sampled = runSampledGame(effectiveRunId as string, coords);
      return NextResponse.json({ box: sampled.box, coords: sampled.coords, meta: sampled.meta });
    }

    const home = typeof body.home === "string" ? body.home.toUpperCase() : "";
    const away = typeof body.away === "string" ? body.away.toUpperCase() : "";
    if (!home || !away) {
      return NextResponse.json({ error: "home and away are required" }, { status: 400 });
    }
    if (home === away) {
      return NextResponse.json({ error: "home and away must differ" }, { status: 400 });
    }

    const rawMode = typeof body.ratingMode === "string" ? body.ratingMode : null;
    const nSims =
      typeof body.nSims === "number" && Number.isFinite(body.nSims)
        ? Math.max(1, Math.min(Math.floor(body.nSims), N_SIMS_MAX))
        : N_SIMS_EXPECTED_DEFAULT;

    const run = runMatchup({
      home,
      away,
      neutralSite: body.neutral === true,
      ratingMode: isRatingMode(rawMode) ? rawMode : DEFAULT_RATING_MODE,
      nSims,
      runId: runId ?? undefined,
      nonce: typeof body.nonce === "string" ? body.nonce : undefined,
    });

    return NextResponse.json({ box: run.box, summary: run.summary, meta: run.meta });
  } catch (err) {
    if (err instanceof UnknownTeamError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[api/hoops/boxscore] Error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
