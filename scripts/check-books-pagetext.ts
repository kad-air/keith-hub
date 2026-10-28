#!/usr/bin/env node
//
// 🔴 THE CURRENT-PAGE GATE.
//
//   npm run check:books:pagetext   (standalone)
//   npm run build                  (via prebuild)
//
// lib/books/pageText.ts turns the synced kosync `progress` back into a spot in
// the book's text, so the page can be shown on a second screen for Audible's
// camera page-sync. A wrong resolution has no error surface — the page just
// shows the wrong passage and Audible syncs to it — so it gets a gate.
//
//  1. SHEAFS' PATHS, against Sheafs' own reference. sheafs-alice.epub and its
//     paragraph samples are copied from the Sheafs repo, where they are what
//     Sheafs' XHTMLConverter (the code that writes Keith's pointers) is tested
//     against. Every sampled pointer, in the `text().0` form Sheafs pushes and
//     in the index-less form other readers write, must land in the paragraph
//     with that text.
//  2. DEVICE POINTERS. The paragraph pointers in expected.json — the dialect
//     validated against real CrossPoint pointers — must land on their own
//     paragraph's first word.
//  3. OFFSETS AND FALLBACKS the fixtures can't express, on an epub built here:
//     a character offset names its word, a pointer into an inline element lands
//     inside its paragraph, text split around a nested block keeps its offsets,
//     a pointer the book doesn't have falls back to the percentage (inside its
//     chapter when the chapter exists) instead of failing.
//  4. PAGES. Paging forward from the start shows every word exactly once and in
//     order; the synced word is marked; a hub-synthesized catch-up pointer opens
//     on the paragraph it was made from.

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixture = (name: string) => fs.readFileSync(path.resolve(repoRoot, "books-fixture", name));

