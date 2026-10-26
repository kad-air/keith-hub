import { NextResponse } from "next/server";
import { getLive } from "@/lib/hoops/scores/data";
import { isIsoDate } from "@/lib/hoops/scores/dates";
import type { LiveResponse } from "@/lib/hoops/scores/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/hoops/scores/live?date=YYYY-MM-DD[&date=YYYY-MM-DD][&game=<espn id>]
 *
 * `date` may repeat: today's page also lists last night's games, and a late
 * tip listed under the prior Eastern date can still be in progress past
 * midnight Mountain. `game` applies to the FIRST date.
 *
 * The fast path the scores pages tick on (components/hoops/scores/
 * LiveProvider.tsx): the day's in-progress and about-to-tip games with the
 * core overlay applied — clock, period, totals, last play — and, for one
 * game, its box score. Cookie-gated by the middleware like every other
 * /api route; the server cache bounds the upstream rate however many tabs
 * are open.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const dates = [...new Set(url.searchParams.getAll("date"))].slice(0, 2);
  const game = url.searchParams.get("game");
  if (dates.length === 0 || !dates.every(isIsoDate)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (game !== null && !/^\d{1,12}$/.test(game)) {
    return NextResponse.json({ error: "game must be an ESPN event id" }, { status: 400 });
  }
  const results = await Promise.all(dates.map((d, i) => getLive(d, i === 0 ? game : null)));
  const ok = results.filter((r) => r.data);
  if (ok.length === 0) return NextResponse.json({ error: results[0].error ?? "unavailable" }, { status: 503 });
  const body: LiveResponse & { error: string | null } = {
    date: dates[0],
    games: ok.flatMap((r) => r.data!.games),
    box: ok[0].data!.box,
    fetchedAt: Date.now(),
    error: results.find((r) => r.error)?.error ?? null,
  };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
