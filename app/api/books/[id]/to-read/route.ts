import { NextRequest, NextResponse } from "next/server";
import { setToRead } from "@/lib/books/store";

export const dynamic = "force-dynamic";

// Put a book on the "To Read" shelf, or take it off.
//
// Its own endpoint rather than a field on PUT /api/books/[id], because that
// route carries BookEdit — the shape check:books:metadata reasons about when
// it asserts an edit is cosmetic. To Read is reader state, not metadata about
// the book, and keeping the two apart keeps that gate's subject unchanged.
//
// Cookie-gated like the rest of /api/books (the manage surface); the DEVICE
// only ever reads the resulting shelf, through the key-in-URL OPDS route.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    if (typeof body?.toRead !== "boolean") {
      return NextResponse.json({ error: "toRead must be a boolean" }, { status: 400 });
    }
    const book = setToRead(params.id, body.toRead);
    if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ book });
  } catch (err) {
    console.error("[api/books to-read] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
