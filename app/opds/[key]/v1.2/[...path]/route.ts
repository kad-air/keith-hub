import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { checkBooksApiKey } from "@/lib/books/apiKey";
import {
  bookFilePath,
  bookCoverPath,
  getBook,
  listBooks,
  listToRead,
  type Book,
} from "@/lib/books/store";
import {
  ACQ_TYPE,
  NAV_TYPE,
  SEARCH_TYPE,
  bookEntry,
  feed,
  fileSegment,
  navEntry,
  openSearchDescription,
  paginate,
} from "@/lib/books/opds";
import { fold } from "@/lib/books/normalize";

export const dynamic = "force-dynamic";

// The whole OPDS 1.2 surface as one catch-all: a single auth chokepoint, and
// the URL shape mirrors Stump's (/opds/{key}/v1.2/...) so the devices'
// configured URLs change only in hostname at cutover.
//
// This route is EXEMPT from middleware.ts (key-in-URL is the auth; a reading
// device cannot present the hub-auth cookie). It fails CLOSED when
// BOOKS_API_KEY is unset — see lib/books/apiKey.ts.

function xml(body: string, type: string): NextResponse {
  return new NextResponse(body, {
    headers: { "Content-Type": `${type}; charset=utf-8` },
  });
}

function notFound(): NextResponse {
  return new NextResponse("not found", { status: 404 });
}

function sortForCatalog(books: Book[]): Book[] {
  return [...books].sort((a, b) => {
    const ka = `${a.author ?? "~"}|${a.series ?? "~"}|${String(a.seriesIndex ?? "").padStart(6, "0")}|${a.title}`;
    const kb = `${b.author ?? "~"}|${b.series ?? "~"}|${String(b.seriesIndex ?? "").padStart(6, "0")}|${b.title}`;
    return ka.localeCompare(kb);
  });
}

