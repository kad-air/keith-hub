// Dev-only: ingest every epub under a dir DIRECTLY (no HTTP) into the local
// data/ DB — the fast path for local testing. Production uses push-books.mjs
// against the upload API instead.
//   node scripts/dev-ingest-books.mjs [dir]
import fs from "node:fs";
import path from "node:path";
import { ingestBook, listBooks } from "../lib/books/store.ts";

const dir = process.argv[2] || "/Volumes/HDD/Books";
function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.toLowerCase().endsWith(".epub")) yield p;
  }
}

for (const p of walk(dir)) {
  const { book, created } = ingestBook(fs.readFileSync(p), path.basename(p));
  console.log(`${created ? "＋" : "＝"} ${book.author ?? "?"} — ${book.title}` +
    (book.series ? ` [${book.series} #${book.seriesIndex}]` : ""));
}
console.log(`\ncatalog: ${listBooks().length} books`);
