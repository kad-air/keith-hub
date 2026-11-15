#!/usr/bin/env node
//
// 🔴 THE ASK GATE: the model sees the book up to the synced position and
// nothing after it.
//
//   npm run check:books:ask   (standalone)
//   npm run build             (via prebuild)
//
// lib/books/ask.ts cuts the book's text for "ask about what you've read". A
// wrong cut has no error surface — the answer just knows something the reader
// doesn't yet — so it gets a gate.
//
//  1. THE CUT, word for word. The expected text is rebuilt here from the
//     parsed blocks (every word, in order) and readSoFar(cutoff) must be
//     EXACTLY its first `cutoff` words: none missing, none extra, none past.
//     Swept over every cutoff of a small built book, and over sampled cutoffs
//     of a real one (sheafs-alice.epub) and the 180k-word fixture.
//  2. FROM A SYNCED POINTER. A device pointer resolved by the real
//     resolvePosition, then cut: the paragraph it names and everything after
//     it are absent; the paragraph before it is present.
//  3. CHUNKS. Boundaries depend on the book alone, so an advancing position
//     leaves every full chunk byte-identical (the prompt cache depends on it).
//  4. THE ROUTE takes its text from readSoFar and nowhere else, cut at the
//     resolved position, and refuses without a key or a synced position.
//
// What this cannot see: what the model already knows about a famous book. The
// cut controls the request, not the training data; the prompt asks, the UI
// says so.

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixture = (name: string) => fs.readFileSync(path.resolve(repoRoot, "books-fixture", name));
const source = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), "utf8");

