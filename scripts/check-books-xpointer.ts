#!/usr/bin/env node
//
// 🔴 THE SYNTHESIZED-POINTER GATE.
//
//   npm run check:books:xpointer   (standalone)
//   npm run build                  (via prebuild)
//
// lib/books/xpointer.ts is the one deliberate exception to "kosync progress is
// opaque": it CONSTRUCTS pointers, in CrossPoint's own dialect, so a position
// heard in an audiobook can be written to the device. A wrong pointer has no
// error surface anywhere — the device just opens the wrong page — so the
// dialect gets a gate rather than trust.
//
// Three kinds of evidence, each present because the others can't see its
// failure:
//
//  1. DIALECT, against an independent implementation. The Python reference
//     (scripts/gen_book_xpointer_reference.py — html.parser + ElementTree, no
//     shared code with the TS tokenizer) was validated byte-exact against
//     three real CrossPoint pointers from production devices before this
//     shipped; its output over the committed fixture lives in
//     books-fixture/expected.json under "xpointer", and the TS walk must
//     reproduce every sampled pointer string exactly.
//
//  2. STRUCTURE the flat fixture can't express. The fixture's 900 paragraphs
//     are direct children of <body>; the real pointers that motivated all of
//     this include a nested /body/section[1]/p[105] (The Two Towers). A
//     deterministic epub built IN this check carries nested sections, so the
//     sibling-indexing rules are exercised where they can actually go wrong.
//
//  3. SEARCH under dictation damage. The phrase arrives by ear — so the gate
//     feeds the matcher a transcription-shaped corruption of a real paragraph
//     (dropped word, misspelling, folded diacritics, no punctuation) and
//     requires the SAME paragraph to win that an exact quote wins. Gibberish
//     must return nothing rather than a confident wrong page.
//
// Plus the write-side hygiene rule: isSynthesizedPointer must accept exactly
// what findPhrase emits and refuse everything else — device-dialect pointers
// with text() offsets included, because set-position must never become a
// general "write any progress string" endpoint.

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixtureBytes = fs.readFileSync(path.resolve(repoRoot, "books-fixture/fixture.epub"));
const expected = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, "books-fixture/expected.json"), "utf8"),
);

