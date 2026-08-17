#!/usr/bin/env node
//
// 🔴 THE OPDS FORMAT GATE (BOOKS_PLAN §10).
//
//   npm run check:books:opds       (standalone)
//   npm run build                  (via prebuild)
//
// Asserts the DEVICE's contract, not our self-consistency — the assertion set
// is ported from ~/Stump/healthcheck.sh, whose items encode the landmines
// CrossPoint's parser actually has (exact strcmp on the epub type, strstr on
// the acquisition rel, ".epub" in the href, ≤62 entries/page, rel="previous"
// not "prev"). Two independent anchors keep it honest:
//
//   1. books-fixture/stump-books-feed.xml — a committed snapshot of Stump's
//      live OPDS feed for this exact library, i.e. XML the physical X3 has
//      parsed successfully in production. Our rel/type constants are asserted
//      EQUAL to the ones found in it, so a typo'd constant cannot self-agree.
//   2. rss-parser (a real Atom parser, not our own emitter) must parse our
//      emitted feed and see the right entry count.
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";

const { feed, bookEntry, paginate, PAGE_SIZE, EPUB_TYPE, ACQ_REL, fileSegment } =
  await import("../lib/books/opds.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("check:books:opds — the device-contract gate\n");

// ── 1. Anchor our constants against the feed the X3 actually parsed ────────
const stumpFeed = fs.readFileSync(
  path.resolve(repoRoot, "books-fixture/stump-books-feed.xml"),
  "utf8",
);
const stumpRel = stumpFeed.match(/rel="(http:\/\/opds-spec\.org\/acquisition[^"]*)"/)?.[1];
const stumpType = /type="application\/epub\+zip"/.test(stumpFeed);
assert(stumpRel === ACQ_REL, `ACQ_REL equals the rel in Stump's device-proven feed ("${stumpRel}")`);
assert(stumpType, "Stump's feed uses the exact epub type our EPUB_TYPE matches");
assert(
  stumpFeed.includes(`type="${EPUB_TYPE}"`),
  "EPUB_TYPE string-equal to the device-proven type attribute",
);

// ── 2. Emit a 70-book feed and assert the CrossPoint constraints ──────────
type FakeBook = Parameters<typeof bookEntry>[0];
const mk = (i: number): FakeBook => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  title: `Book ${i}`,
  author: i % 2 ? "Alice Author" : "Bob Builder",
  series: i % 3 ? "The Series" : null,
  seriesIndex: i % 3 ? i : null,
  language: "en",
  description: "d",
  fileName: `book-${i}.epub`,
  fileSize: 1000,
  sha256: "x",
  partialMd5: "y",
  coverName: i % 2 ? "cover.jpg" : null,
  addedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const books = Array.from({ length: 70 }, (_, i) => mk(i));
const base = "/opds/KEY/v1.2";

const page0 = paginate(books, 0);
const page1 = paginate(books, 1);
assert(page0.total === 2, "70 books paginate to 2 pages");
assert(
  page0.slice.length <= 62 && page1.slice.length <= 62,
  `no page exceeds CrossPoint's 62-entry cap (PAGE_SIZE=${PAGE_SIZE})`,
);

const xml0 = feed({
  id: `${base}/books`,
  title: "All Books",
  self: `${base}/books`,
  base,
  kind: "acquisition",
  entries: page0.slice.map((b) => bookEntry(b, base)),
  page: { current: 0, total: page0.total, href: (p) => `${base}/books?page=${p}` },
  searchHref: `${base}/search`,
});
const xml1 = feed({
  id: `${base}/books`,
  title: "All Books",
  self: `${base}/books?page=1`,
  base,
  kind: "acquisition",
  entries: page1.slice.map((b) => bookEntry(b, base)),
  page: { current: 1, total: page1.total, href: (p) => `${base}/books?page=${p}` },
});

assert((xml0.match(/<entry>/g) ?? []).length === PAGE_SIZE, "page 0 carries PAGE_SIZE entries");
assert(/rel="next"/.test(xml0), 'page 0 links rel="next"');
assert(!/rel="previous"/.test(xml0), "page 0 has no previous link");
assert(/rel="previous"/.test(xml1), 'page 1 links rel="previous"');
assert(!/rel="prev"[^i]/.test(xml1), 'no rel="prev" anywhere (CrossPoint reads only "previous")');

// Per-entry device constraints, on every entry of both pages.
const entries = [...xml0.matchAll(/<entry>.*?<\/entry>/gs), ...xml1.matchAll(/<entry>.*?<\/entry>/gs)]
  .map((m) => m[0]);
assert(entries.length === 70, "70 entries across both pages");
assert(
  entries.every((e) => e.includes(`type="${EPUB_TYPE}"`)),
  `every acquisition link's type is EXACTLY "${EPUB_TYPE}" (strcmp on the device)`,
);
assert(
  entries.every((e) => e.includes(`rel="${ACQ_REL}"`)),
  "every entry carries the acquisition rel (strstr on the device)",
);
assert(
  entries.every((e) => /href="[^"]*\.epub"/.test(e)),
  'every acquisition href contains ".epub" (device preference)',
);
assert(
  entries.every((e) => (e.match(/<title>(.*?)<\/title>/)?.[1] ?? "").length <= 160),
  "every title within the device's 160-char cap",
);

// fileSegment keeps ".epub" even for hostile titles.
assert(
  fileSegment({ title: 'Weird / Title: "quotes" & <tags>', fileName: "x.epub" }).endsWith(".epub"),
  "fileSegment always ends in .epub",
);

// ── 3. A real Atom parser accepts our output ───────────────────────────────
const Parser = (await import("rss-parser")).default;
const parsed = await new Parser({ customFields: { item: [] } }).parseString(xml0);
assert(parsed.items.length === PAGE_SIZE, "rss-parser (independent Atom parser) parses our feed");
assert(parsed.title === "All Books", "parsed feed title survives");

// And the committed stump snapshot parses with the same parser — guards the
// fixture itself against rot.
const stumpParsed = await new Parser({ customFields: { item: [] } }).parseString(stumpFeed);
assert(stumpParsed.items.length === 13, "the device-proven fixture still parses (13 entries)");

if (failures > 0) {
  console.error(`\ncheck:books:opds FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:opds OK");
