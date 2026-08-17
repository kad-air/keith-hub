import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { bookCoverPath, getBook } from "@/lib/books/store";

export const dynamic = "force-dynamic";

// Cover bytes for the /books UI (cookie-gated via middleware). Devices use
// the /opds key-in-URL cover route instead.
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const book = getBook(params.id);
  if (!book?.coverName) return new NextResponse(null, { status: 404 });
  const p = bookCoverPath({ id: book.id, coverName: book.coverName });
  if (!fs.existsSync(p)) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(fs.readFileSync(p)), {
    headers: {
      "Content-Type": book.coverName.endsWith(".png") ? "image/png" : "image/jpeg",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
