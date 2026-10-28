import { readFileSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getBook, bookFilePath } from "@/lib/books/store";
import { listProgress } from "@/lib/books/kosync";
import { pageStartFor, pageWindow, parseBookCached, resolvePosition } from "@/lib/books/pageText";

export const dynamic = "force-dynamic";

// The current-page view's text: a page's worth of the epub at the latest
// synced position (no `from`), or from a given word (`?from=N`, the view's
// prev/next). Every response carries the latest sync so the view can tell a
// new position arrived. Read-only — the stored pointer is resolved for
// display and never written back (see lib/books/pageText.ts).
//
// Cookie-gated with the rest of /api/books: the view is a manage-surface page,
// never something a device calls.
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const book = getBook(params.id);
    if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });

    let parsed;
    try {
      parsed = parseBookCached(book.sha256, () => readFileSync(bookFilePath(book)));
    } catch {
      return NextResponse.json({ error: "stored file unreadable" }, { status: 500 });
    }
    if (!parsed) return NextResponse.json({ error: "could not read this epub's spine" }, { status: 422 });

    // listProgress is newest first: the first row for this file is the latest
    // position from any device.
    const sync = listProgress().find((p) => p.document === book.partialMd5) ?? null;
    const position = resolvePosition(parsed, sync?.progress ?? null, sync?.percentage ?? null);

    const fromParam = request.nextUrl.searchParams.get("from");
    const from = fromParam != null && /^\d+$/.test(fromParam) ? parseInt(fromParam, 10) : null;
    const start = from ?? pageStartFor(parsed, position.word);
    const window = pageWindow(parsed, start, sync ? position.word : null);

    return NextResponse.json(
      {
        sync: sync
          ? {
              percentage: sync.percentage,
              device: sync.device,
              timestamp: sync.timestamp,
              word: position.word,
              precision: position.precision,
            }
          : null,
        window,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[api/books current-text] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
