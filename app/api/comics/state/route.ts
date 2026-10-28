import { NextResponse } from "next/server";
import { getComicReadState } from "@/lib/queries";

export const dynamic = "force-dynamic";

// The whole comics read state, for MU Shelf (the iOS reader) to sync against.
// Gated by the middleware's hub-auth cookie like every other /api route; the
// app gets that cookie by logging in with the feed password.
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ read: getComicReadState() });
  } catch (err) {
    console.error("[api/comics/state] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
