import { readFileSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getBook, bookFilePath } from "@/lib/books/store";
import { findPhrase } from "@/lib/books/xpointer";

export const dynamic = "force-dynamic";

// Catch-up, step 1: search the epub's own text for a phrase (typically one
// just heard in the audiobook edition) and return candidate positions, each
// with a synthesized x-pointer and a context snippet for the user to confirm.
// Read-only — nothing is written until the user picks one (set-position).
//
// Cookie-gated with the rest of /api/books: this is a manage-surface feature,
// never something a device calls.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    const phrase = typeof body?.phrase === "string" ? body.phrase.trim() : "";
    if (phrase.split(/\s+/).filter(Boolean).length < 3) {
      return NextResponse.json(
        { error: "give at least three words — short fragments match everywhere" },
        { status: 400 },
      );
    }

    const book = getBook(params.id);
    if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });

    let bytes: Buffer;
    try {
      bytes = readFileSync(bookFilePath(book));
    } catch {
      return NextResponse.json({ error: "stored file unreadable" }, { status: 500 });
    }

    const result = findPhrase(bytes, phrase);
    if (!result) {
      return NextResponse.json({ error: "could not read this epub's spine" }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/books find-position] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
