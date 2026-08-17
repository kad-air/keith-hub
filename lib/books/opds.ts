// OPDS 1.2 (Atom XML) feed builders. Pure string building — no db, no fs —
// so the check scripts can exercise the exact emitter the routes use.
//
// 🔴 Shaped by CrossPoint's parser (lib/OpdsParser/OpdsParser.cpp), where every
// constraint is a SILENT failure if violated (BOOKS_PLAN §2):
//   - acquisition type is matched with exact strcmp: "application/epub+zip"
//   - acquisition rel is matched with strstr on "opds-spec.org/acquisition"
//   - the href should contain ".epub"
//   - pagination rels are "next" and "previous" (NOT "prev")
//   - a feed page holds at most 62 entries (ENTRY_STORAGE_CAPACITY - 2);
//     PAGE_SIZE stays comfortably under it
//   - title/author caps 160/120 chars (we emit as-is; nothing real exceeds them)
// check:books:opds asserts each of these on the emitted XML.
import type { Book } from "./store.ts";

export const PAGE_SIZE = 50; // < CrossPoint's hard cap of 62

export const NAV_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
export const ACQ_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";
export const EPUB_TYPE = "application/epub+zip";
export const ACQ_REL = "http://opds-spec.org/acquisition";
export const IMAGE_REL = "http://opds-spec.org/image";
export const THUMB_REL = "http://opds-spec.org/image/thumbnail";
export const SEARCH_TYPE = "application/opensearchdescription+xml";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type Link = { rel: string; type: string; href: string };

function linkXml(l: Link): string {
  return `<link rel="${esc(l.rel)}" type="${esc(l.type)}" href="${esc(l.href)}"/>`;
}

/** Safe single path segment for the download href (must keep ".epub"). */
export function fileSegment(book: Pick<Book, "title" | "fileName">): string {
  const base = (book.title || book.fileName.replace(/\.epub$/i, ""))
    .replace(/[^\w .'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${encodeURIComponent(base || "book")}.epub`;
}

function coverMime(coverName: string): string {
  return coverName.endsWith(".png")
    ? "image/png"
    : coverName.endsWith(".gif")
      ? "image/gif"
      : coverName.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
}

export function bookEntry(book: Book, base: string): string {
  const links: Link[] = [
    {
      rel: ACQ_REL,
      type: EPUB_TYPE,
      href: `${base}/books/${book.id}/file/${fileSegment(book)}`,
    },
  ];
  if (book.coverName) {
    const mime = coverMime(book.coverName);
    links.push({ rel: IMAGE_REL, type: mime, href: `${base}/books/${book.id}/cover` });
    links.push({ rel: THUMB_REL, type: mime, href: `${base}/books/${book.id}/cover` });
  }
  const series =
    book.series != null
      ? `<content type="text">${esc(
          `${book.series}${book.seriesIndex != null ? ` #${book.seriesIndex}` : ""}${
            book.description ? ` — ${book.description}` : ""
          }`,
        )}</content>`
      : book.description
        ? `<content type="text">${esc(book.description)}</content>`
        : "<content/>";
  return [
    "<entry>",
    `<title>${esc(book.title)}</title>`,
    `<id>urn:uuid:${esc(book.id)}</id>`,
    `<updated>${esc(book.updatedAt)}</updated>`,
    book.author ? `<author><name>${esc(book.author)}</name></author>` : "",
    series,
    ...links.map(linkXml),
    "</entry>",
  ]
    .filter(Boolean)
    .join("");
}

export function navEntry(title: string, href: string, summary: string): string {
  return [
    "<entry>",
    `<title>${esc(title)}</title>`,
    `<id>${esc(href)}</id>`,
    `<updated>${new Date().toISOString()}</updated>`,
    `<content type="text">${esc(summary)}</content>`,
    linkXml({ rel: "subsection", type: ACQ_TYPE, href }),
    "</entry>",
  ].join("");
}

export function feed(opts: {
  id: string;
  title: string;
  self: string;
  base: string;
  kind: "navigation" | "acquisition";
  entries: string[];
  /** total entry count for pagination; when set, self must accept ?page= */
  page?: { current: number; total: number; href: (page: number) => string };
  searchHref?: string;
}): string {
  const links: Link[] = [
    { rel: "self", type: opts.kind === "navigation" ? NAV_TYPE : ACQ_TYPE, href: opts.self },
    { rel: "start", type: NAV_TYPE, href: `${opts.base}/catalog` },
  ];
  if (opts.searchHref) {
    links.push({ rel: "search", type: SEARCH_TYPE, href: opts.searchHref });
  }
  if (opts.page) {
    const { current, total, href } = opts.page;
    // 🔴 "previous", never "prev" — CrossPoint reads only next/previous, and a
    // "prev" rel silently kills back-navigation on the device.
    if (current > 0) links.push({ rel: "previous", type: ACQ_TYPE, href: href(current - 1) });
    if (current < total - 1) links.push({ rel: "next", type: ACQ_TYPE, href: href(current + 1) });
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">`,
    `<id>${esc(opts.id)}</id>`,
    `<title>${esc(opts.title)}</title>`,
    `<updated>${new Date().toISOString()}</updated>`,
    `<author><name>The Feed</name></author>`,
    ...links.map(linkXml),
    ...opts.entries,
    `</feed>`,
  ].join("");
}

export function openSearchDescription(base: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">`,
    `<ShortName>Books</ShortName>`,
    `<Description>Search the book library</Description>`,
    `<Url type="${esc(ACQ_TYPE)}" template="${esc(`${base}/search/feed`)}?q={searchTerms}"/>`,
    `</OpenSearchDescription>`,
  ].join("");
}

export function paginate<T>(items: T[], page: number): { slice: T[]; total: number } {
  const total = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), total - 1);
  return { slice: items.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), total };
}
