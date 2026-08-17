import { NextRequest, NextResponse } from "next/server";
import { getBook } from "@/lib/books/store";
import { firstUsername, putProgress, getProgress } from "@/lib/books/kosync";
import { isSynthesizedPointer } from "@/lib/books/xpointer";

export const dynamic = "force-dynamic";

// Catch-up, step 2: write a position the user confirmed from find-position's
// candidates. Goes through putProgress — the SAME single write path every
// device sync uses — so the reading-events history records the movement and
// the try/catch that protects the position protects this write too. The
// device picks the new position up on its next sync.
//
// 🔴 Only pointers in the synthesized dialect are accepted
// (isSynthesizedPointer). This route must never become a general "write any
// progress string" endpoint: the opacity rule exists because a malformed
// pointer doesn't error, it silently drops the device somewhere wrong.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    const pointer = typeof body?.pointer === "string" ? body.pointer : "";
    const percentage = typeof body?.percentage === "number" ? body.percentage : NaN;
    if (!isSynthesizedPointer(pointer)) {
      return NextResponse.json({ error: "not a synthesized pointer" }, { status: 400 });
    }
    if (!(percentage >= 0 && percentage <= 1)) {
      return NextResponse.json({ error: "percentage must be 0..1" }, { status: 400 });
    }

    const book = getBook(params.id);
    if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });

    const username = firstUsername();
    if (!username) {
      // No device has ever registered — there is no sync account to write to,
      // and inventing one here would collide with the real device's later
      // registration. The UI surfaces this as "sync a device first".
      return NextResponse.json({ error: "no kosync reader registered yet" }, { status: 409 });
    }

    putProgress(username, {
      document: book.partialMd5,
      progress: pointer,
      percentage,
      device: "hub",
      device_id: "hub-catch-up",
    });

    return NextResponse.json({ sync: getProgress(username, book.partialMd5) });
  } catch (err) {
    console.error("[api/books set-position] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
