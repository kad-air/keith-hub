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
//  3. TO THE END OF THE PAGE. Sheafs Hub sends `until`, the first character
//     after the page on screen, resolved by resolveEnd: every word before it
//     is in, the word it names and everything after are out, for a pointer at
//     every word of a built book; a pointer at the end of a paragraph of the
//     real book (Sheafs' own reference text) sends that paragraph and stops;
//     the end of the book sends all of it, last word included.
//  4. CHUNKS. Boundaries depend on the book alone, so an advancing position
//     leaves every full chunk byte-identical (the prompt cache depends on it).
//  5. THE ROUTE takes its text from readSoFar and nowhere else, cut at the
//     resolved position (the app's `until`, else the latest sync), refuses a
//     malformed `until`, and refuses without a key or any position.
//  6. THE SAVED CONVERSATION, in a throwaway database: it always alternates
//     question/answer, a question that got no answer is removed, a second
//     question can't start while one is being answered, a question whose
//     answer was lost is dropped after a while, and it leaves with its book.
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

const { parseBook, resolvePosition, resolveEnd } = await import("../lib/books/pageText.ts");
const { readSoFar, progressNote, CHUNK_WORDS } = await import("../lib/books/ask.ts");
const { PAGE_WORDS } = await import("../lib/books/pages.ts");

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
// 3. To the end of the page (the app's `until`)
// ---------------------------------------------------------------------------
console.log("\nto the end of the page (until):");
{
  let n = 0;
  const w = (count: number) => Array.from({ length: count }, () => `u${n++}`).join(" ");
  const built = parseBook(
    buildEpub([
      `<h1>${w(3)}</h1><p>${w(40)}</p><div>${w(5)}<p>${w(12)} <em>${w(3)}</em> ${w(4)}</p>${w(6)}</div>`,
      `<h2>${w(2)}</h2><p>${w(30)}<br/>${w(10)}</p><ul><li>${w(4)}</li><li>${w(4)}</li></ul>`,
      `<p>${w(25)}</p><p>THE-BUTLER-DID-IT ${w(8)}</p>`,
    ]),
  )!;
  const words = allWords(built);
  const ptr = (doc: number, path: string, offset: number) => `/body/DocFragment[${doc + 1}]/${path}/text().${offset}`;
  const pct = (word: number) => word / built.totalWords;
  // Sheafs' limit is the first character of the next page, so a pointer at
  // the START of word k must keep k out; one at the END of word k (a page that
  // ends at the space after it) must let k in and keep k+1 out. The last
  // piece of each element can also be named by its end.
  let startWrong = 0;
  let endWrong = 0;
  let pointers = 0;
  for (let i = 0; i < built.blocks.length; i++) {
    const b = built.blocks[i];
    for (let k = 0; k < b.words.length; k++) {
      const g = b.wordStart + k;
      const atStart = resolveEnd(built, ptr(b.doc, b.path, b.base + b.words[k][0]), pct(g));
      if (atStart.word !== g || atStart.precision !== "word" || !cutIsExact(built, words, atStart.word)) startWrong++;
      const laterPiece = built.blocks.some((o, j) => j > i && o.doc === b.doc && o.path === b.path);
      if (k < b.words.length - 1 || !laterPiece) {
        const atEnd = resolveEnd(built, ptr(b.doc, b.path, b.base + b.words[k][1]), pct(g + 1));
        if (atEnd.word !== g + 1 || !cutIsExact(built, words, atEnd.word)) endWrong++;
        pointers++;
      }
      pointers++;
    }
  }
  assert(pointers > 2 * words.length - 10, `${pointers} end-of-page pointers over ${words.length} distinct words`);
  assert(startWrong === 0, `🔴 a pointer at the start of a word keeps that word and everything after it out (${startWrong} wrong)`);
  assert(endWrong === 0, `🔴 a pointer at the end of a word sends it and nothing after it, across paragraphs and chapters (${endWrong} wrong)`);

  const butler = words.indexOf("THE-BUTLER-DID-IT");
  const bb = built.blocks.find((b) => b.wordStart === butler)!;
  const before = readSoFar(built, resolveEnd(built, ptr(bb.doc, bb.path, 0), pct(butler)).word).chunks.join(" ");
  const through = readSoFar(built, resolveEnd(built, ptr(bb.doc, bb.path, "THE-BUTLER-DID-IT".length), pct(butler + 1)).word).chunks.join(" ");
  assert(!before.includes("BUTLER") && through.includes("THE-BUTLER-DID-IT") && !through.includes(words[butler + 1]),
    "🔴 the next page's first word is withheld; the page's last word is sent and the one after it is not");

  const lastBlock = built.blocks[built.blocks.length - 1];
  const bookEnd = resolveEnd(built, ptr(lastBlock.doc, lastBlock.path, lastBlock.text.length), 1);
  assert(bookEnd.word === built.totalWords && cutIsExact(built, words, bookEnd.word) && readSoFar(built, bookEnd.word).chunks.join(" ").endsWith(words[words.length - 1]),
    "🔴 the end of the book sends all of it, the last word included");
  assert(resolveEnd(built, "/body/DocFragment[3]/body/p[9]", 1).word === built.totalWords, "…and so does a percentage of 1 for an element it can't find");
  assert(resolvePosition(built, ptr(lastBlock.doc, lastBlock.path, lastBlock.text.length), 1).word === built.totalWords - 1,
    "resolvePosition (the current-page view, the synced cut) still stops at the last word");
  const ch2 = built.docWords[1][0];
  assert(
    resolveEnd(built, "/body/DocFragment[2]/body", pct(ch2)).word === ch2 && resolveEnd(built, "/body/DocFragment[2]", pct(ch2)).word === ch2,
    "the start of the next chapter (its <body>) sends the whole of this one and none of that one",
  );
  const lastOf1 = built.blocks.filter((b) => b.doc === 0).pop()!;
  assert(resolveEnd(built, ptr(0, lastOf1.path, lastOf1.base + lastOf1.text.length), pct(ch2)).word === ch2,
    "the end of a chapter's last paragraph is the next chapter's first word");
  const [lo, hi] = built.docWords[1];
  const lost = resolveEnd(built, "/body/DocFragment[2]/body/section[7]/text().3", 0.99);
  assert(lost.precision === "percentage" && lost.word >= lo && lost.word <= hi,
    "an element it can't find falls back to the percentage, held inside that chapter");
}
{
  // The real book against Sheafs' own text for its paragraphs (its converter,
  // not this parser): a page ending before each of Sheafs' words, at Sheafs'
  // own offset, sends exactly the words before it, and one ending at the end
  // of the paragraph sends all of it and nothing of the next. Where the two
  // texts differ (Sheafs collapses the non-breaking spaces this parser keeps
  // after a <br>), the offsets drift and the cut may fall SHORT by a word —
  // never past what Sheafs shows.
  const book = parseBook(fixture("sheafs-alice.epub"))!;
  const ref = JSON.parse(fixture("sheafs-alice-reference.json").toString("utf8"));
  const squash = (s: string) => s.replace(/\s+/g, "");
  let paragraphs = 0;
  let pages = 0;
  let leaked = 0;
  let wrong = 0;
  let short = 0;
  for (const doc of ref.documents) {
    for (const sample of doc.samples) {
      if (!sample.text) continue;
      const at = book.blocks.findIndex((b) => b.doc === doc.spineIndex && "/" + b.path === sample.path && b.base === 0 && b.words.length > 0);
      if (at < 0 || squash(book.blocks[at].text) !== squash(sample.text)) continue;
      const b = book.blocks[at];
      const same = b.text === sample.text;
      const theirs = [...(sample.text as string).matchAll(/\S+/g)].map((m) => m.index!);
      const ends = [...theirs, (sample.text as string).length];
      ends.forEach((offset, k) => {
        const r = resolveEnd(book, `/body/DocFragment[${doc.spineIndex + 1}]${sample.path}/text().${offset}`, 0.5);
        const inPara = r.word - b.wordStart;
        if (inPara > k || readSoFar(book, r.word).words !== r.word) leaked++;
        else if (inPara < k) (same ? wrong++ : short++);
        pages++;
      });
      paragraphs++;
    }
  }
  assert(paragraphs >= 30 && pages > 1000, `sheafs-alice.epub: a page ending at each of ${pages} places in ${paragraphs} of Sheafs' paragraphs`);
  assert(leaked === 0, `🔴 none sends a word past where Sheafs' page ends (${leaked} did)`);
  assert(wrong === 0, `🔴 where Sheafs' text and the hub's agree, each sends exactly the words before it (${wrong} short)`);
  console.log(`    (${short} fell a word short where the texts differ: the cut errs toward less)`);
}