const { parseBook, resolvePosition } = await import("../lib/books/pageText.ts");
const { readSoFar, parseHistory, CHUNK_WORDS, MAX_HISTORY_TURNS } = await import("../lib/books/ask.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

type Book = NonNullable<ReturnType<typeof parseBook>>;

/** Every word of the book in order, straight off the blocks. */
function allWords(book: Book): string[] {
  const out: string[] = [];
  for (const b of book.blocks) for (const [s, e] of b.words) out.push(b.text.slice(s, e));
  return out;
}
/** The words the model would be sent ("##" is the heading marker, not a word of the book). */
const sentWords = (chunks: string[]) => chunks.join("\n\n").split(/\s+/).filter((w) => w && w !== "##");

function cutIsExact(book: Book, words: string[], cutoff: number): boolean {
  const r = readSoFar(book, cutoff);
  const sent = sentWords(r.chunks);
  const want = Math.min(Math.max(0, cutoff), words.length);
  if (r.words !== want || sent.length !== want) return false;
  for (let i = 0; i < want; i++) if (sent[i] !== words[i]) return false;
  return true;
}

function buildEpub(chapters: string[]): Buffer {
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`));
  const items = chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
  const refs = chapters.map((_, i) => `<itemref idref="c${i}"/>`);
  zip.addFile("content.opf", Buffer.from(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Ask Check</dc:title><dc:identifier id="id">ask</dc:identifier></metadata>
  <manifest>${items.join("")}</manifest><spine>${refs.join("")}</spine>
</package>`));
  chapters.forEach((body, i) =>
    zip.addFile(`c${i}.xhtml`, Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`)),
  );
  return zip.toBuffer();
}

console.log("check:books:ask — only what has been read\n");

// ---------------------------------------------------------------------------
// 1. The cut, word for word
// ---------------------------------------------------------------------------
console.log("the cut:");
{
  // Every word unique, so a word from past the cutoff cannot hide as a repeat.
  let n = 0;
  const w = (count: number) => Array.from({ length: count }, () => `w${n++}`).join(" ");
  const built = parseBook(
    buildEpub([
      `<h1>${w(3)}</h1><p>${w(40)}</p><div>${w(5)}<p>${w(12)} <em>${w(3)}</em> ${w(4)}</p>${w(6)}</div>`,
      `<h2>${w(2)}</h2><p>${w(30)}<br/>${w(10)}</p><ul><li>${w(4)}</li><li>${w(4)}</li></ul>`,
      `<p>${w(25)}</p><p>THE-BUTLER-DID-IT ${w(8)}</p>`,
    ]),
  )!;
  const words = allWords(built);
  assert(words.length === n + 1 && built.totalWords === words.length, `built book: ${words.length} distinct words`);
  let wrong = 0;
  for (let c = -2; c <= words.length + 3; c++) if (!cutIsExact(built, words, c)) wrong++;
  assert(wrong === 0, `🔴 every cutoff from before the start to past the end is exact (${wrong} wrong)`);

  const spoilerAt = words.indexOf("THE-BUTLER-DID-IT");
  assert(
    !readSoFar(built, spoilerAt).chunks.join(" ").includes("BUTLER"),
    "🔴 the word AT the position is withheld, not just the ones after it",
  );
  assert(readSoFar(built, spoilerAt + 1).chunks.join(" ").includes("THE-BUTLER-DID-IT"), "…and appears once the position passes it");
  assert(readSoFar(built, 0).chunks.length === 0 && readSoFar(built, NaN).chunks.length === 0, "nothing read → nothing sent");
  assert(readSoFar(built, 10).chunks[0].startsWith("## w0 w1 w2\n\nw3 "), "headings are marked, paragraphs separated");
}
for (const name of ["sheafs-alice.epub", "fixture.epub"]) {
  const book = parseBook(fixture(name))!;
  const words = allWords(book);
  const cuts = [1, 2, 777, CHUNK_WORDS - 1, CHUNK_WORDS, CHUNK_WORDS + 1, Math.floor(words.length / 2), words.length - 1, words.length];
  for (let i = 1; i < 12; i++) cuts.push(Math.floor((words.length * i) / 12) + i);
  const wrong = cuts.filter((c) => !cutIsExact(book, words, c)).length;
  assert(words.length > CHUNK_WORDS, `${name}: ${words.length.toLocaleString()} words, more than one chunk`);
  assert(wrong === 0, `🔴 ${name}: ${cuts.length} sampled cutoffs exact (${wrong} wrong)`);
}

// ---------------------------------------------------------------------------
// 2. From a synced pointer
// ---------------------------------------------------------------------------
console.log("\nfrom a device pointer:");
{
  const book = parseBook(fixture("sheafs-alice.epub"))!;
  const ref = JSON.parse(fixture("sheafs-alice-reference.json").toString("utf8"));
  const squash = (s: string) => s.replace(/\s+/g, "");
  let checked = 0;
  let leaked = 0;
  let missing = 0;
  for (const doc of ref.documents) {
    for (const sample of doc.samples) {
      if (!sample.text) continue;
      const r = resolvePosition(book, `/body/DocFragment[${doc.spineIndex + 1}]${sample.path}/text().0`, 0.5);
      const at = book.blocks.findIndex((b) => b.wordStart === r.word && b.words.length > 0);
      if (at < 0 || squash(book.blocks[at].text) !== squash(sample.text)) continue;
      const sent = readSoFar(book, r.word);
      if (sentWords(sent.chunks).length !== r.word) leaked++;
      // The paragraph just before the position is the last thing sent.
      let prev = at - 1;
      while (prev >= 0 && book.blocks[prev].words.length === 0) prev--;
      if (prev >= 0 && !squash(sent.chunks.join("\n\n")).endsWith(squash(book.blocks[prev].text))) missing++;
      checked++;
    }
  }
  assert(checked >= 30, `${checked} real pointers resolved and cut`);
  assert(leaked === 0, `🔴 none sends a word at or past its paragraph (${leaked} did)`);
  assert(missing === 0, `each ends on the paragraph before the position (${missing} did not)`);
}

// ---------------------------------------------------------------------------
// 3. Chunks
// ---------------------------------------------------------------------------
console.log("\nchunks:");
{
  const book = parseBook(fixture("fixture.epub"))!;
  const a = readSoFar(book, CHUNK_WORDS * 3 + 500);
  const b = readSoFar(book, CHUNK_WORDS * 5 + 9000);
  assert(a.chunks.length === 4 && b.chunks.length === 6, "a full chunk every CHUNK_WORDS words, then the tail");
  assert(
    a.chunks.slice(0, 3).every((c, i) => c === b.chunks[i]),
    "🔴 reading further leaves every full chunk byte-identical",
  );
  assert(b.chunks[3].startsWith(a.chunks[3]), "…and only extends the tail");
  const full = readSoFar(book, CHUNK_WORDS * 2);
  assert(
    full.chunks.length === 2 && full.chunks.every((c) => c.split(/\s+/).filter((w) => w !== "##").length === CHUNK_WORDS),
    "a cutoff on a boundary leaves no empty tail",
  );
}

// ---------------------------------------------------------------------------
// 4. The route and the module
// ---------------------------------------------------------------------------
console.log("\nthe route:");
{
  const route = source("app/api/books/[id]/ask/route.ts");
  const mod = source("lib/books/ask.ts");
  assert(/readSoFar\(parsed, position\.word\)/.test(route), "🔴 the text is cut at the resolved position");
  assert(
    !/\.blocks\b|pageWindow|countEpubWords|findPhrase|readFileSync\([^)]*\)\.toString/.test(route),
    "🔴 the route has no other way to the book's text",
  );
  assert(/listProgress\(\)\.find\(\(p\) => p\.document === book\.partialMd5\)/.test(route), "the position is the latest sync for this file");
  assert(/if \(!sync\)[\s\S]{0,200}status: 409/.test(route), "no synced position → refused, never the whole book");
  assert(/if \(!process\.env\.ANTHROPIC_API_KEY\)[\s\S]{0,200}status: 503/.test(route), "no API key → refused with a reason");
  assert(!/^import (?!type )/m.test(mod), "ask.ts imports nothing but types");
  assert(/have not read anything after it/.test(mod) && /do not draw on what you know of how it continues/.test(mod) && /outside this book is welcome/.test(mod),
    "the instructions keep the rest of the book out and the outside world in");

  assert(Array.isArray(parseHistory(undefined)) && parseHistory([{ role: "user", content: "q" }, { role: "assistant", content: "a" }])!.length === 2, "history: a well-formed conversation passes");
  assert(
    parseHistory([{ role: "system", content: "x" }]) === null &&
      parseHistory([{ role: "assistant", content: "a" }]) === null &&
      parseHistory([{ role: "user", content: "" }]) === null &&
      parseHistory("x") === null &&
      parseHistory(Array.from({ length: MAX_HISTORY_TURNS + 1 }, () => ({ role: "user", content: "q" }))) === null,
    "history: other roles, an assistant-first turn, empty text and oversize are refused",
  );
}

if (failures > 0) {
  console.error(`\n✗ check:books:ask — ${failures} failure${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("\n✓ check:books:ask — the model is sent what has been read and nothing after it");
