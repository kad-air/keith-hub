#!/usr/bin/env node
//
// 🔴 THE BYTE-IDENTITY GATE (BOOKS_PLAN §4 / §10).
//
//   npm run check:books:bytes      (standalone)
//   npm run build                  (via prebuild)
//
// The kosync document key is a partial MD5 of the FILE BYTES, computed
// independently by every device. If ingest or storage ever perturbs a single
// byte, the X3 and Readest land on different keys and progress silently stops
// syncing — no error surface, ever. This gate pins that invariant:
//
//   1. Our partialMd5 matches a reference digest computed OFFLINE by a
//      different implementation (the deployment plan's Python, itself verified
//      13/13 against Stump's Rust hashes, which CrossPoint's C++ matched in
//      production). Committed in books-fixture/expected.json — never
//      regenerated from the TS side.
//   2. Ingest stores the bytes UNTOUCHED: the file on disk after ingest is
//      sha256-identical to the input, and the DB row records the same hashes.
//   3. Re-ingesting the same bytes dedupes to the same row (same progress
//      identity) instead of forking a second one.
//   4. Metadata lands normalized ("Fixture, Frances" flips to
//      "Frances Fixture"; Calibre series pair extracted; cover written).
//
// Hermetic: chdir into a fresh temp dir BEFORE the first getDb() call, so the
// gate exercises the real store against a throwaway DB + volume layout and
// never touches data/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixturePath = path.resolve(repoRoot, "books-fixture/fixture.epub");
const expected = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, "books-fixture/expected.json"), "utf8"),
);
const fixtureBytes = fs.readFileSync(fixturePath);

// Hermetic cwd BEFORE importing the store (lib/db.ts resolves data/ off cwd
// at first getDb()).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-check-"));
process.chdir(tmp);

const { partialMd5 } = await import("../lib/books/partialMd5.ts");
const { ingestBook, getBook, bookFilePath, bookCoverPath } = await import(
  "../lib/books/store.ts"
);

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

console.log("check:books:bytes — the byte-identity gate\n");

// 1. The cross-implementation hash pin.
assert(fixtureBytes.length === expected.size, `fixture is ${expected.size} bytes`);
assert(
  sha256(fixtureBytes) === expected.sha256,
  "fixture bytes match the committed sha256 (fixture itself uncorrupted)",
);
assert(
  partialMd5(fixtureBytes) === expected.partial_md5,
  "partialMd5 matches the OFFLINE Python reference digest",
);

// 2. Ingest stores bytes untouched.
const { book, created } = ingestBook(fixtureBytes, "99 - The Fixture Book.epub");
assert(created, "first ingest creates a row");
const stored = fs.readFileSync(bookFilePath(book));
assert(sha256(stored) === expected.sha256, "stored file is byte-identical to the input");
assert(book.sha256 === expected.sha256, "DB row records the true sha256");
assert(book.partialMd5 === expected.partial_md5, "DB row records the true partial_md5");
assert(book.fileSize === expected.size, "DB row records the true size");

// 3. Content-addressed dedupe.
const again = ingestBook(fixtureBytes, "renamed-differently.epub");
assert(!again.created, "same bytes re-ingested dedupe instead of forking");
assert(again.book.id === book.id, "dedupe returns the SAME row (same progress identity)");

// 4. Metadata normalization.
assert(book.title === expected.meta.title, `title extracted ("${book.title}")`);
assert(
  book.author === expected.meta.author,
  `author flipped Last,First → First Last ("${book.author}")`,
);
assert(book.series === expected.meta.series, `series extracted ("${book.series}")`);
assert(book.seriesIndex === expected.meta.series_index, "series index extracted");
assert(book.language === expected.meta.language, "language extracted");
assert(book.coverName === `cover.${expected.meta.cover_ext}`, "cover written");
assert(
  book.coverName != null && fs.existsSync(bookCoverPath({ id: book.id, coverName: book.coverName })),
  "cover file exists on disk",
);
assert(getBook(book.id) != null, "row readable back");

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncheck:books:bytes FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:bytes OK");
