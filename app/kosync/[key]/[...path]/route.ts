import { NextRequest, NextResponse } from "next/server";
import { checkBooksApiKey } from "@/lib/books/apiKey";
import { authUser, createUser, getProgress, putProgress } from "@/lib/books/kosync";

export const dynamic = "force-dynamic";

// The KOReader sync (kosync) wire protocol — the entire thing:
//
//   POST {base}/users/create              {username, password}       201 / 402
//   GET  {base}/users/auth                                           200 / 401
//   PUT  {base}/syncs/progress            {document, progress,
//                                          percentage, device,
//                                          device_id}                200
//   GET  {base}/syncs/progress/:document                             200
//   GET  {base}/healthcheck                                          200
//
// {base} is /kosync/{key} — the key segment is the same machine credential as
// OPDS (the device stores one URL and cannot complete a challenge), and the
// x-auth-user/x-auth-key headers are the kosync user on top. Exempt from
// middleware.ts; fails CLOSED when BOOKS_API_KEY is unset.
//
// 🔴 Response shapes are the vanilla protocol's (what CrossPoint + Readest
// were verified against via Stump on 2026-08-16) — not Komga's or Kavita's
// dialects. x-auth-key is md5(password), computed client-side; see
// lib/books/kosync.ts for why that is immovable.

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

function gateKey(key: string): NextResponse | null {
  if (!checkBooksApiKey(key)) return json({ message: "unauthorized" }, 401);
  return null;
}

function gateUser(request: NextRequest): { username: string } | NextResponse {
  const username = request.headers.get("x-auth-user");
  const wireKey = request.headers.get("x-auth-key");
  if (!authUser(username, wireKey)) return json({ message: "unauthorized" }, 401);
  return { username: username! };
}

type Ctx = { params: { key: string; path: string[] } };

// Tolerate empty segments: a base URL entered with a trailing slash yields
// //users/auth, which Next would otherwise answer with a 308 redirect — and a
// device HTTP client that doesn't follow redirects would just fail to sync,
// silently. Config-time typo, invisible failure; cheaper to accept than debug.
function segs(path: string[]): string[] {
  return path.filter((s) => s !== "");
}

export async function GET(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = gateKey(params.key);
  if (denied) return denied;
  const path = segs(params.path);

  if (path.length === 1 && path[0] === "healthcheck") {
    return json({ state: "OK" });
  }

  if (path.length === 2 && path[0] === "users" && path[1] === "auth") {
    const user = gateUser(request);
    if (user instanceof NextResponse) return user;
    return json({ authorized: "OK" });
  }

  if (path.length === 3 && path[0] === "syncs" && path[1] === "progress") {
    const user = gateUser(request);
    if (user instanceof NextResponse) return user;
    const document = decodeURIComponent(path[2]);
    const progress = getProgress(user.username, document);
    // No progress yet → 200 with an empty object, the most tolerant of the
    // client behaviors in the wild ("not synced yet" must not read as an
    // error; the device treats it as no remote position and pushes).
    return json(progress ?? {});
  }

  return json({ message: "not found" }, 404);
}

export async function POST(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = gateKey(params.key);
  if (denied) return denied;

  const path = segs(params.path);
  if (path.length === 2 && path[0] === "users" && path[1] === "create") {
    const body = await request.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) return json({ message: "invalid request" }, 400);
    const result = createUser(username, password);
    if (result === "created") return json({ username }, 201);
    // 402 is the protocol's "already registered" — kept verbatim.
    return json({ message: "username is already registered" }, 402);
  }

  return json({ message: "not found" }, 404);
}

export async function PUT(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const denied = gateKey(params.key);
  if (denied) return denied;

  const path = segs(params.path);
  if (path.length === 2 && path[0] === "syncs" && path[1] === "progress") {
    const user = gateUser(request);
    if (user instanceof NextResponse) return user;
    const body = await request.json().catch(() => null);
    const document = typeof body?.document === "string" ? body.document : "";
    const progress =
      typeof body?.progress === "string"
        ? body.progress
        : body?.progress != null
          ? String(body.progress)
          : "";
    const percentage = typeof body?.percentage === "number" ? body.percentage : NaN;
    if (!document || !progress || !Number.isFinite(percentage)) {
      return json({ message: "invalid request" }, 400);
    }
    const result = putProgress(user.username, {
      document,
      progress,
      percentage,
      device: typeof body?.device === "string" ? body.device : null,
      device_id: typeof body?.device_id === "string" ? body.device_id : null,
    });
    return json(result);
  }

  return json({ message: "not found" }, 404);
}
