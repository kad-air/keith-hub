import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { bookFilePath, getBook } from "@/lib/books/store";
import { fileSegment } from "@/lib/books/opds";

export const dynamic = "force-dynamic";

// Download for the /books UI (cookie-gated). Devices download via /opds.
// 🔴 Same §4 invariant as the OPDS file route: stored bytes, untouched.
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const book = getBook(params.id);
  if (!book) return new NextResponse(null, { status: 404 });
  const p = bookFilePath(book);
  if (!fs.existsSync(p)) return new NextResponse(null, { status: 404 });
  const stream = fs.createReadStream(p);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Length": String(book.fileSize),
      "Content-Disposition": `attachment; filename="${fileSegment(book)}"`,
    },
  });
}
