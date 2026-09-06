#!/usr/bin/env node
//
// Regenerates books-fixture/language-samples.json — the real-prose anchor for
// check:books:health's language check.
//
//   node scripts/gen-language-samples.mjs
//
// 🔴 WHY THIS EXISTS AT ALL: lib/books/language.ts decides a book's language
// from function-word frequency, and a check that fed it text assembled from
// those same word lists would be verifying itself. The anchor has to be prose
// nobody here wrote, labelled by somebody who is not this codebase.
//
// So: real books from Project Gutenberg, and the LABEL is Gutenberg's own
// "Language:" catalogue header — not a judgment made here, and not derived
// from the detector under test. The passage is taken from the MIDDLE of each
// book (front matter is prefaces, transcriber notes and, in Gutenberg's case,
// English licence boilerplate at both ends, so a French book's opening pages
// are not reliably French).
//
// Madame Bovary is present twice on purpose — 14155 is Flaubert's French,
// 2413 is an English translation of the SAME NOVEL. Same author, same plot,
// same register: the only thing separating them is the language, which is the
// one thing the detector claims to measure.
//
// Network is needed to REGENERATE. The gate reads the committed JSON and
// never touches the network.
import fs from "node:fs";
import path from "node:path";

// id → what we expect Gutenberg to say. The script FAILS if the fetched
// header disagrees, rather than recording whatever it found: a silently
// re-catalogued or replaced text must not quietly redefine the ground truth.
const BOOKS = [
  { id: 11, language: "English" },
  { id: 1342, language: "English" },
  { id: 2413, language: "English" }, // Madame Bovary, translated
  { id: 14155, language: "French" }, // Madame Bovary, original
  { id: 17489, language: "French" },
  { id: 22367, language: "German" },
  { id: 2000, language: "Spanish" },
  { id: 1012, language: "Italian" },
  { id: 55752, language: "Portuguese" },
  { id: 11024, language: "Dutch" },
  // Cyrillic: the script branch of the detector, which decides a book is
  // not English from its ALPHABET before any function word is counted.
  { id: 30774, language: "Russian", script: "Cyrillic" },
];

const SAMPLE_WORDS = 800;
const OUT = path.resolve(import.meta.dirname, "../books-fixture/language-samples.json");

function header(text, field) {
  const m = text.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
}

/** Gutenberg wraps every text in English licence boilerplate. */
function stripBoilerplate(text) {
  const start = text.match(/\*\*\*\s*START OF TH[EIS]+ PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  const end = text.match(/\*\*\*\s*END OF TH[EIS]+ PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  const from = start ? start.index + start[0].length : 0;
  const to = end ? end.index : text.length;
  return text.slice(from, to);
}

const samples = [];
for (const book of BOOKS) {
  // Two URL shapes: most texts are under cache/epub, but some (notably the
  // non-Latin ones) only have the ebooks/<id>.txt.utf-8 form.
  const urls = [
    `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.txt`,
    `https://www.gutenberg.org/ebooks/${book.id}.txt.utf-8`,
  ];
  process.stdout.write(`fetching ${book.id}… `);
  let raw = null;
  for (const url of urls) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) continue;
    const body = await res.text();
    if (/^Language:/im.test(body)) {
      raw = body;
      break;
    }
  }
  if (raw == null) throw new Error(`${book.id}: no plain-text edition found`);

  const language = header(raw, "Language");
  const title = header(raw, "Title");
  if (language !== book.language) {
    throw new Error(
      `${book.id}: Gutenberg says Language: ${language}, this script expected ${book.language}. ` +
        `Verify the text before changing the expectation — the label is the ground truth.`,
    );
  }

  const body = stripBoilerplate(raw);
  const words = body.split(/\s+/).filter(Boolean);
  // Middle of the book: past prefaces and tables of contents, short of the
  // trailing matter.
  const start = Math.floor(words.length * 0.45);
  const text = words.slice(start, start + SAMPLE_WORDS).join(" ");
  samples.push({
    id: book.id,
    title,
    language,
    script: book.script ?? "Latin",
    words: SAMPLE_WORDS,
    text,
  });
  console.log(`${title} — ${language}`);
}

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      note:
        "Real prose from Project Gutenberg. `language` is Gutenberg's own catalogue header, " +
        "NOT a judgment of this codebase and not derived from lib/books/language.ts. " +
        "Regenerate with scripts/gen-language-samples.mjs.",
      generator: "scripts/gen-language-samples.mjs",
      source: "https://www.gutenberg.org/",
      samples,
    },
    null,
    2,
  ) + "\n",
);
console.log(`\nwrote ${OUT} — ${samples.length} samples`);
