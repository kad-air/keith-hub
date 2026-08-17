#!/usr/bin/env node
//
// 🔴 THE READING-STATISTICS GATE.
//
//   npm run check:books:stats      (standalone)
//   npm run build                  (via prebuild)
//
// Reading statistics have no error surface. A wrong page count, a streak that
// counts a day nobody read, a projection built on a mis-bucketed calendar —
// all of it renders as a confident number on a page, and the reader has no
// second copy to check it against. Nothing here is verifiable by looking at
// it, which is exactly why it gets a gate instead of a careful read.
//
// Every assertion below is anchored on something that is true INDEPENDENTLY
// of this code:
//
//   · the word count of the fixture epub, computed offline in Python by
//     scripts/gen_book_wordcount_reference.py (a real HTML parser and a real
//     XML parser, against this repo's regexes) and committed to
//     books-fixture/expected.json
//   · an epub built here with a known number of words in a known spine order
//   · the actual 2026 US daylight-saving transitions — the second Sunday in
//     March and the first Sunday in November — which the check re-derives
//     from the calendar rule rather than trusting a constant
//   · the invariant the whole Books section rests on: the bytes, and the
//     reading position, are untouchable by anything decorative
//
// The DST section additionally asserts that the NAIVE bucketing this code
// could have used disagrees with the correct answer. A gate that passes
// against both the right and the wrong implementation is not a gate.
//
// Hermetic: temp cwd before the first getDb().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixtureBytes = fs.readFileSync(path.resolve(repoRoot, "books-fixture/fixture.epub"));
const expected = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, "books-fixture/expected.json"), "utf8"),
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-stats-check-"));
process.chdir(tmp);

