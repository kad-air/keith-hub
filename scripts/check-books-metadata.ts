#!/usr/bin/env node
//
// 🔴 THE "METADATA IS COSMETIC" GATE.
//
//   npm run check:books:metadata   (standalone)
//   npm run build                  (via prebuild)
//
// One property, asserted on every build:
//
//   a metadata edit can never change the stored file, its sha256, or its
//   partial_md5 — so the worst case of a bad edit is a wrong series number,
//   never a book that silently stops syncing on every device at once.
//
// This is what makes the /books edit UI safe to use freely: title, author,
// series and description are database columns, while reading-progress sync
// (KOReader/kosync on the X3 and Readest) identifies a book by a hash of its
// BYTES. The two cannot interfere — which is why editing a book you're
// currently reading can't lose your place.
//
// True by construction today (BookEdit can't express those fields), but a
// later refactor that re-serialised the epub on save — writing metadata back
// into the OPF, say, which is a completely reasonable-sounding feature —
// would silently detach every device's progress. That failure has no error
// surface, so it gets a gate rather than a comment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixtureBytes = fs.readFileSync(path.resolve(repoRoot, "books-fixture/fixture.epub"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-meta-check-"));
process.chdir(tmp);

const { ingestBook, updateBook, bookFilePath } = await import("../lib/books/store.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

console.log("check:books:metadata — metadata edits are cosmetic\n");

const { book } = ingestBook(fixtureBytes, "The Fixture Book.epub");
const fileBefore = sha256(fs.readFileSync(bookFilePath(book)));
const mtimeBefore = fs.statSync(bookFilePath(book)).mtimeMs;

const edited = updateBook(book.id, {
  title: "A Completely Different Title",
  author: "Someone Else Entirely",
  series: "Another Series",
  seriesIndex: 99,
  description: "Rewritten description.",
  language: "fr",
})!;

assert(edited.title === "A Completely Different Title", "the edit actually applied");
assert(
  sha256(fs.readFileSync(bookFilePath(book))) === fileBefore,
  "🔴 the stored epub is byte-identical after a metadata edit",
);
assert(fs.statSync(bookFilePath(book)).mtimeMs === mtimeBefore, "the file was not even rewritten");
assert(edited.sha256 === book.sha256, "🔴 books.sha256 unchanged");
assert(edited.partialMd5 === book.partialMd5, "🔴 books.partial_md5 (the sync key) unchanged");
assert(edited.fileSize === book.fileSize, "books.file_size unchanged");
assert(edited.fileName === book.fileName, "books.file_name unchanged");

// An edit payload that names the protected fields must not land them.
const smuggled = updateBook(book.id, {
  title: "Another Title",
  // @ts-expect-error — deliberately outside BookEdit; must be ignored
  sha256: "0".repeat(64),
  partialMd5: "1".repeat(32),
})!;
assert(
  smuggled.sha256 === book.sha256 && smuggled.partialMd5 === book.partialMd5,
  "🔴 an edit payload naming sha256/partial_md5 cannot change them",
);

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncheck:books:metadata FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:metadata OK");
