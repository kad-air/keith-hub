import { NextResponse } from "next/server";
import { getBox, getGamelog } from "@/lib/hoops/scores/data";
import { guardLog, unlockedLines } from "@/lib/hoops/scores/guard";
import { momentAt } from "@/lib/hoops/scores/spoiler";

export const dynamic = "force-dynamic";

const ID = /^\d{1,12}$/;

/**
 * GET /api/hoops/scores/players/<id>/log?reveal=<id,id>&sync=<id:ms,id:ms>
 *
 * The player page's guarded game-log lines that the viewer has unlocked on
 * this device (components/hoops/scores/PlayerLogView.tsx asks, from the same
 * spoiler store the scores pages write): every line under a game in `reveal`,
 * and under a game in `sync` only once the synced moment has reached the
 * final. Nothing else — a line still hidden never leaves the server, the
 * same rule as /api/hoops/scores/live. Cookie-gated by the middleware.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!ID.test(params.id)) return NextResponse.json({ error: "id must be an ESPN athlete id" }, { status: 400 });
  const q = new URL(request.url).searchParams;
  const reveal = (q.get("reveal") ?? "").split(",").filter((s) => ID.test(s));
  const sync = (q.get("sync") ?? "")
    .split(",")
    .map((pair) => pair.split(":"))
    .filter(([id, ms]) => ID.test(id ?? "") && /^\d{1,10}$/.test(ms ?? ""))
    .map(([id, ms]) => [id, Number(ms)] as const);

  const now = new Date();
  const log = await getGamelog(params.id, true);
  if (!log.data) return NextResponse.json({ error: log.error ?? "unavailable" }, { status: 503 });

  const hidden = new Set(guardLog(log.data.games, now).filter((s) => s.hidden).map((s) => s.line.gameId));
  const unlocked = new Set(reveal.filter((id) => hidden.has(id)));
  // A synced game counts once the viewer's moment has reached the final.
  await Promise.all(
    sync
      .filter(([id]) => hidden.has(id) && !unlocked.has(id))
      .slice(0, 4)
      .map(async ([id, offset]) => {
        const box = (await getBox(id)).data;
        const m = box?.plays?.length ? momentAt(box.plays, now.getTime() - offset) : null;
        if (m?.final) unlocked.add(id);
      }),
  );
  return NextResponse.json(
    { lines: unlockedLines(log.data.games, now, unlocked) },
    { headers: { "cache-control": "no-store" } },
  );
}
