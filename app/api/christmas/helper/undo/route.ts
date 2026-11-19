import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { markUndone, undoStepsFor } from "@/lib/christmas/helperStore";
import { applyUndo } from "@/lib/christmas/store";

export const dynamic = "force-dynamic";

/** `{ turnId }` → put back everything that answer changed, as one batch. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const turnId = Number(body?.turnId);
  if (!Number.isSafeInteger(turnId)) return NextResponse.json({ error: "turnId required" }, { status: 400 });
  const steps = undoStepsFor(turnId);
  if (!steps) return NextResponse.json({ error: "Nothing to undo there." }, { status: 409 });
  try {
    getDb().transaction(() => {
      applyUndo(steps);
      markUndone(turnId);
    })();
  } catch (err) {
    console.error("[api/christmas helper undo]", err);
    return NextResponse.json({ error: "Couldn't undo everything." }, { status: 500 });
  }
  return NextResponse.json({ undone: true });
}