const { findPhrase, paragraphsOf, isSynthesizedPointer, normalizeWord } = await import(
  "../lib/books/xpointer.ts"
);
const { resolveSpine } = await import("../lib/books/epubText.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("check:books:xpointer — the synthesized-pointer dialect\n");

// ---------------------------------------------------------------------------
// 1. Dialect vs the committed Python reference (fixture.epub)
// ---------------------------------------------------------------------------
console.log("dialect vs Python reference:");
const ref = expected.xpointer;
assert(ref != null && Array.isArray(ref.samples), "expected.json carries the xpointer block");

{
  const zip = new AdmZip(fixtureBytes);
  const byName = new Map(zip.getEntries().map((e) => [e.entryName.replace(/^\.?\//, ""), e]));
  const readText = (name: string) =>
    byName.get(name.replace(/^\.?\//, ""))?.getData().toString("utf8") ?? null;
  const spine = resolveSpine(readText);
  assert(spine.length > 0, "fixture spine resolves");

  const pointersByDoc = new Map<number, string[]>();
  spine.forEach((name, d) => {
    const xhtml = readText(name);
    if (!xhtml) return;
    pointersByDoc.set(
      d + 1,
      paragraphsOf(xhtml).map((p) => `/body/DocFragment[${d + 1}]/${p.path}`),
    );
  });

  let mismatches = 0;
  for (const s of ref.samples as Array<{ pointer: string; doc_index: number; paragraph_ordinal: number }>) {
    const ours = pointersByDoc.get(s.doc_index)?.[s.paragraph_ordinal];
    if (ours !== s.pointer) {
      mismatches++;
      if (mismatches <= 3) console.error(`      ${s.pointer} != ${ours ?? "(missing)"}`);
    }
  }
  assert(
    mismatches === 0,
    `🔴 all ${ref.samples.length} sampled pointers match the Python reference byte-for-byte`,
  );
  const total = pointersByDoc.get(1)?.length ?? 0;
  assert(total === 900, `paragraph count is the fixture's 900 (got ${total})`);
}

// ---------------------------------------------------------------------------
// 2. A nested epub the flat fixture can't express — built deterministically.
//    Prose is distinctive per paragraph so search results are decidable.
// ---------------------------------------------------------------------------
console.log("\nnested structure + dictation-grade search:");

function buildEpub(): Buffer {
  const zip = new AdmZip();
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Nested Check</dc:title><dc:identifier id="id">check</dc:identifier></metadata>
  <manifest>
    <item id="front" href="front.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="front"/><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;
  const front = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>
<p>A slim front matter page that exists to make DocFragment numbering exercise more than one document.</p>
</body></html>`;
  // ch1: paragraphs nested under sections — the Two Towers shape — with an
  // intervening non-section element so same-TAG (not same-position) indexing
  // is what's actually being tested. Distinctive prose per paragraph.
  const ch1 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title><style>p { margin: 0 }</style></head><body>
<h1>Chapter the First</h1>
<section>
  <p>The lighthouse keeper counted seventeen gulls before breakfast, and wrote each one into the ledger.</p>
  <p>By noon the fog had swallowed the headland, and the foghorn spoke its one grey syllable over the water.</p>
</section>
<div class="interlude"><p>Between sections there was tea, and the small victory of a biscuit unbroken in the tin.</p></div>
<section>
  <p>Sméagol’s shadow — if it was his — slipped along the causeway wall without once touching the lamplight.</p>
  <p>The keeper latched the door twice that night, and told nobody about the wet footprints on the stair.</p>
</section>
</body></html>`;
  const ch2 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>
<p>Morning arrived unrepentant, as mornings do, and the ledger gained a line about wind from the southwest.</p>
<p>The keeper counted seventeen gulls again and suspected them, privately, of being the same gulls.</p>
</body></html>`;
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile("META-INF/container.xml", Buffer.from(container));
  zip.addFile("OEBPS/content.opf", Buffer.from(opf));
  zip.addFile("OEBPS/front.xhtml", Buffer.from(front));
  zip.addFile("OEBPS/ch1.xhtml", Buffer.from(ch1));
  zip.addFile("OEBPS/ch2.xhtml", Buffer.from(ch2));
  return zip.toBuffer();
}

const nested = buildEpub();

// Expected pointers, written BY HAND from the dialect rules — not read back
// from the module under test.
const wantSmeagol = "/body/DocFragment[2]/body/section[2]/p[1]";
const wantInterlude = "/body/DocFragment[2]/body/div[1]/p[1]";
const wantCh2Second = "/body/DocFragment[3]/body/p[2]";

{
  const exact = findPhrase(nested, "slipped along the causeway wall without once touching the lamplight");
  assert(exact != null && exact.candidates.length > 0, "exact quote finds a candidate");
  assert(
    exact?.candidates[0]?.pointer === wantSmeagol,
    `🔴 nested section indexing: ${exact?.candidates[0]?.pointer} === ${wantSmeagol}`,
  );
  assert((exact?.candidates[0]?.confidence ?? 0) > 0.95, "exact quote scores ~perfect confidence");

  // Dictation damage: diacritics folded, apostrophes gone, a word misheard
  // ("causeway" -> "causway"), a word dropped ("once"), no punctuation.
  const heard = findPhrase(nested, "smeagols shadow slipped along the causway wall without touching the lamplight");
  assert(heard != null && heard.candidates.length > 0, "dictation-damaged phrase still matches");
  assert(
    heard?.candidates[0]?.pointer === wantSmeagol,
    "🔴 damaged phrase resolves to the SAME paragraph as the exact quote",
  );
  assert(
    (heard?.candidates[0]?.confidence ?? 1) < (exact?.candidates[0]?.confidence ?? 0),
    "damage costs confidence (exact > damaged)",
  );

  // Heavier damage: HALF the words misheard (each recoverable only through a
  // fuzzy tier — one edit or shared prefix). With the tiers disabled, exact
  // words alone score below the accept threshold and this finds nothing —
  // verified by falsification: the milder phrase above PASSED with fuzzy
  // matching entirely removed, because eight of its words were still exact.
  const mangled = findPhrase(nested, "smeagols shaddow sliped along causway wall touching the lamplight");
  assert(
    mangled?.candidates[0]?.pointer === wantSmeagol,
    "🔴 half-misheard phrase still resolves (this is the assertion that needs the fuzzy tiers)",
  );

  const div = findPhrase(nested, "the small victory of a biscuit unbroken in the tin");
  assert(div?.candidates[0]?.pointer === wantInterlude, `div-nested paragraph: ${div?.candidates[0]?.pointer}`);

  const ch2 = findPhrase(nested, "suspected them privately of being the same gulls");
  assert(ch2?.candidates[0]?.pointer === wantCh2Second, `DocFragment numbering spans docs: ${ch2?.candidates[0]?.pointer}`);

  // A phrase that appears (near-)verbatim in two places must surface both.
  const twice = findPhrase(nested, "the keeper counted seventeen gulls");
  assert((twice?.candidates.length ?? 0) >= 2, "a repeated phrase yields multiple candidates");

  // Order sanity: percentage grows with document order.
  const first = findPhrase(nested, "counted seventeen gulls before breakfast and wrote each one");
  assert(
    (first?.candidates[0]?.percentage ?? 1) < (ch2?.candidates[0]?.percentage ?? 0),
    "percentage is monotone with position in the book",
  );

  const gibberish = findPhrase(nested, "zqvw pltk mrrgh xandruvel qoppitz vlem");
  assert((gibberish?.candidates.length ?? -1) === 0, "gibberish returns nothing, not a confident wrong page");
}

// ---------------------------------------------------------------------------
// 3. Write-side hygiene: what set-position may accept
// ---------------------------------------------------------------------------
console.log("\nisSynthesizedPointer:");
assert(isSynthesizedPointer(wantSmeagol), "accepts the synthesized nested form");
assert(isSynthesizedPointer("/body/DocFragment[6]/body/p[21]"), "accepts the synthesized flat form");
assert(
  !isSynthesizedPointer("/body/DocFragment[7]/body/section/p[44]/text()[2].186"),
  "🔴 refuses the device's own richer dialect (text() offsets are not ours to write)",
);
assert(!isSynthesizedPointer("/body/DocFragment[2]/body/section[2]"), "refuses a pointer not ending at a <p>");
assert(!isSynthesizedPointer("17"), "refuses a bare PDF page number");
assert(!isSynthesizedPointer(""), "refuses the empty string");

// normalizeWord is the shared vocabulary of matcher and query — pin the folds
// that dictation depends on.
console.log("\nnormalizeWord + fuzzy tiers:");
assert(normalizeWord("Sméagol’s") === "smeagols", "folds diacritics and apostrophes");
assert(normalizeWord("counted,") === "counted", "strips punctuation");
const { wordsMatch } = await import("../lib/books/xpointer.ts");
assert(wordsMatch("causeway", "causway"), "one-edit tier: causeway ~ causway");
assert(wordsMatch("lamplight", "lamp"), "prefix tier: lamplight ~ lamp");
assert(!wordsMatch("cat", "cot"), "short words get no fuzz (cat != cot)");

if (failures > 0) {
  console.error(`\ncheck:books:xpointer FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:xpointer passed");