function acquisitionFeed(
  base: string,
  self: string,
  id: string,
  title: string,
  books: Book[],
  page: number,
  pageHref: (p: number) => string,
): NextResponse {
  const { slice, total } = paginate(books, page);
  return xml(
    feed({
      id,
      title,
      self,
      base,
      kind: "acquisition",
      entries: slice.map((b) => bookEntry(b, base)),
      page: { current: page, total, href: pageHref },
      searchHref: `${base}/search`,
    }),
    ACQ_TYPE,
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: { key: string; path: string[] } },
): Promise<NextResponse> {
  if (!checkBooksApiKey(params.key)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const base = `/opds/${params.key}/v1.2`;
  // Empty segments filtered for the same reason as the kosync route: a base
  // URL saved with a trailing slash must not 308 at a device that may not
  // follow redirects.
  const path = params.path.filter((s) => s !== "");
  const page = Math.max(0, parseInt(request.nextUrl.searchParams.get("page") ?? "0", 10) || 0);

  // ── catalog: the navigation root ─────────────────────────────────────────
  if (path.length === 1 && path[0] === "catalog") {
    // 🔴 "To Read" is FIRST, deliberately. The whole point of the shelf is that
    // the X3 has no search, so reaching a specific book means scrolling — and a
    // shortcut buried under three other entries is a shortcut to nothing. The
    // count rides in the summary so the shelf's state is visible from the root
    // without opening it.
    const toReadCount = listToRead().length;
    const entries = [
      navEntry(
        "To Read",
        `${base}/to-read`,
        toReadCount === 0
          ? "Nothing on the shelf yet — flag books in the hub"
          : `${toReadCount} book${toReadCount === 1 ? "" : "s"} you've picked out`,
      ),
      navEntry("All Books", `${base}/books`, "Every book, by author and series"),
      navEntry("Recently Added", `${base}/books/latest`, "Newest additions first"),
      navEntry("Series", `${base}/series`, "Browse by series"),
      navEntry("Authors", `${base}/authors`, "Browse by author"),
    ];
    return xml(
      feed({
        id: `${base}/catalog`,
        title: "Books",
        self: `${base}/catalog`,
        base,
        kind: "navigation",
        entries,
        searchHref: `${base}/search`,
      }),
      NAV_TYPE,
    );
  }

  // ── to-read ──────────────────────────────────────────────────────────────
  // Already ordered newest-decision-first by listToRead(); deliberately NOT
  // run through sortForCatalog, which would re-sort it by author and lose the
  // "what I picked out most recently" ordering the shelf exists for.
  //
  // An empty shelf still returns a valid, empty acquisition feed rather than a
  // 404: the entry is always in the catalog root, so it must always open.
  if (path.length === 1 && path[0] === "to-read") {
    return acquisitionFeed(
      base,
      `${base}/to-read`,
      `${base}/to-read`,
      "To Read",
      listToRead(),
      page,
      (p) => `${base}/to-read?page=${p}`,
    );
  }

  // ── books / books/latest ─────────────────────────────────────────────────
  if (path.length === 1 && path[0] === "books") {
    return acquisitionFeed(
      base,
      `${base}/books`,
      `${base}/books`,
      "All Books",
      sortForCatalog(listBooks()),
      page,
      (p) => `${base}/books?page=${p}`,
    );
  }
  if (path.length === 2 && path[0] === "books" && path[1] === "latest") {
    const books = [...listBooks()].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    return acquisitionFeed(
      base,
      `${base}/books/latest`,
      `${base}/books/latest`,
      "Recently Added",
      books,
      page,
      (p) => `${base}/books/latest?page=${p}`,
    );
  }

  // ── series / series/<name> ───────────────────────────────────────────────
  if (path.length === 1 && (path[0] === "series" || path[0] === "authors")) {
    const kind = path[0];
    const books = listBooks();
    const names = new Map<string, { name: string; count: number }>();
    for (const b of books) {
      const name = kind === "series" ? b.series : b.author;
      if (!name) continue;
      const key = fold(name);
      const cur = names.get(key);
      if (cur) cur.count++;
      else names.set(key, { name, count: 1 });
    }
    const entries = [...names.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, count }) =>
        navEntry(name, `${base}/${kind}/${encodeURIComponent(name)}`, `${count} book${count === 1 ? "" : "s"}`),
      );
    return xml(
      feed({
        id: `${base}/${kind}`,
        title: kind === "series" ? "Series" : "Authors",
        self: `${base}/${kind}`,
        base,
        kind: "navigation",
        entries,
        searchHref: `${base}/search`,
      }),
      NAV_TYPE,
    );
  }
  if (path.length === 2 && (path[0] === "series" || path[0] === "authors")) {
    const kind = path[0];
    const name = decodeURIComponent(path[1]);
    const books = sortForCatalog(
      listBooks().filter((b) => fold(kind === "series" ? b.series : b.author) === fold(name)),
    );
    if (books.length === 0) return notFound();
    const self = `${base}/${kind}/${encodeURIComponent(name)}`;
    return acquisitionFeed(base, self, self, name, books, page, (p) => `${self}?page=${p}`);
  }

  // ── search ───────────────────────────────────────────────────────────────
  if (path.length === 1 && path[0] === "search") {
    return xml(openSearchDescription(base), SEARCH_TYPE);
  }
  if (path.length === 2 && path[0] === "search" && path[1] === "feed") {
    const q = fold(request.nextUrl.searchParams.get("q") ?? "");
    const books = q
      ? sortForCatalog(
          listBooks().filter(
            (b) =>
              fold(b.title).includes(q) ||
              fold(b.author).includes(q) ||
              fold(b.series).includes(q),
          ),
        )
      : [];
    const self = `${base}/search/feed?q=${encodeURIComponent(request.nextUrl.searchParams.get("q") ?? "")}`;
    return acquisitionFeed(base, self, self, "Search", books, page, (p) => `${self}&page=${p}`);
  }

  // ── the bytes ────────────────────────────────────────────────────────────
  // books/<id>/file/<name>.epub and books/<id>/cover
  if (path.length >= 3 && path[0] === "books") {
    const book = getBook(path[1]);
    if (!book) return notFound();

    if (path[2] === "cover" && book.coverName) {
      const p = bookCoverPath({ id: book.id, coverName: book.coverName });
      if (!fs.existsSync(p)) return notFound();
      const mime = book.coverName.endsWith(".png") ? "image/png" : "image/jpeg";
      return new NextResponse(new Uint8Array(fs.readFileSync(p)), {
        headers: { "Content-Type": mime, "Cache-Control": "private, max-age=3600" },
      });
    }

    if (path[2] === "file") {
      // 🔴 Serve the stored bytes UNTOUCHED (BOOKS_PLAN §4): no compression,
      // no rewriting. The kosync document key is a hash of these bytes,
      // computed on-device; any transform silently detaches progress
      // everywhere. check:books:live re-downloads through this route and
      // asserts sha256 equality against the DB row.
      const filePath = bookFilePath(book);
      if (!fs.existsSync(filePath)) return notFound();
      const size = book.fileSize;
      const common = {
        "Content-Type": "application/epub+zip",
        "Accept-Ranges": "bytes",
        "Content-Disposition": `attachment; filename="${fileSegment(book)}"`,
      };

      // Range support — a resumed download on a flaky e-reader connection is
      // the normal case, not the edge case.
      const range = request.headers.get("range");
      const m = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (m && (m[1] || m[2])) {
        const start = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10);
        const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        if (start < 0 || start > end || start >= size) {
          return new NextResponse(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        }
        const stream = fs.createReadStream(filePath, { start, end });
        return new NextResponse(stream as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...common,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }

      const stream = fs.createReadStream(filePath);
      return new NextResponse(stream as unknown as ReadableStream, {
        headers: { ...common, "Content-Length": String(size) },
      });
    }
  }

  return notFound();
}
