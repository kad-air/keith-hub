import { NextResponse } from "next/server";
import { getLive, resolveSync, type SpoilerRequest } from "@/lib/hoops/scores/data";
import { isGuardedDate, isIsoDate } from "@/lib/hoops/scores/dates";
import type { LiveResponse } from "@/lib/hoops/scores/types";

export const dynamic = "force-dynamic";

const ID = /^\d{1,12}$/;

/**
 * GET /api/hoops/scores/live?date=YYYY-MM-DD[&date=YYYY-MM-DD][&game=<espn id>]
 *                           [&protect=1&reveal=<id,id>&sync=<id:ms,id:ms>][&at=P:SS][&plays=1]
 *
 * The fast path the scores pages tick on (components/hoops/scores/
 * LiveProvider.tsx): the day's in-progress and about-to-tip games with the
 * core overlay applied — clock, period, totals, last play — and, for one
 * game, its box score. Cookie-gated by the middleware like every other
 * /api route; the server cache bounds the upstream rate however many tabs
 * are open.
 *
 * `date` may repeat: today's page also lists last night's games, and a late
 * tip listed under the prior Eastern date can still be in progress past
 * midnight Mountain. `game` applies to the FIRST date.
 *
 * Spoiler mode (today's page): with `protect=1` every started game of a
 * GUARDED date (today, and yesterday until 3 AM Mountain — dates.ts
 * isGuardedDate, on the server's clock) not listed in `reveal` and not in
 * `sync` is veiled before it leaves the server; a synced game ships the
 * play-by-play moment at now − offset instead of the live score. Game ids are
 * unique across days, so one `reveal` and one `sync` list serve both dates. `at=P:SS` (with `game`) resolves
 * "I'm at SS seconds left in period P" to an offset off the play-by-play.
 *
 * `plays=1` (with `game`, the game page's play-by-play tab) adds the plays
 * under the same rule as the box: all of them for an open game, only those up
 * to the moment for a synced one, none for a veiled one.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const dates = [...new Set(q.getAll("date"))].slice(0, 2);
  const game = q.get("game");
  if (dates.length === 0 || !dates.every(isIsoDate)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (game !== null && !ID.test(game)) {
    return NextResponse.json({ error: "game must be an ESPN event id" }, { status: 400 });
  }
  const spoiler: SpoilerRequest = {
    protect: q.get("protect") === "1",
    reveal: new Set((q.get("reveal") ?? "").split(",").filter((s) => ID.test(s))),
    sync: new Map(
      (q.get("sync") ?? "")
        .split(",")
        .map((pair) => pair.split(":"))
        .filter(([id, ms]) => ID.test(id ?? "") && /^\d{1,10}$/.test(ms ?? ""))
        .map(([id, ms]) => [id, Number(ms)] as [string, number]),
    ),
  };
  const withPlays = q.get("plays") === "1" && game !== null;
  const at = q.get("at");
  let resolution: LiveResponse["resolution"] = null;
  if (at !== null) {
    const m = /^(\d{1,2}):(\d{1,4}(?:\.\d+)?)$/.exec(at);
    if (!game || !m) return NextResponse.json({ error: "at must be P:SECONDS with a game" }, { status: 400 });
    resolution = await resolveSync(game, Number(m[1]), Number(m[2]));
  }
  const now = new Date();
  const results = await Promise.all(
    dates.map((d, i) =>
      getLive(
        d,
        i === 0 ? game : null,
        now,
        { ...spoiler, protect: spoiler.protect && isGuardedDate(d, now) },
        i === 0 && withPlays,
      ),
    ),
  );
  const ok = results.filter((r) => r.data);
  if (ok.length === 0) return NextResponse.json({ error: results[0].error ?? "unavailable" }, { status: 503 });
  const body: LiveResponse & { error: string | null } = {
    date: dates[0],
    games: ok.flatMap((r) => r.data!.games),
    box: ok[0].data!.box,
    held: ok[0].data!.held,
    plays: ok[0].data!.plays ?? null,
    fetchedAt: Date.now(),
    resolution,
    error: results.find((r) => r.error)?.error ?? null,
  };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
