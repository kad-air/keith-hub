import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { firstUsername, setPassword } from "@/lib/books/kosync";

export const dynamic = "force-dynamic";

// The kosync account is seeded by the first device and the hub had no way to
// change its password afterwards (kosync has no change-password call; the
// devices only ever register). This route is the operator's lever: GET names
// the account (the hub never rendered it anywhere, and the devices are the
// only other place it lives), POST rotates its password.
//
// Gated by middleware.ts's FEED_PASSWORD cookie like every other /api/books
// route — deliberately NOT by the books key in the URL, which is the device
// credential this route exists to outlive. md5 is computed here because that
// is the kosync WIRE value (lib/books/kosync.ts header): what we store is
// sha256 of it, same as a device registration.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ username: firstUsername() });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 12) {
    return NextResponse.json({ error: "password must be at least 12 characters" }, { status: 400 });
  }
  const wireKey = createHash("md5").update(password).digest("hex");
  const username = setPassword(wireKey);
  if (!username) {
    return NextResponse.json({ error: "no device has registered yet" }, { status: 409 });
  }
  return NextResponse.json({ username });
}