// ---------------------------------------------------------------------------
// 4. Chunks
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
// 5. The route and the module
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
  assert(/listProgress\(\)\.find\(\(p\) => p\.document === book\.partialMd5\)/.test(route), "without the app's cutoff, the position is the latest sync for this file");
  assert(
    /until\s*\?\s*resolveEnd\(parsed, until\.pointer, until\.percentage\)\s*:\s*resolvePosition\(parsed, sync!\.progress, sync!\.percentage\)/.test(route),
    "🔴 the app's `until` is resolved as an END (resolveEnd), the synced position as a start",
  );
  assert(
    (route.match(/const until = (readUntil\(body\?\.until\)|untilFromQuery\(request\));\s*if \(until && "error" in until\) return NextResponse\.json\(\{ error: until\.error \}, \{ status: 400 \}\)/g) ?? []).length === 2,
    "a malformed `until` is refused (400) on POST and GET, never ignored",
  );
  assert(/if \(!until && !sync\)[\s\S]{0,200}status: 409/.test(route), "no cutoff and no synced position → refused, never the whole book");
  assert(/if \(!process\.env\.ANTHROPIC_API_KEY\)[\s\S]{0,200}status: 503/.test(route), "no API key → refused with a reason");
  assert(!/^import (?!type |\{ PAGE_WORDS \} from "\.\/pages\.ts")/m.test(mod), "ask.ts imports nothing but types and the page convention");
  assert(/have not read anything after it/.test(mod) && /do not draw on what you know of how it continues/.test(mod) && /outside this book is welcome/.test(mod),
    "the instructions keep the rest of the book out and the outside world in");

  assert(
    /liveTurns\(params\.id\)/.test(route) && /listTurns\(bookId\)/.test(route) && !/body\?\.history|body\.history/.test(route),
    "the conversation so far comes from the database, never from the request",
  );
  assert(!/request\.signal/.test(route), "🔴 the answer is not tied to the browser staying connected");
  assert(
    /completeAnswer\(params\.id, questionId, answer/.test(route) && (route.match(/dropQuestion\(params\.id, questionId\)/g) ?? []).length >= 2,
    "an answer is saved; a refusal or an error removes its question",
  );
}