const { parseBook, parsePointer, resolvePosition, pageWindow, pageStartFor, decodeEntities } = await import(
  "../lib/books/pageText.ts"
);
const { findPhrase } = await import("../lib/books/xpointer.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

type Book = NonNullable<ReturnType<typeof parseBook>>;
const squash = (s: string) => s.replace(/\s+/g, "");
const blockOfWord = (book: Book, word: number) =>
  book.blocks.find((b) => b.wordStart <= word && word < b.wordStart + b.words.length);
const wordText = (book: Book, word: number) => {
  const b = blockOfWord(book, word);
  if (!b) return null;
  const [s, e] = b.words[word - b.wordStart];
  return b.text.slice(s, e);
};

console.log("check:books:pagetext — the synced position, back to the text\n");

// ---------------------------------------------------------------------------
// 1. Sheafs' element paths, against Sheafs' own reference
// ---------------------------------------------------------------------------
console.log("Sheafs' paths (sheafs-alice.epub vs Sheafs' converter reference):");
{
  const book = parseBook(fixture("sheafs-alice.epub"));
  const ref = JSON.parse(fixture("sheafs-alice-reference.json").toString("utf8"));
  assert(book != null, "the epub parses");
  let checked = 0;
  let wrong = 0;
  let indexlessWrong = 0;
  for (const doc of ref.documents) {
    for (const sample of doc.samples) {
      if (!sample.text) continue;
      const pointer = `/body/DocFragment[${doc.spineIndex + 1}]${sample.path}/text().0`;
      const r = resolvePosition(book!, pointer, 0.5);
      const block = blockOfWord(book!, r.word);
      const ok = r.precision === "word" && block != null && squash(block.text) === squash(sample.text)
        && r.word === block.wordStart;
      if (!ok) {
        wrong++;
        if (wrong <= 3) console.error(`    ${pointer} → ${JSON.stringify(block?.text.slice(0, 60))} (${r.precision})`);
      }
      const indexless = pointer.replace(/\/(div|section|header)\[1\]/g, "/$1");
      if (resolvePosition(book!, indexless, 0.5).word !== r.word) indexlessWrong++;
      checked++;
    }
  }
  assert(checked >= 30, `${checked} sampled paragraphs checked`);
  assert(wrong === 0, `🔴 every Sheafs-form pointer lands on its paragraph (${wrong} wrong)`);
  assert(indexlessWrong === 0, `an omitted [1] reads as [1] (${indexlessWrong} wrong)`);
}

// ---------------------------------------------------------------------------
// 2. The device-validated paragraph pointers (fixture.epub)
// ---------------------------------------------------------------------------
console.log("\ndevice paragraph pointers (expected.json):");
{
  const book = parseBook(fixture("fixture.epub"));
  const samples = JSON.parse(fixture("expected.json").toString("utf8")).xpointer.samples as Array<{
    pointer: string;
    paragraph_ordinal: number;
  }>;
  assert(book != null && book.blocks.length === 900, "900 paragraphs, one block each");
  let wrong = 0;
  for (const s of samples) {
    const r = resolvePosition(book!, s.pointer, null);
    const b = book!.blocks[s.paragraph_ordinal];
    if (r.precision !== "paragraph" || r.word !== b.wordStart || `/body/DocFragment[1]/${b.path}` !== s.pointer) wrong++;
  }
  assert(wrong === 0, `🔴 all ${samples.length} sampled pointers open on their paragraph's first word`);
}

// ---------------------------------------------------------------------------
// 3. Offsets and fallbacks, on an epub built here
// ---------------------------------------------------------------------------
console.log("\noffsets, inline pointers, fallbacks:");

function buildEpub(): Buffer {
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`));
  zip.addFile("OEBPS/content.opf", Buffer.from(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Page Check</dc:title><dc:identifier id="id">check</dc:identifier></metadata>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`));
  // A cover page with no text at all: DocFragment[1] must still count.
  zip.addFile("OEBPS/cover.xhtml", Buffer.from(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><div><img src="c.jpg"/></div></body></html>`,
  ));
  zip.addFile("OEBPS/ch1.xhtml", Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title><style>p{}</style></head><body>
<h1>Chapter   the  First</h1>
<section>
  <p>The lighthouse keeper counted seventeen gulls before breakfast.</p>
  <p>By noon the <i>fog</i> had swallowed the headland, and the <span class="x">foghorn spoke</span> its one grey syllable.</p>
</section>
<div class="interlude">Between sections there was tea<p>and the small victory of a biscuit.</p>after which the kettle cooled.</div>
<section>
  <p>Sm&#233;agol&#8217;s shadow &mdash; if it was his &mdash; slipped along the causeway wall.</p>
</section>
</body></html>`));
  // ch2: plenty of paragraphs so paging has something to walk.
  const paras = Array.from({ length: 60 }, (_, i) =>
    `<p>Paragraph ${i} of the long chapter, holding a dozen ordinary words for the pager to count.</p>`).join("\n");
  zip.addFile("OEBPS/ch2.xhtml", Buffer.from(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body>\n${paras}\n</body></html>`,
  ));
  return zip.toBuffer();
}

const built = buildEpub();
const book = parseBook(built)!;
assert(book != null, "the built epub parses");
{
  assert(decodeEntities("a&amp;b &#8217; &rsquo; &eacute; &unknown;") === "a&b ’ ’ é &unknown;", "entities decode");
  const h1 = book.blocks.find((b) => b.heading);
  assert(h1?.text === "Chapter the First" && h1.path === "body/h1[1]", "a heading is its own block, whitespace collapsed");
  const smeagol = book.blocks.find((b) => b.path === "body/section[2]/p[1]");
  assert(smeagol?.text.startsWith("Sméagol’s shadow — if it was his — slipped") === true, "entities inside the text decode");

  // Hand-computed offsets in the collapsed text (Sheafs' text().N).
  const fog = "By noon the fog had swallowed the headland, and the foghorn spoke its one grey syllable.";
  const at = (needle: string) => fog.indexOf(needle);
  const p2 = "/body/DocFragment[2]/body/section[1]/p[2]";
  const r1 = resolvePosition(book, `${p2}/text().${at("swallowed")}`, null);
  assert(r1.precision === "word" && wordText(book, r1.word) === "swallowed", `🔴 a character offset names its word (${wordText(book, r1.word)})`);
  const r2 = resolvePosition(book, `${p2}/text().${at("swallowed") + 3}`, null);
  assert(r2.word === r1.word, "an offset inside a word names that word");
  const r3 = resolvePosition(book, `${p2}/text().${at(" swallowed")}`, null);
  assert(r3.word === r1.word, "an offset on the space before a word names the next word");
  const r4 = resolvePosition(book, `${p2}/text().100000`, null);
  assert(wordText(book, r4.word) === "Between", "an offset past the paragraph's end opens on the next text");
  const r5 = resolvePosition(book, `${p2}/span[1]/text().0`, null);
  assert(wordText(book, r5.word) === "foghorn", "a pointer into an inline element lands inside its paragraph");
  const r6 = resolvePosition(book, p2, null);
  assert(r6.precision === "paragraph" && wordText(book, r6.word) === "By", "a paragraph pointer (CrossPoint) opens on its first word");

  // Text directly in a container, split by a nested <p>: the second piece
  // keeps counting the container's characters.
  const div = "/body/DocFragment[2]/body/div[1]";
  const first = "Between sections there was tea";
  assert(wordText(book, resolvePosition(book, `${div}/text().0`, null).word) === "Between", "container text is an implicit block");
  const tail = resolvePosition(book, `${div}/text().${first.length + "after which the ".length}`, null);
  assert(wordText(book, tail.word) === "kettle", `container text after a nested block keeps its offsets (${wordText(book, tail.word)})`);
  const nestedP = resolvePosition(book, `${div}/p[1]/text().8`, null);
  assert(wordText(book, nestedP.word) === "small", "the nested paragraph has its own offsets");

  // Fallbacks: never an error, always somewhere sensible.
  const ch2 = book.docWords[2];
  const wrongEl = resolvePosition(book, "/body/DocFragment[3]/body/p[999]/text().0", 0.01);
  assert(wrongEl.precision === "percentage" && wrongEl.word >= ch2[0] && wrongEl.word < ch2[1],
    "🔴 an element the chapter lacks falls back to the percentage, held inside that chapter");
  const noDoc = resolvePosition(book, "/body/DocFragment[40]/body/p[1]", 0.5);
  assert(noDoc.precision === "percentage" && noDoc.word === Math.floor(0.5 * book.totalWords), "a chapter the book lacks falls back to the percentage");
  const junk = resolvePosition(book, "epubcfi(/6/4!/4/2)", 0.25);
  assert(junk.precision === "percentage" && junk.word === Math.floor(0.25 * book.totalWords), "a non-CREngine string falls back to the percentage");
  assert(resolvePosition(book, null, null).precision === "none", "nothing synced → the start, marked none");
  const cover = resolvePosition(book, "/body/DocFragment[1]/body/div[1]", null);
  assert(wordText(book, cover.word) === "Chapter", "a textless page (the cover) opens on the next text");
  assert(parsePointer("/body/DocFragment[2]/body/section/p[2]/text()[3].7")?.path === "body/section[1]/p[2]", "KOReader text()[k] form parses");
  assert(parsePointer("/html/body/p") === null && parsePointer("/body/DocFragment[0]/body") === null, "malformed pointers parse to null");
}

// ---------------------------------------------------------------------------
// 4. Pages
// ---------------------------------------------------------------------------
const longText = Array.from({ length: 80 }, (_, i) => `Sentence ${i} has exactly seven words in it.`).join(" ");
const longOffset = longText.indexOf("Sentence 40 ") + "Sentence 40 has ".length;

console.log("\npages:");
{
  // Forward from the start: every word once, in order, nothing skipped.
  const seen: string[] = [];
  let from: number | null = 0;
  let pages = 0;
  let marks = 0;
  let backwards = 0;
  while (from != null && pages < 1000) {
    const w = pageWindow(book, from, null, 40);
    for (const b of w.blocks) {
      seen.push(...(b.text.match(/\S+/g) ?? []));
      if (b.mark) marks++;
    }
    if (!(w.prevFrom === null ? w.startWord === 0 : w.prevFrom < w.startWord)) backwards++;
    from = w.nextFrom;
    pages++;
  }
  const all = book.blocks.flatMap((b) => b.text.match(/\S+/g) ?? []);
  assert(seen.length === all.length && seen.every((x, i) => x === all[i]), `🔴 paging forward shows all ${all.length} words once, in order`);
  assert(backwards === 0, `each of ${pages} pages' "previous" starts before it`);
  assert(marks === 0, "no mark without a synced position");

  const pos = resolvePosition(book, "/body/DocFragment[3]/body/p[31]/text().10", null).word;
  const start = pageStartFor(book, pos);
  const w = pageWindow(book, start, pos);
  const marked = w.blocks.filter((b) => b.mark);
  assert(marked.length === 1 && marked[0].text.slice(...marked[0].mark!) === "30", `the synced word is marked (${marked[0] && marked[0].text.slice(...marked[0].mark!)})`);
  assert(w.blocks[0].text.startsWith("Paragraph 30 ") && !w.blocks[0].cutStart, "a page opens at the paragraph holding the position");

  // A long paragraph: the page opens at the sentence, not 400 words back.
  const long = parseBook(buildLong())!;
  const deep = resolvePosition(long, "/body/DocFragment[1]/body/p[1]/text()." + longOffset, null).word;
  const s = pageStartFor(long, deep);
  const lw = pageWindow(long, s, deep);
  assert(lw.blocks[0].cutStart && lw.blocks[0].text.startsWith("Sentence 40 "), `deep in a long paragraph the page opens at the sentence (${lw.blocks[0].text.slice(0, 20)})`);

  // Round trip with the hub's own catch-up pointers.
  const cand = findPhrase(built, "slipped along the causeway wall")?.candidates[0];
  const back = cand ? resolvePosition(book, cand.pointer, cand.percentage) : null;
  const page = back ? pageWindow(book, pageStartFor(book, back.word), back.word) : null;
  assert(page?.blocks[0]?.text.startsWith("Sméagol’s shadow") === true, "🔴 a catch-up pointer the hub wrote opens on its paragraph");
}

function buildLong(): Buffer {
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile("META-INF/container.xml", Buffer.from(`<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`));
  zip.addFile("c.opf", Buffer.from(`<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`));
  zip.addFile("a.xhtml", Buffer.from(`<html><body><p>${longText}</p></body></html>`));
  return zip.toBuffer();
}

console.log(failures === 0 ? "\nAll current-page checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
