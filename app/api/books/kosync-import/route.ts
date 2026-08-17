import { NextRequest, NextResponse } from "next/server";
import { createUser, importProgress, type KosyncProgress } from "@/lib/books/kosync";

export const dynamic = "force-dynamic";

// Admin import for the Stump migration (BOOKS_PLAN §5): seeds the kosync user
// and loads progress rows pulled from ~/.stump/stump.db by
// scripts/migrate-stump-progress.mjs. Cookie-gated via middleware — this is a
// manage surface, not a device endpoint. `wireKey` is md5(password), i.e. the
// exact value the devices will present in x-auth-key.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const wireKey = typeof body.wireKey === "string" ? body.wireKey.trim() : "";
    const rows: KosyncProgress[] = Array.isArray(body.rows) ? body.rows : [];
    if (!username || !wireKey) {
      return NextResponse.json({ error: "username and wireKey required" }, { status: 400 });
    }
    const userResult = createUser(username, wireKey);
    if (userResult === "exists") {
      return NextResponse.json(
        { error: "user exists with a different key; refusing to overwrite" },
        { status: 409 },
      );
    }
    const valid = rows.filter(
      (r) =>
        typeof r.document === "string" &&
        typeof r.progress === "string" &&
        typeof r.percentage === "number" &&
        typeof r.timestamp === "number",
    );
    const result = importProgress(username, valid);
    return NextResponse.json({ user: userResult, ...result, invalid: rows.length - valid.length });
  } catch (err) {
    console.error("[api/books/kosync-import POST] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