const { countEpubWords, PAGE_WORDS } = await import("../lib/books/epubText.ts");
const { ingestBook, getBook, bookFilePath } = await import("../lib/books/store.ts");
const { putProgress, getProgress, createUser } = await import("../lib/books/kosync.ts");
const { listReadingEvents, readingEventCount } = await import("../lib/books/readingEvents.ts");
const { computeReadingStats, dayKey, addDays, daysBetween, FINISH_THRESHOLD } = await import(
  "../lib/books/stats.ts"
);
const { getReadingStats } = await import("../lib/books/statsData.ts");
const { getDb } = await import("../lib/db.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

console.log("check:books:stats — the reading-statistics gate\n");

const TZ = "America/Denver";
let eventId = 0;
/** Build a pure-model event without going near the DB. */
function ev(
  document: string,
  percentage: number,
  delta: number,
  timestamp: number,
  opts: { kind?: "read" | "baseline"; device?: string } = {},
) {
  return {
    id: ++eventId,
    username: "keith",
    document,
    kind: opts.kind ?? ("read" as const),
    percentage,
    delta,
    device: opts.device ?? "CrossPoint",
    device_id: "x3",
    timestamp,
  };
}
const BOOK = (hash: string, words: number, title = "A Book") => ({
  id: hash,
  title,
  author: "An Author",
  series: null,
  seriesIndex: null,
  partialMd5: hash,
  wordCount: words,
  coverName: null,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── the denominator: word counts vs. an independent implementation ──");
// ═══════════════════════════════════════════════════════════════════════════
// Every page number on the stats page is percentage × words ÷ PAGE_WORDS. If
// `words` is wrong, every figure downstream is wrong by the same factor and
// looks entirely plausible.

// 🔴 A static pin, because the failure is invisible from the page. stats.ts is
// imported by client components; epubText.ts imports AdmZip. Sourcing the page
// constant from epubText — the tidiest-looking place for it — shipped 182 kB
// of zip library to the browser on /books/stats, and everything still worked
// perfectly. Only the bundle size ever said so.
{
  const src = (p: string) => fs.readFileSync(path.resolve(repoRoot, p), "utf8");
  const statsSrc = src("lib/books/stats.ts");
  const pagesSrc = src("lib/books/pages.ts");
  assert(
    !/^\s*import\s+(?!type\b)[^;]*from\s+["']\.\/epubText/m.test(statsSrc),
    "🔴 stats.ts does not value-import epubText (that ships AdmZip to the browser)",
  );
  assert(
    /from\s+["']\.\/pages\.ts["']/.test(statsSrc),
    "…it takes PAGE_WORDS from the dependency-free pages.ts instead",
  );
  assert(
    !/^\s*import\s/m.test(pagesSrc),
    "🔴 pages.ts imports nothing at all — that is the whole point of it",
  );
  assert(
    /^\s*import\s+type\s/m.test(statsSrc) && !/require\(/.test(statsSrc),
    "stats.ts's event import is type-only (readingEvents reaches SQLite)",
  );
}

const tsWords = countEpubWords(fixtureBytes);
assert(
  tsWords === expected.text.words,
  `🔴 fixture word count matches the offline Python reference (${expected.text.words})`,
);
assert(PAGE_WORDS === 250, "a page is 250 words — the one place the convention is defined");

// The committed fixture has a single spine document, so it cannot prove the
// spine is being walked at all — a naive "count every xhtml in the zip" gets
// the same answer. Build one that can tell the difference.
function synthEpub(): Buffer {
  const words = (n: number, w: string) => Array.from({ length: n }, () => w).join(" ");
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from(
      `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
       <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
  );
  zip.addFile(
    "OEBPS/content.opf",
    Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
       <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic</dc:title></metadata>
       <manifest>
         <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
         <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
         <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
         <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>
         <item id="css" href="style.css" media-type="text/css"/>
       </manifest>
       <spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
       </package>`,
    ),
  );
  // ch1 hides a stylesheet and a script inside the body — both are markup a
  // reader never sees, and counting them inflates the book.
  zip.addFile(
    "OEBPS/ch1.xhtml",
    Buffer.from(
      `<html><head><title>ignored title words here</title></head><body>
       <style>body { font-family: "many words in here indeed"; }</style>
       <script>var x = "more words that are not prose at all";</script>
       <p>${words(100, "alpha")}</p></body></html>`,
    ),
  );
  zip.addFile("OEBPS/ch2.xhtml", Buffer.from(`<html><body><p>${words(200, "beta")}</p></body></html>`));
  zip.addFile("OEBPS/ch3.xhtml", Buffer.from(`<html><body><p>${words(300, "gamma")}</p></body></html>`));
  // In the manifest but NOT the spine: not part of the reading order.
  zip.addFile(
    "OEBPS/notes.xhtml",
    Buffer.from(`<html><body><p>${words(5000, "delta")}</p></body></html>`),
  );
  zip.addFile("OEBPS/style.css", Buffer.from(`body { margin: 0; } /* words words words */`));
  return zip.toBuffer();
}

const synth = countEpubWords(synthEpub());
assert(synth === 600, `spine-only prose counts exactly (100+200+300 = 600, got ${synth})`);
assert(
  synth !== 5600 && synth !== null,
  "a manifest document outside the spine is NOT counted (would be 5600)",
);

// Adjacent block elements must not glue into one word.
const glue = countEpubWords(
  (() => {
    const zip = new AdmZip();
    zip.addFile(
      "META-INF/container.xml",
      Buffer.from(`<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`),
    );
    zip.addFile(
      "c.opf",
      Buffer.from(
        `<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>
         <spine><itemref idref="a"/></spine></package>`,
      ),
    );
    zip.addFile("a.xhtml", Buffer.from(`<html><body><p>one</p><p>two</p><p>three</p></body></html>`));
    return zip.toBuffer();
  })(),
);
assert(glue === 3, `<p>one</p><p>two</p><p>three</p> is three words, not one (got ${glue})`);
assert(countEpubWords(Buffer.from("not a zip at all")) === null, "a non-epub returns null, not a throw");

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── the calendar: real 2026 US daylight-saving transitions ──");
// ═══════════════════════════════════════════════════════════════════════════
// Day bucketing decides the streak, the heatmap and every "today" figure. Two
// ways to get it wrong, both of which produce a plausible calendar:
//   · bucket in UTC (Railway's clock) and evening reading lands on tomorrow
//   · bucket by floor(ts / 86400) and the 23- and 25-hour DST days drift
//
// The anchors are the DST RULE, not a constant: second Sunday in March, first
// Sunday in November. Re-derived here so a wrong date can't hide in the check.
function nthSundayOfMonth(year: number, month: number, n: number): number {
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, month - 1, d));
    if (dt.getUTCMonth() !== month - 1) break;
    if (dt.getUTCDay() === 0 && ++count === n) return d;
  }
  throw new Error("no such Sunday");
}
assert(nthSundayOfMonth(2026, 3, 2) === 8, "DST 2026 begins Sunday March 8 (2nd Sunday)");
assert(nthSundayOfMonth(2026, 11, 1) === 1, "DST 2026 ends Sunday November 1 (1st Sunday)");

// 21:00 local on each of three consecutive days spanning each transition.
// Hardcoded as UTC instants derived from the rule (MDT = UTC-6, MST = UTC-7)
// so the expectation does not come from the same Intl call under test.
const FALL = [
  { utc: "2026-11-01T03:00:00Z", denver: "2026-10-31" }, // MDT, day before
  { utc: "2026-11-02T04:00:00Z", denver: "2026-11-01" }, // MST, the 25-hour day
  { utc: "2026-11-03T04:00:00Z", denver: "2026-11-02" }, // MST, day after
];
const SPRING = [
  { utc: "2026-03-08T04:00:00Z", denver: "2026-03-07" }, // MST, day before
  { utc: "2026-03-09T03:00:00Z", denver: "2026-03-08" }, // MDT, the 23-hour day
  { utc: "2026-03-10T03:00:00Z", denver: "2026-03-09" }, // MDT, day after
];

for (const [label, set] of [["fall back", FALL], ["spring forward", SPRING]] as const) {
  for (const { utc, denver } of set) {
    const ts = Math.floor(new Date(utc).getTime() / 1000);
    assert(dayKey(ts, TZ) === denver, `${label}: ${utc} is ${denver} in Denver`);
  }
  // 🔴 The falsification: the naive buckets must DISAGREE, or this section
  // would pass against the bug it exists to prevent.
  const naiveUtcDays = set.map(({ utc }) => new Date(utc).toISOString().slice(0, 10));
  assert(
    naiveUtcDays.some((d, i) => d !== set[i].denver),
    `${label}: 🔴 UTC bucketing lands on a different day (the bug this pins)`,
  );

  // And the streak must read three consecutive days across the transition.
  const events = set.map(({ utc }, i) =>
    ev("dst-doc", 0.1 * (i + 1), 0.1, Math.floor(new Date(utc).getTime() / 1000)),
  );
  const now = Math.floor(new Date(set[2].utc).getTime() / 1000) + 3600;
  const stats = computeReadingStats({
    events,
    books: [BOOK("dst-doc", 100_000)],
    now,
    timeZone: TZ,
  });
  assert(stats.streak.current === 3, `${label}: streak counts 3 consecutive days across it`);
  assert(stats.totals.daysRead === 3, `${label}: three distinct reading days, not two or four`);
}

// 🔴 The concrete damage naive bucketing does, stated as the number a reader
// would actually see. An afternoon and an evening session on ONE Denver day
// straddle UTC midnight, so any UTC-based bucket counts them as two reading
// days — silently inflating both the streak and the heatmap for anyone who
// reads at night, which is most people.
for (const [label, afternoon, evening, denverDay] of [
  ["fall back", "2026-11-01T20:00:00Z", "2026-11-02T04:00:00Z", "2026-11-01"],
  ["spring forward", "2026-03-08T20:00:00Z", "2026-03-09T03:00:00Z", "2026-03-08"],
  ["an ordinary day", "2026-08-12T20:00:00Z", "2026-08-13T04:00:00Z", "2026-08-12"],
] as const) {
  const a = Math.floor(new Date(afternoon).getTime() / 1000);
  const b = Math.floor(new Date(evening).getTime() / 1000);
  assert(
    dayKey(a, TZ) === denverDay && dayKey(b, TZ) === denverDay,
    `${label}: an afternoon and an evening sync are ONE Denver day (${denverDay})`,
  );
  assert(
    afternoon.slice(0, 10) !== evening.slice(0, 10),
    `${label}: 🔴 …while UTC splits them across two days`,
  );
  const stats = computeReadingStats({
    events: [ev("straddle", 0.1, 0.1, a), ev("straddle", 0.2, 0.1, b)],
    books: [BOOK("straddle", 100_000)],
    now: b + 3600,
    timeZone: TZ,
  });
  assert(
    stats.totals.daysRead === 1 && stats.streak.current === 1,
    `${label}: 🔴 …and the streak counts 1 day, not 2`,
  );
}

// Civil-date arithmetic must not meet an offset.
assert(addDays("2026-11-01", -1) === "2026-10-31", "addDays crosses the 25-hour day");
assert(addDays("2026-03-08", -1) === "2026-03-07", "addDays crosses the 23-hour day");
assert(daysBetween("2026-10-31", "2026-11-02") === 2, "daysBetween spans the transition");
assert(addDays("2026-12-31", 1) === "2027-01-01", "addDays crosses a year boundary");
assert(addDays("2028-02-28", 1) === "2028-02-29", "addDays knows 2028 is a leap year");

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── pages, end to end, against the verified word count ──");
// ═══════════════════════════════════════════════════════════════════════════
// 180,000 words ÷ 250 = 720 pages. A quarter of the book is 180 pages. The
// denominator is the Python-verified number above, so this is arithmetic on
// an externally-anchored fact, not on itself.
{
  const t = Math.floor(new Date("2026-08-10T21:00:00Z").getTime() / 1000);
  const stats = computeReadingStats({
    events: [ev("h", 0.0, 0, t, { kind: "baseline" }), ev("h", 0.25, 0.25, t + 3600)],
    books: [BOOK("h", expected.text.words)],
    now: t + 7200,
    timeZone: TZ,
  });
  assert(stats.totals.pages === 180, `25% of a 180,000-word book is 180 pages (got ${stats.totals.pages})`);
  assert(
    stats.nowReading[0].pagesLeft === 540,
    `540 pages left of 720 (got ${stats.nowReading[0].pagesLeft})`,
  );
  assert(stats.totals.words === 45_000, "45,000 words read");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── the streak tells the truth ──");
// ═══════════════════════════════════════════════════════════════════════════
{
  const base = Math.floor(new Date("2026-08-10T21:00:00Z").getTime() / 1000);
  const day = 86400;
  // Read on days 0,1,2 then skip day 3, read day 4 and 5. "Now" is day 5.
  const events = [0, 1, 2, 4, 5].map((d, i) => ev("s", 0.1 * (i + 1), 0.1, base + d * day));
  const stats = computeReadingStats({
    events,
    books: [BOOK("s", 100_000)],
    now: base + 5 * day + 3600,
    timeZone: TZ,
  });
  assert(stats.streak.current === 2, "a missed day breaks the streak (2, not 5)");
  assert(stats.streak.longest === 3, "the longest run is remembered (3)");
  assert(stats.streak.bankedToday, "today counts as banked once it has a sync");

  // 🔴 The morning case. At 8am with no reading yet, a streak of 12 must not
  // read as 0 — it is alive until a whole day is missed, and this is exactly
  // the moment the number is supposed to motivate.
  const morning = computeReadingStats({
    events,
    books: [BOOK("s", 100_000)],
    now: base + 6 * day + 3600, // the next day, nothing read yet
    timeZone: TZ,
  });
  assert(morning.streak.current === 2, "🔴 the streak survives the morning of an unread day");
  assert(!morning.streak.bankedToday && morning.streak.atRisk, "…and is flagged at risk");

  // But a full missed day does end it.
  const missed = computeReadingStats({
    events,
    books: [BOOK("s", 100_000)],
    now: base + 7 * day + 3600,
    timeZone: TZ,
  });
  assert(missed.streak.current === 0, "a whole missed day ends the streak");
  assert(missed.streak.longest === 3, "…without forgetting the record");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── what must never inflate a statistic ──");
// ═══════════════════════════════════════════════════════════════════════════
{
  const t = Math.floor(new Date("2026-08-10T21:00:00Z").getTime() / 1000);

  // A baseline is the device announcing where it already is. Crediting it
  // would book the entire pre-history of a migrated library to one afternoon.
  const baselineOnly = computeReadingStats({
    events: [ev("b", 0.43, 0, t, { kind: "baseline" })],
    books: [BOOK("b", 100_000)],
    now: t + 60,
    timeZone: TZ,
  });
  assert(baselineOnly.totals.pages === 0, "🔴 a first-sync baseline at 43% credits 0 pages");
  assert(baselineOnly.streak.current === 0, "🔴 …and does not light up the streak");
  assert(
    baselineOnly.nowReading[0]?.percentage === 0.43,
    "…but the position still shows in Now Reading",
  );

  // Going backwards is real, and must not net out a day of reading.
  const backwards = computeReadingStats({
    events: [
      ev("r", 0.5, 0, t, { kind: "baseline" }),
      ev("r", 0.6, 0.1, t + 600),
      ev("r", 0.4, -0.2, t + 1200),
    ],
    books: [BOOK("r", 100_000)],
    now: t + 1800,
    timeZone: TZ,
  });
  assert(
    backwards.totals.pages === 40,
    `🔴 backwards movement never subtracts (10% of 100k = 40 pages, got ${backwards.totals.pages})`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── finishing is a crossing, not a state ──");
// ═══════════════════════════════════════════════════════════════════════════
{
  const t = Math.floor(new Date("2026-08-10T21:00:00Z").getTime() / 1000);
  // A device that keeps checking in at 99% must not finish the book each time.
  const idleAtEnd = computeReadingStats({
    events: [
      ev("f", 0.5, 0, t, { kind: "baseline" }),
      ev("f", 0.99, 0.49, t + 600),
      ev("f", 0.995, 0.005, t + 1200),
      ev("f", 1.0, 0.005, t + 1800),
    ],
    books: [BOOK("f", 100_000)],
    now: t + 3600,
    timeZone: TZ,
  });
  assert(
    idleAtEnd.totals.booksFinished === 1,
    `🔴 syncing repeatedly past the end finishes a book ONCE (got ${idleAtEnd.totals.booksFinished})`,
  );
  assert(idleAtEnd.nowReading.length === 0, "a finished book leaves Now Reading");

  // A genuine re-read finishes it again.
  const reread = computeReadingStats({
    events: [
      ev("f", 0.5, 0, t, { kind: "baseline" }),
      ev("f", 0.99, 0.49, t + 600),
      ev("f", 0.02, -0.97, t + 86400),
      ev("f", 0.99, 0.97, t + 172800),
    ],
    books: [BOOK("f", 100_000)],
    now: t + 180000,
    timeZone: TZ,
  });
  assert(reread.totals.booksFinished === 2, "a re-read to the end finishes it a second time");

  assert(FINISH_THRESHOLD < 1, "the finish threshold is under 100% (readers stop short of 1.0)");
  const stopsShort = computeReadingStats({
    events: [ev("g", 0.1, 0, t, { kind: "baseline" }), ev("g", 0.98, 0.88, t + 600)],
    books: [BOOK("g", 100_000)],
    now: t + 3600,
    timeZone: TZ,
  });
  assert(stopsShort.totals.booksFinished === 1, "98% counts as finished");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── a projection refuses thin evidence ──");
// ═══════════════════════════════════════════════════════════════════════════
{
  const t = Math.floor(new Date("2026-08-10T21:00:00Z").getTime() / 1000);
  const day = 86400;
  const thin = computeReadingStats({
    events: [ev("p", 0.1, 0, t, { kind: "baseline" }), ev("p", 0.2, 0.1, t + day)],
    books: [BOOK("p", 100_000)],
    now: t + day + 3600,
    timeZone: TZ,
  });
  assert(
    thin.nowReading[0].pace === null && thin.nowReading[0].daysToFinish === null,
    "🔴 one reading day forecasts nothing rather than a confident wrong date",
  );

  const solid = computeReadingStats({
    events: [
      ev("p", 0.0, 0, t, { kind: "baseline" }),
      ev("p", 0.1, 0.1, t + day),
      ev("p", 0.2, 0.1, t + 2 * day),
      ev("p", 0.3, 0.1, t + 3 * day),
    ],
    books: [BOOK("p", 100_000)],
    now: t + 3 * day + 3600,
    timeZone: TZ,
  });
  assert(
    solid.nowReading[0].pace != null && solid.nowReading[0].daysToFinish != null,
    "three reading days is enough to forecast",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 🔴 the position is the product; statistics are decoration ──");
// ═══════════════════════════════════════════════════════════════════════════
// Everything above is a number on a page. This is the reader's place in a
// book, on a device, with no other copy.

createUser("keith", createHash("md5").update("pw").digest("hex"));
const { book } = ingestBook(fixtureBytes, "The Fixture Book.epub");
const doc = book.partialMd5;

assert(
  book.wordCount === expected.text.words,
  "ingest measures and stores the word count (no backfill needed for new books)",
);
assert(book.sha256 === expected.sha256, "🔴 ingest still stores the exact bytes");
assert(book.partialMd5 === expected.partial_md5, "🔴 …and the sync key is unchanged");

const fileBefore = sha256(fs.readFileSync(bookFilePath(book)));

// An idle device re-syncing the same position, twenty times over.
putProgress("keith", { document: doc, progress: "/body/DocFragment[3]/p[1]", percentage: 0.1, device: "CrossPoint" });
const afterFirst = readingEventCount();

// 🔴 The stored baseline row itself, asserted at the DB rather than through
// the model. computeReadingStats filters baselines out today, so a recorder
// that wrote a real delta here would change no number on the page — until
// some later query sums delta directly and quietly credits the reader with
// every book's entire pre-history. Pin the row, not just today's reading of it.
{
  const first = listReadingEvents("keith")[0];
  assert(first.kind === "baseline", "the first sync of a document is recorded as a baseline");
  assert(
    first.delta === 0,
    `🔴 a baseline's stored delta is 0, whatever position it arrived at (got ${first.delta})`,
  );
  assert(first.percentage === 0.1, "…while its position is recorded faithfully");
}
for (let i = 0; i < 20; i++) {
  putProgress("keith", { document: doc, progress: "/body/DocFragment[3]/p[1]", percentage: 0.1, device: "CrossPoint" });
}
assert(
  readingEventCount() === afterFirst,
  `🔴 twenty identical re-syncs record nothing (KOReader polls; that is not reading)`,
);
{
  const s = getReadingStats(Math.floor(Date.now() / 1000));
  assert(s.totals.pages === 0, "🔴 …and add zero pages");
  assert(s.streak.current === 0, "🔴 …and do not light up the streak calendar");
}

// Real movement does record.
putProgress("keith", { document: doc, progress: "/body/DocFragment[9]/p[2]", percentage: 0.35, device: "CrossPoint" });
assert(readingEventCount() === afterFirst + 1, "a real page turn records exactly one event");
{
  const s = getReadingStats(Math.floor(Date.now() / 1000));
  const pages = Math.round((0.25 * expected.text.words) / PAGE_WORDS);
  assert(s.totals.pages === pages, `0.10 → 0.35 of the fixture is ${pages} pages`);
  assert(s.streak.current === 1, "…and banks today");
  assert(s.nowReading.length === 1 && s.nowReading[0].book?.id === book.id, "the book joins to the catalog");
}

// A page turn on a long chapter: the x-pointer moves while the rounded
// percentage does not. That is activity worth a day, and zero pages.
const beforeSamePct = readingEventCount();
putProgress("keith", { document: doc, progress: "/body/DocFragment[9]/p[77]", percentage: 0.35, device: "CrossPoint" });
assert(
  readingEventCount() === beforeSamePct + 1,
  "a moved x-pointer at an unchanged percentage still counts as activity",
);

assert(
  sha256(fs.readFileSync(bookFilePath(book))) === fileBefore,
  "🔴 none of this touched the stored epub",
);
assert(getBook(book.id)!.partialMd5 === expected.partial_md5, "🔴 …or the sync key");

// 🔴 The load-bearing one. Statistics are wired into the sync write path, so
// they are one exception away from costing a reading position. Pull the table
// out from under it and the PUT must still store and return the position.
getDb().exec(`DROP TABLE reading_events`);
const survived = putProgress("keith", {
  document: doc,
  progress: "/body/DocFragment[12]/p[3]",
  percentage: 0.62,
  device: "Readest",
});
const readBack = getProgress("keith", doc);
assert(readBack?.progress === "/body/DocFragment[12]/p[3]", "🔴 the position stores with the history table GONE");
assert(readBack?.percentage === 0.62, "🔴 …with the right percentage");
assert(survived.timestamp > 0, "🔴 …and the endpoint returns a normal result");

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncheck:books:stats FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:stats OK");
