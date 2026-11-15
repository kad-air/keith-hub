import { NextRequest, NextResponse } from "next/server";
import { getBookByPartialMd5 } from "@/lib/books/store";
import { aliasesOf, listProgress, resolveDocument } from "@/lib/books/kosync";
import { getBookHistory } from "@/lib/books/statsData";

export const dynamic = "force-dynamic";

// Look a book up by its kosync document key — the partial MD5 of the file's
// bytes (lib/books/partialMd5.ts) that every reader computes for itself. This
// is how a native client that already knows the key (a private Sheafs build)
// finds the hub's book for the file it has open.
//
// The key goes through resolveDocument first, the same as a kosync GET/PUT:
// a device holding the copy from BEFORE a file edit (replaceBookFile) still
// has the old key, and that key is an alias of the book's current one. So an
// old copy and a new copy both find the same book and the same position.
//
// The response is what /books/[id] is built from (book, latest sync, the
// book's reading history), assembled by the same functions in the same way.
// Cookie-gated like the rest of /api/books, or the Books app token.
export async function GET(
  _request: NextRequest,
  { params }: { params: { partialMd5: string } },
): Promise<NextResponse> {
  const key = params.partialMd5.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(key)) {
    return NextResponse.json({ error: "not a partial MD5 (32 hex characters)" }, { status: 400 });
  }
  try {
    const document = resolveDocument(key);
    const book = getBookByPartialMd5(document);
    if (!book) return NextResponse.json({ error: "no book with this key" }, { status: 404 });

    // Newest first: the first row for this file is the latest position from any device.
    const sync = listProgress().find((p) => p.document === book.partialMd5) ?? null;

    return NextResponse.json(
      {
        book,
        matchedAlias: key !== book.partialMd5,
        aliases: aliasesOf(book.partialMd5),
        sync: sync
          ? {
              progress: sync.progress,
              percentage: sync.percentage,
              device: sync.device,
              timestamp: sync.timestamp,
            }
          : null,
        history: getBookHistory(book.partialMd5),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[api/books by-md5] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
