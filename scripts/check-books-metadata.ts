#!/usr/bin/env node
//
// 🔴 THE "METADATA IS COSMETIC" GATE.
//
//   npm run check:books:metadata   (standalone)
//   npm run build                  (via prebuild)
//
// Exists because an AGENT now writes metadata (the MCP books tools). The whole
// safety argument for letting it do that is one property:
//
//   a metadata edit can never change the stored file, its sha256, or its
//   partial_md5 — so the worst case is a wrong series number, never a book
//   that silently stops syncing on every device at once.
//
// That is currently true by construction (BookEdit can't express those
// fields). Once something automated is writing here, "true by construction"
// needs to be "asserted on every build" — a later refactor that let an edit
// re-serialize the epub would otherwise be invisible until reading positions
// started vanishing.
//
// Also pins the quality heuristics against hand-labelled cases, so the
// needs-attention surface can't silently start flagging everything (noise an
// agent would dutifully act on) or nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixtureBytes = fs.readFileSync(path.resolve(repoRoot, "books-fixture/fixture.epub"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-meta-check-"));
process.chdir(tmp);

const { ingestBook, updateBook, getBook, bookFilePath } = await import("../lib/books/store.ts");
const { metadataIssues, needsAttention } = await import("../lib/books/quality.ts");

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

// ── the load-bearing property ──────────────────────────────────────────────
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

// An edit that tries to smuggle in the protected fields must not land them.
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

// ── the quality heuristics, hand-labelled ──────────────────────────────────
const base = getBook(book.id)!;
const withMeta = (o: Partial<typeof base>) => ({ ...base, ...o });

assert(
  metadataIssues(withMeta({ author: "Pratchett, Terry" })).includes("author_unflipped"),
  'flags "Last, First" authors',
);
assert(
  !metadataIssues(withMeta({ author: "Terry Pratchett" })).includes("author_unflipped"),
  "does not flag a normal author",
);
assert(
  metadataIssues(withMeta({ author: null })).includes("no_author"),
  "flags a missing author",
);
assert(
  metadataIssues(withMeta({ title: "Mort (z-lib.org).epub" })).includes(
    "title_looks_like_filename",
  ),
  "flags a filename-shaped title",
);
assert(
  !metadataIssues(withMeta({ title: "The Ladies of Grace Adieu" })).includes(
    "title_looks_like_filename",
  ),
  "does not flag a normal title",
);
assert(
  metadataIssues(withMeta({ title: "Discworld Book 15", series: null, seriesIndex: null })).includes(
    "series_number_stranded_in_title",
  ),
  "flags a volume number stranded in the title",
);
assert(
  metadataIssues(withMeta({ series: "Discworld", seriesIndex: null })).includes(
    "series_without_index",
  ),
  "flags a series with no position",
);
assert(
  metadataIssues(withMeta({ series: null, seriesIndex: 3 })).includes("index_without_series"),
  "flags a position with no series",
);

// The precision guard: a fully clean book must be silent, or the agent gets a
// list of everything and treats noise as signal.
const clean = withMeta({
  title: "The Ladies of Grace Adieu",
  author: "Susanna Clarke",
  series: null,
  seriesIndex: null,
  description: "Short stories.",
  language: "en",
});
assert(metadataIssues(clean).length === 0, "a clean book has NO issues at all");
assert(!needsAttention(clean), "a clean book does not need attention");
// A missing description alone is cosmetic — it must not drag a book into the
// needs-attention list (8 of 13 real books have none).
assert(
  !needsAttention({ ...clean, description: null }),
  "a missing description alone does not trigger needs-attention",
);
assert(needsAttention({ ...clean, author: null }), "a missing author does trigger it");

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncheck:books:metadata FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:metadata OK");