// ---------------------------------------------------------------------------
// 6. The saved conversation
// ---------------------------------------------------------------------------
console.log("\nthe saved conversation:");
{
  const os = await import("node:os");
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "ask-check-")));
  const { ingestBook, deleteBook } = await import("../lib/books/store.ts");
  const { listTurns, beginQuestion, completeAnswer, dropQuestion, clearTurns, isPending, PENDING_SECONDS } = await import(
    "../lib/books/askStore.ts"
  );
  const { book } = ingestBook(fixture("sheafs-alice.epub"), "alice.epub");
  const other = ingestBook(fixture("fixture.epub"), "fixture.epub").book;
  const t0 = 1_800_000_000;
  const shape = () => listTurns(book.id).map((t) => t.role[0]).join("");

  const q1 = beginQuestion(book.id, "Who is late?", 1000, t0)!;
  assert(q1 != null && shape() === "u" && isPending(listTurns(book.id), t0 + 5), "a question is saved as soon as it is asked, and is pending");
  assert(beginQuestion(book.id, "And another?", 1000, t0 + 10) === null && shape() === "u", "🔴 no second question while the first is being answered");
  completeAnswer(book.id, q1, "The White Rabbit.", 1000, t0 + 20);
  assert(shape() === "ua" && !isPending(listTurns(book.id), t0 + 21), "its answer lands after it");

  const q2 = beginQuestion(book.id, "Fails", 2000, t0 + 30)!;
  dropQuestion(book.id, q2);
  assert(shape() === "ua", "a question that got no answer is removed");
  completeAnswer(book.id, q2, "late answer", 2000, t0 + 40);
  assert(shape() === "ua", "an answer to a question that is gone is not saved");

  beginQuestion(book.id, "Lost in a restart", 2000, t0 + 50);
  const q4 = beginQuestion(book.id, "Asked later", 3000, t0 + 50 + PENDING_SECONDS)!;
  assert(q4 != null && shape() === "uau" && listTurns(book.id)[2].content === "Asked later", "🔴 a question whose answer was lost is dropped, not left to block the thread");
  completeAnswer(book.id, q4, "Answer", 3000, t0 + 60 + PENDING_SECONDS);
  const turns = listTurns(book.id);
  assert(
    shape() === "uaua" && turns[0].words === 1000 && turns[3].words === 3000 && turns[0].createdAt === t0,
    "the thread alternates and each turn keeps how far the reader was",
  );
  const P = PAGE_WORDS;
  assert(
    progressNote(null, P * 41 + 10) === "Starting around page 42" &&
      progressNote(1000, 1000 + P * 12) === "You read 12 more pages" &&
      progressNote(1000, 1000 + P) === "You read 1 more page" &&
      progressNote(P * 9, P * 4) === "You went back 5 pages" &&
      progressNote(1000, 1000) === null &&
      progressNote(1000, 1000 + Math.floor(P / 2) - 1) === null,
    "🔴 between questions: pages read since the last one, in the hub's own page size; under half a page says nothing",
  );

  const oq = beginQuestion(other.id, "Other book", 5000, t0)!;
  completeAnswer(other.id, oq, "Other answer", 5000, t0 + 1);
  assert(listTurns(book.id).length === 4 && listTurns(other.id).length === 2, "one thread per book");
  dropQuestion(other.id, q1);
  assert(listTurns(book.id).length === 4, "one book's route cannot remove another's turn");
  assert(clearTurns(other.id) === 2 && listTurns(other.id).length === 0 && listTurns(book.id).length === 4, "clearing clears that book only");
  deleteBook(book.id);
  assert(listTurns(book.id).length === 0, "the conversation leaves with its book");
}

if (failures > 0) {
  console.error(`\n✗ check:books:ask — ${failures} failure${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("\n✓ check:books:ask — the model is sent what has been read and nothing after it");
