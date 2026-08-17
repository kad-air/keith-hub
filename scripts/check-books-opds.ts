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
  wordCount: 90_000,
  toRead: false,
  toReadAt: null,
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

// ── 2b. The "To Read" shelf ───────────────────────────────────────────────
// The X3 has no search, so this feed is how a specific book gets reached
// without scrolling the whole catalog. It is an ordinary acquisition feed and
// must therefore satisfy every device constraint above — a shelf the device
// silently fails to parse is worse than no shelf, because the reader will
// believe the book is there.
{
  const shelf = [mk(7), mk(3), mk(11)]; // newest-decision-first, as listToRead returns
  const self = `${base}/to-read`;
  const shelfXml = feed({
    id: self,
    title: "To Read",
    self,
    base,
    kind: "acquisition",
    entries: shelf.map((b) => bookEntry(b, base)),
    page: { current: 0, total: 1, href: (p) => `${self}?page=${p}` },
    searchHref: `${base}/search`,
  });

  const shelfEntries = [...shelfXml.matchAll(/<entry>.*?<\/entry>/gs)].map((m) => m[0]);
  assert(shelfEntries.length === 3, "the To Read feed carries exactly the flagged books");
  assert(
    shelfEntries.every((e) => e.includes(`type="${EPUB_TYPE}"`)),
    "To Read: every acquisition type is EXACTLY the epub type (strcmp on the device)",
  );
  assert(
    shelfEntries.every((e) => e.includes(`rel="${ACQ_REL}"`)),
    "To Read: every entry carries the acquisition rel",
  );
  assert(
    shelfEntries.every((e) => /href="[^"]*\.epub"/.test(e)),
    'To Read: every acquisition href contains ".epub"',
  );
  assert(!/rel="prev"[^i]/.test(shelfXml), 'To Read: no rel="prev" (device reads only "previous")');

  // 🔴 Order is the point of the shelf and must survive the emitter: newest
  // decision first, so the thing just picked out is the first thing the device
  // shows. Re-sorting it by author (as every other feed does) would bury it.
  const titles = shelfEntries.map((e) => e.match(/<title>(.*?)<\/title>/)![1]);
  assert(
    titles.join(",") === "Book 7,Book 3,Book 11",
    `To Read preserves its given order rather than re-sorting (${titles.join(", ")})`,
  );

  // An empty shelf must still emit a VALID feed — the catalog root always
  // advertises the entry, so it must always open rather than 404 or crash.
  const emptyXml = feed({
    id: self,
    title: "To Read",
    self,
    base,
    kind: "acquisition",
    entries: [],
    page: { current: 0, total: 1, href: (p) => `${self}?page=${p}` },
  });
  assert(!/<entry>/.test(emptyXml), "an empty To Read shelf emits a feed with no entries");
  assert(/<title>To Read<\/title>/.test(emptyXml), "…and still names itself");

  // A shelf bigger than one page still respects the 62-entry cap.
  const big = Array.from({ length: 70 }, (_, i) => mk(i));
  const bigPage = paginate(big, 0);
  assert(
    bigPage.slice.length <= 62,
    "a To Read shelf over one page still honours CrossPoint's 62-entry cap",
  );
}

// ── 2c. 🔴 Flagging a book is a DB write and nothing more ─────────────────
// setToRead is a SECOND write path into the books table. check:books:metadata
// proves updateBook can't disturb the file — it says nothing about this one,
// and a flag that rewrote the epub would silently detach kosync progress on
// every device at once. Flagging the book you are reading must be free.
{
  const os = await import("node:os");
  const { createHash } = await import("node:crypto");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-toread-check-"));
  const cwd = process.cwd();
  process.chdir(tmp);

  const { ingestBook, setToRead, getBook, bookFilePath, listToRead } = await import(
    "../lib/books/store.ts"
  );
  const bytes = fs.readFileSync(path.resolve(repoRoot, "books-fixture/fixture.epub"));
  const { book } = ingestBook(bytes, "The Fixture Book.epub");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const fileBefore = sha(fs.readFileSync(bookFilePath(book)));
  const mtimeBefore = fs.statSync(bookFilePath(book)).mtimeMs;

  assert(book.toRead === false, "a freshly ingested book is not on the shelf");
  assert(listToRead().length === 0, "…and the shelf starts empty");

  const flagged = setToRead(book.id, true)!;
  assert(flagged.toRead === true && flagged.toReadAt != null, "flagging sets the flag and a date");
  assert(listToRead().map((b) => b.id).join() === book.id, "…and the book appears on the shelf");
  assert(
    sha(fs.readFileSync(bookFilePath(book))) === fileBefore,
    "🔴 flagging To Read leaves the stored epub byte-identical",
  );
  assert(fs.statSync(bookFilePath(book)).mtimeMs === mtimeBefore, "…the file was not even rewritten");
  assert(
    flagged.sha256 === book.sha256 && flagged.partialMd5 === book.partialMd5,
    "🔴 sha256 and partial_md5 (the kosync sync key) are unchanged",
  );
  assert(flagged.wordCount === book.wordCount, "…and the word count is untouched");

  // 🔴 The ORDER, asserted against listToRead itself and not just the emitter.
  // The shelf's whole value is that the book you just picked out is the first
  // one the device shows; re-sorting it by author (which every other feed
  // does, and which looks like a tidy-up) buries it. Asserting only that the
  // emitter preserves a given order cannot see that — measured: swapping the
  // ORDER BY to author left the emitter assertion green.
  const mkBook = (name: string) => ingestBook(Buffer.from(`epub bytes for ${name}`), `${name}.epub`).book;
  const alpha = mkBook("Alpha");
  const zulu = mkBook("Zulu");
  setToRead(zulu.id, true);
  setToRead(alpha.id, true);
  // Same-millisecond flags would tie, so pin the timestamps explicitly: Zulu
  // chosen first, Alpha chosen second and therefore on top.
  const db = (await import("../lib/db.ts")).getDb();
  // 🔴 Alpha is chosen FIRST and Zulu SECOND, so the correct shelf order
  // (Zulu, Alpha) DISAGREES with alphabetical. That disagreement is the whole
  // point: named the other way round the two orderings coincide and the
  // assertion passes against a re-sorted implementation — which is exactly
  // what happened on the first attempt at this check.
  db.prepare(`UPDATE books SET to_read_at = ? WHERE id = ?`).run("2026-08-01T00:00:00Z", alpha.id);
  db.prepare(`UPDATE books SET to_read_at = ? WHERE id = ?`).run("2026-08-02T00:00:00Z", zulu.id);
  // Relative order of the two we control — other books may also be on the
  // shelf at this point, and their positions aren't the property under test.
  const shelfOrder = listToRead()
    .map((x) => x.title)
    .filter((t) => t === "Alpha" || t === "Zulu");
  assert(
    shelfOrder.join(",") === "Zulu,Alpha",
    `🔴 listToRead is newest-decision-first, NOT alphabetical (got ${shelfOrder.join(", ")})`,
  );
  db.prepare(`UPDATE books SET to_read = 0, to_read_at = NULL WHERE id IN (?, ?)`).run(
    alpha.id,
    zulu.id,
  );

  const cleared = setToRead(book.id, false)!;
  assert(cleared.toRead === false && cleared.toReadAt === null,
    "clearing the flag nulls the date, so re-adding returns to the top of the shelf");
  assert(listToRead().length === 0, "…and the shelf is empty again");
  assert(setToRead("no-such-book", true) === null, "an unknown id is a null, not a throw");

  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

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
