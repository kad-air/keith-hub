#!/usr/bin/env node
//
// 🔴 THE EPUB HEALTH-CHECKER GATE.
//
//   npm run check:books:health   (standalone)
//   npm run build                (via prebuild)
//
// Two halves:
//
//  A. The pure checker (lib/books/health.ts) over in-memory fixture epubs —
//     a clean multi-chapter book must produce ZERO findings, and each
//     perturbation (mojibake, replacement characters, ciphertext spine docs,
//     leftover ADEPT encryption, missing TOC, OCR damage, no text, broken
//     structure, not-a-zip) must produce EXACTLY its finding and nothing
//     else. Exactness matters both ways: a check that stays silent on damage
//     is vacuous, and a checker that piles extra findings onto one cause
//     would train the reader to ignore the section. The font-obfuscation
//     case is here as the standing false-positive invitation: it reuses
//     encryption.xml and is NOT DRM (adept.ts's line, which health.ts
//     reuses rather than reimplements).
//
//  B. The persistence path (lib/books/healthData.ts + ingest) in a temp cwd:
//     🔴 computing and caching a report writes ONE DB column and never
//     touches the stored file, its sha256 or its partial_md5 — the same
//     guarantee check:books:metadata pins for updateBook, asserted here
//     because getBookHealth is a THIRD write path into the books table and
//     the other gates say nothing about it. Plus: ingest stamps a report,
//     a HEALTH_VERSION mismatch recomputes, and a missing file reports red
//     WITHOUT being cached (a restore could bring the bytes back).
//
//  C. The language check (lib/books/language.ts) over REAL BOOKS, because
//     it is the one part of the checker a self-built fixture cannot test:
//     text assembled from the detector's own function-word lists would be
//     verifying itself. books-fixture/language-samples.json holds passages
//     from eleven Project Gutenberg books in seven languages, and the
//     LABEL is Gutenberg's own catalogue header — not a judgment made in
//     this repo and not derived from the module under test. Madame Bovary
//     is in there twice, French original and English translation: same
//     novel, same author, same register, so language is the only thing
//     separating them.
//
// 🔴 What this gate cannot see, stated plainly: the fixtures are self-built,
// so it proves the checker recognises the damage patterns as CONSTRUCTED
// here — no real OCR-mangled or DRM-ghosted book can live in the repo (the
// one would be junk to ship, the other a rights problem). The thresholds
// (TOC_MATTERS_WORDS, the amber floors) are judgment calls pinned only at
// the boundaries exercised below; recalibrating them against the real
// library is legitimate and means updating both sides. The language
// passages are the exception — those are real books, and re-running
// scripts/gen-language-samples.mjs re-fetches them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

import { checkEpubHealth, HEALTH_VERSION, type EpubHealth } from "../lib/books/health.ts";
import { detectLanguage, tokenizeWords, LANGUAGE_NAMES } from "../lib/books/language.ts";
import { needsReplacementFile } from "../lib/books/healthRemedy.ts";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const chr = String.fromCharCode;
const codesOf = (r: EpubHealth) => r.findings.map((f) => f.code).sort();
const eq = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function assertCodes(r: EpubHealth, want: string[], label: string): void {
  const got = codesOf(r);
  assert(eq(got, [...want].sort()), `${label} (got: [${got.join(", ")}])`);
}

// Deterministic high-entropy bytes — Math.random is banned from gates for the
// same reason it's banned from workflows: a probabilistic assertion isn't one.
function noiseBytes(seed: string, size: number): Buffer {
  const out = Buffer.allocUnsafe(size);
  let block = createHash("sha256").update(seed).digest();
  let off = 0;
  while (off < size) {
    block = createHash("sha256").update(block).digest();
    block.copy(out, off, 0, Math.min(32, size - off));
    off += 32;
  }
  return out;
}

// --- fixture builder ------------------------------------------------------

// 17 words, chosen to trip nothing: no digits, no hyphens, no scanno tokens,
// no single letters outside a/I.
const SENTENCE =
  "The keeper counted the gulls along the harbour wall and wrote the number in the ledger before breakfast.";
const prose = (reps: number) => (SENTENCE + " ").repeat(reps);
const stdBody = (i: number) => `<h1>Chapter ${i}</h1><p>${prose(120)}</p>`;

type BuildOpts = {
  chapterBodies?: string[];
  language?: string | null;
  cover?: boolean;
  /** navPoint count for toc.ncx; null = no NCX. */
  ncxPoints?: number | null;
  /** anchor count for an EPUB3 nav doc; null = no nav doc. */
  navPoints?: number | null;
  encryptionXml?: string | null;
  rightsXml?: string | null;
  extraEntries?: Array<{ name: string; data: Buffer }>;
  /** 1-based chapter index → raw bytes stored under that chapter's name. */
  rawChapterBytes?: Map<number, Buffer>;
};

function buildEpub(opts: BuildOpts = {}): Buffer {
  const bodies = opts.chapterBodies ?? [1, 2, 3, 4, 5, 6].map(stdBody);
  const language = opts.language === undefined ? "en" : opts.language;
  const cover = opts.cover ?? true;
  const ncxPoints = opts.ncxPoints === undefined ? bodies.length : opts.ncxPoints;
  const navPoints = opts.navPoints ?? null;

  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
  );

  const manifest: string[] = [];
  const spine: string[] = [];
  bodies.forEach((_, i) => {
    manifest.push(
      `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`,
    );
    spine.push(`<itemref idref="ch${i + 1}"/>`);
  });
  if (ncxPoints != null) {
    manifest.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  }
  if (navPoints != null) {
    manifest.push(
      `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>`,
    );
  }
  if (cover) {
    manifest.push(
      `<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`,
    );
  }

  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Health Check Fixture</dc:title>
    <dc:creator>Nobody</dc:creator>
    ${language != null ? `<dc:language>${language}</dc:language>` : ""}
    <dc:identifier id="id">health-check</dc:identifier>
  </metadata>
  <manifest>${manifest.join("\n    ")}</manifest>
  <spine${ncxPoints != null ? ` toc="ncx"` : ""}>${spine.join("")}</spine>
</package>`;
  zip.addFile("OEBPS/content.opf", Buffer.from(opf));

  bodies.forEach((body, i) => {
    const raw = opts.rawChapterBytes?.get(i + 1);
    const data =
      raw ??
      Buffer.from(
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`,
      );
    zip.addFile(`OEBPS/ch${i + 1}.xhtml`, data);
  });

  if (ncxPoints != null) {
    const points = Array.from(
      { length: ncxPoints },
      (_, i) =>
        `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>Chapter ${i + 1}</text></navLabel><content src="ch${Math.min(i + 1, bodies.length)}.xhtml"/></navPoint>`,
    ).join("");
    zip.addFile(
      "OEBPS/toc.ncx",
      Buffer.from(
        `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${points}</navMap></ncx>`,
      ),
    );
  }
  if (navPoints != null) {
    const anchors = Array.from(
      { length: navPoints },
      (_, i) => `<li><a href="ch${Math.min(i + 1, bodies.length)}.xhtml">Chapter ${i + 1}</a></li>`,
    ).join("");
    zip.addFile(
      "OEBPS/nav.xhtml",
      Buffer.from(
        `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>n</title></head><body><nav epub:type="toc"><ol>${anchors}</ol></nav></body></html>`,
      ),
    );
  }
  if (cover) {
    zip.addFile("OEBPS/cover.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), noiseBytes("cover", 256)]));
  }
  if (opts.encryptionXml) {
    zip.addFile("META-INF/encryption.xml", Buffer.from(opts.encryptionXml));
  }
  if (opts.rightsXml) {
    zip.addFile("META-INF/rights.xml", Buffer.from(opts.rightsXml));
  }
  for (const e of opts.extraEntries ?? []) zip.addFile(e.name, e.data);
  return zip.toBuffer();
}

const ADEPT_ENC_XML = (uri: string) => `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <CipherData><CipherReference URI="${uri}"/></CipherData>
  </EncryptedData>
</encryption>`;
const RIGHTS_XML = `<adept:rights xmlns:adept="http://ns.adobe.com/adept"><licenseToken><encryptedKey>QUJDREVGRw==</encryptedKey></licenseToken></adept:rights>`;
const FONT_ENC_XML = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <CipherData><CipherReference URI="OEBPS/fonts/f.otf"/></CipherData>
  </EncryptedData>
</encryption>`;
const UNKNOWN_ENC_XML = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://example.org/private-scheme"/>
    <CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData>
  </EncryptedData>
</encryption>`;

console.log("check:books:health — the epub health checker\n");

// ---------------------------------------------------------------------------
// A. The pure checker
// ---------------------------------------------------------------------------
console.log("clean book:");
{
  const r = checkEpubHealth(buildEpub());
  assertCodes(r, [], "🔴 a clean multi-chapter book produces ZERO findings");
  assert(r.stats.spineDocs === 6, `spine documents counted (got ${r.stats.spineDocs})`);
  assert(r.stats.tocEntries === 6, `NCX TOC entries counted (got ${r.stats.tocEntries})`);
  assert(
    r.stats.words > 12000 && r.stats.words < 13000,
    `word count in range (got ${r.stats.words})`,
  );
  assert(r.version === HEALTH_VERSION, "report carries HEALTH_VERSION");
}
{
  const r = checkEpubHealth(buildEpub({ ncxPoints: null, navPoints: 6 }));
  assertCodes(r, [], "EPUB3 nav-only book is clean too");
  assert(r.stats.tocEntries === 6, `nav TOC entries counted (got ${r.stats.tocEntries})`);
}

console.log("\nencryption (the ghost's cause):");
{
  const r = checkEpubHealth(
    buildEpub({ encryptionXml: ADEPT_ENC_XML("OEBPS/ch1.xhtml"), rightsXml: RIGHTS_XML }),
  );
  assertCodes(r, ["encrypted-content"], "🔴 leftover ADEPT encryption is a red finding");
  assert(r.findings[0].severity === "red", "…at red severity");
}
{
  const cipher = new Map([[1, noiseBytes("adept-ciphertext", 8192)]]);
  const r = checkEpubHealth(
    buildEpub({
      encryptionXml: ADEPT_ENC_XML("OEBPS/ch1.xhtml"),
      rightsXml: RIGHTS_XML,
      rawChapterBytes: cipher,
    }),
  );
  assertCodes(
    r,
    ["encrypted-content"],
    "🔴 ADEPT + actual ciphertext is ONE finding — the unreadable docs are the same fact, not a second problem",
  );
}
{
  const r = checkEpubHealth(buildEpub({ encryptionXml: UNKNOWN_ENC_XML }));
  assertCodes(r, ["encrypted-content"], "an unrecognised encryption scheme is red too");
}
{
  const r = checkEpubHealth(
    buildEpub({
      encryptionXml: FONT_ENC_XML,
      extraEntries: [{ name: "OEBPS/fonts/f.otf", data: noiseBytes("font", 2048) }],
    }),
  );
  assertCodes(r, [], "🔴 font obfuscation is NOT flagged — it is not DRM (adept.ts's line)");
}

console.log("\nciphertext without encryption.xml (the pre-gate ghost):");
{
  const cipher = new Map([[2, noiseBytes("bare-ciphertext", 8192)]]);
  const r = checkEpubHealth(buildEpub({ rawChapterBytes: cipher }));
  assertCodes(r, ["unreadable-spine-docs"], "🔴 a ciphertext spine doc is a red finding");
  assert(
    /spine documents? 2\b/.test(r.findings[0].detail ?? ""),
    "…and the detail names the affected document",
  );
}

console.log("\ntext volume:");
{
  const bodies = Array.from({ length: 6 }, () => "<p></p>");
  const r = checkEpubHealth(buildEpub({ chapterBodies: bodies }));
  assertCodes(r, ["no-text"], "🔴 no prose at all is red — and suppresses the info-tier noise");
}
{
  const r = checkEpubHealth(buildEpub({ chapterBodies: [`<p>${prose(20)}</p>`], ncxPoints: 1 }));
  assertCodes(r, ["sparse-text"], "a few hundred words is amber sparse-text");
}

console.log("\ncharacter damage:");
const MOJI_RSQUO = chr(0xe2) + chr(0x20ac) + chr(0x2122); // "â€™"
const MOJI_EACUTE = chr(0xc3) + chr(0xa9); // "Ã©"
{
  const bodies = [1, 2, 3, 4, 5, 6].map(stdBody);
  bodies[1] += `<p>${(MOJI_RSQUO + " ").repeat(12)}${(MOJI_EACUTE + " ").repeat(8)}</p>`;
  const r = checkEpubHealth(buildEpub({ chapterBodies: bodies }));
  assertCodes(r, ["mojibake"], "🔴 mojibake (UTF-8 read as Latin-1) is caught");
  assert(r.findings[0].severity === "amber", "…20 occurrences is amber");
  assert(/20 mojibake/.test(r.findings[0].summary), "…and the summary carries the count");
}
const FFFD = chr(0xfffd);
{
  const bodies = [1, 2, 3, 4, 5, 6].map(stdBody);
  bodies[2] += `<p>${(FFFD + "word ").repeat(12)}</p>`;
  const r = checkEpubHealth(buildEpub({ chapterBodies: bodies }));
  assertCodes(r, ["artifact-characters"], "🔴 replacement characters are caught");
  assert(r.findings[0].severity === "amber", "…12 of them is amber");
  assert(
    /spine document 3/.test(r.findings[0].detail ?? ""),
    "…and the detail localises the worst document",
  );
}
{
  const bodies = [1, 2, 3, 4, 5, 6].map(stdBody);
  bodies[0] += `<p>${(FFFD + "word ").repeat(3)}</p>`;
  const r = checkEpubHealth(buildEpub({ chapterBodies: bodies }));
  assertCodes(r, ["artifact-characters"], "a handful of artifacts still reports");
  assert(r.findings[0].severity === "info", "…but only at info severity");
}

console.log("\nOCR damage:");
{
  const bodies = [1, 2, 3, 4, 5, 6].map(stdBody);
  bodies[3] += `<p>${"tbe ".repeat(20)}${"h0use ".repeat(15)}${"ex- ample ".repeat(20)}</p>`;
  const r = checkEpubHealth(buildEpub({ chapterBodies: bodies }));
  assertCodes(r, ["ocr-artifacts"], "🔴 scannos + digit-in-word + split hyphens are caught");
  assert(r.findings[0].severity === "amber", "…at amber severity for this density");
}
{
  const bodies = [1, 2, 3, 4, 5, 6].map(stdBody);
  bodies[0] += `<p>${"tbe ".repeat(30)}</p>`;
  const en = checkEpubHealth(buildEpub({ chapterBodies: bodies, language: "en" }));
  assertCodes(en, ["ocr-artifacts"], "English scannos fire on an English book");
}

// ---------------------------------------------------------------------------
// C. The language check, against real books labelled by Project Gutenberg
// ---------------------------------------------------------------------------
console.log("\nlanguage (real books, labelled by Project Gutenberg):");

type Sample = {
  id: number;
  title: string;
  language: string;
  script: string;
  words: number;
  text: string;
};
const SAMPLES: Sample[] = JSON.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../books-fixture/language-samples.json",
    ),
    "utf8",
  ),
).samples;

const sampleOf = (id: number): Sample => {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) throw new Error("missing language sample " + id);
  return s;
};
/** dc:language tag for a Gutenberg language name. */
const TAG_FOR: Record<string, string> = {
  English: "en",
  French: "fr",
  German: "de",
  Spanish: "es",
  Italian: "it",
  Portuguese: "pt",
  Dutch: "nl",
  Russian: "ru",
};
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A six-chapter book whose prose is one real passage. */
const bookOf = (sample: Sample, language: string | null) =>
  buildEpub({
    chapterBodies: [1, 2, 3, 4, 5, 6].map(
      (i) => `<h1>Chapter ${i}</h1><p>${esc(sample.text)}</p>`,
    ),
    language,
  });

// 🔴 The anchor: the detector's answer must equal Gutenberg's catalogue label
// on every passage. Nothing here is this codebase's opinion about what French
// looks like.
for (const sample of SAMPLES) {
  const v = detectLanguage(tokenizeWords(sample.text));
  const latin = sample.script === "Latin";
  const got = latin ? (v.code != null ? LANGUAGE_NAMES[v.code] : (v.name ?? "(none)")) : v.script;
  const ok = latin ? got === sample.language : v.script === sample.script;
  assert(
    ok,
    `${sample.language} — ${sample.title.slice(0, 32)} reads as ${got} ` +
      `(best ${(v.bestRate * 100).toFixed(0)}%, English ${(v.englishRate * 100).toFixed(1)}%)`,
  );
}

// 🔴 Same novel, two languages. Topic, author and register are held constant,
// so nothing but the language can be doing the work.
{
  const fr = detectLanguage(tokenizeWords(sampleOf(14155).text));
  const en = detectLanguage(tokenizeWords(sampleOf(2413).text));
  assert(
    fr.code === "fr" && en.code === "en" && fr.isEnglish === false && en.isEnglish === true,
    "🔴 Madame Bovary splits: the French original reads French, the English translation reads English",
  );
}

console.log("\nlanguage findings:");
{
  const r = checkEpubHealth(bookOf(sampleOf(1342), "en"));
  assertCodes(r, [], "🔴 a real English book, correctly tagged, is still CLEAN");
}
{
  const sample = sampleOf(2000);
  const r = checkEpubHealth(bookOf(sample, TAG_FOR[sample.language]));
  assertCodes(r, ["not-english"], "a Spanish book, correctly tagged, gets one info line");
  assert(r.findings[0].severity === "info", "…at info severity — it is a fact, not a fault");
  assert(
    /Spanish/.test(r.findings[0].summary) && /%/.test(r.findings[0].summary),
    "…naming the language and carrying its measurement",
  );
}
{
  const r = checkEpubHealth(bookOf(sampleOf(22367), "en"));
  assertCodes(r, ["language-mismatch"], "🔴 a German book tagged en is a MISMATCH, not a fact");
  assert(r.findings[0].severity === "amber", "…at amber — the device trusts the tag");
  assert(
    /Tagged English/.test(r.findings[0].summary) && /German/.test(r.findings[0].summary),
    "…naming both the tag and what the text actually reads as",
  );
}
{
  const r = checkEpubHealth(bookOf(sampleOf(1342), "de"));
  assertCodes(r, ["language-mismatch"], "…and the mirror: an English book tagged de");
  assert(
    !/against/.test(r.findings[0].summary),
    "…without the redundant 'English against English' phrasing",
  );
}
{
  const r = checkEpubHealth(bookOf(sampleOf(14155), null));
  assertCodes(
    r,
    ["no-language", "not-english"],
    "an untagged French book reports both facts — no tag, and not English",
  );
}
{
  const r = checkEpubHealth(bookOf(sampleOf(30774), "ru"));
  assertCodes(r, ["not-english"], "🔴 a Cyrillic book is caught by SCRIPT, before any word list");
  assert(/Cyrillic/.test(r.findings[0].summary), "…and names the script");
}

console.log("\n🔴 the OCR gate follows the TEXT, not the tag:");
{
  // The false positive this replaced. "y" and "o" are ordinary Spanish words,
  // and the lone-letter OCR signal counts every one of them — so under the old
  // tag-gated rule a Spanish novel mislabelled en was reported as OCR-damaged.
  const sample = sampleOf(2000);
  const text = sample.text.repeat(6);
  let lone = 0;
  for (const tok of text.split(/\s+/)) {
    const bare = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (bare.length === 1 && /[b-hj-z]/.test(bare)) lone++;
  }
  // Assert the case is LIVE before asserting it is handled — otherwise this
  // passes for the wrong reason the day the passage changes.
  assert(lone >= 50, `the Spanish passage really does carry the signal (${lone} lone letters)`);
  const r = checkEpubHealth(bookOf(sample, "en"));
  assert(
    !r.findings.some((f) => f.code === "ocr-artifacts"),
    "🔴 …yet a Spanish book mislabelled en is NOT reported as OCR-damaged",
  );
}
{
  // The other direction, which a tag-gated rule fails silently: real English
  // prose with real scannos, mislabelled as German, must still be checked.
  const sample = sampleOf(1342);
  const damaged: Sample = {
    ...sample,
    text: sample.text + " " + "tbe ".repeat(40) + "witli ".repeat(30),
  };
  const r = checkEpubHealth(bookOf(damaged, "de"));
  assert(
    r.findings.some((f) => f.code === "ocr-artifacts"),
    "🔴 …and an English book mislabelled de still gets its scanno check",
  );
}

console.log("\nno verdict on thin evidence:");
{
  // 🔴 An accusation needs a NAME. This is the repo's own committed fixture
  // epub — 180k words of "word0 word1 word2 …", tagged `en` — so the text is
  // 0.0% English function words while the file claims English. Amber would be
  // asserting the tag is wrong; all this check can honestly say is the number.
  const fixture = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../books-fixture/fixture.epub"),
  );
  const r = checkEpubHealth(fixture);
  const lang = r.findings.filter(
    (f) => f.code === "not-english" || f.code === "language-mismatch",
  );
  assert(
    lang.length === 1 && lang[0].code === "not-english" && lang[0].severity === "info",
    `🔴 unnameable text tagged en states the measurement, it does not accuse the tag (got: ${JSON.stringify(lang.map((f) => f.code + "/" + f.severity))})`,
  );
  assert(
    !/some other language/.test(lang[0].summary) && /0\.0%/.test(lang[0].summary),
    "…and says only what it measured, never 'reads as some other language'",
  );
}

{
  // 🔴 The ambiguous band, which is what the MARGIN rule in language.ts buys.
  // A book that is half English and half Dutch scores both in the high 20s and
  // whichever edges ahead is a coin toss — so the honest answer is no answer.
  // Without the margin this book is confidently declared Dutch.
  const en = sampleOf(1342).text.split(/\s+/);
  const nl = sampleOf(11024).text.split(/\s+/);
  const cut = Math.floor(en.length * 0.4);
  const mixed = en.slice(0, cut).concat(nl.slice(0, en.length - cut)).join(" ");
  const v = detectLanguage(tokenizeWords(mixed));
  assert(
    v.bestRate >= 0.2 && v.bestRate / Math.max(v.englishRate, 1e-9) < 1.5,
    `the mix really is ambiguous (English ${(v.englishRate * 100).toFixed(1)}%, ` +
      `best ${(v.bestRate * 100).toFixed(1)}%)`,
  );
  assert(
    v.isEnglish === null,
    "🔴 a half-English, half-Dutch book gets NO verdict — a near-tie is not evidence",
  );
  const r = checkEpubHealth(
    bookOf({ ...sampleOf(1342), text: mixed }, "en"),
  );
  assert(
    !r.findings.some((f) => f.code === "not-english" || f.code === "language-mismatch"),
    "…and therefore no language finding either way",
  );
}

{
  const words = sampleOf(14155).text.split(/\s+/).slice(0, 120).join(" ");
  const r = checkEpubHealth(
    buildEpub({ chapterBodies: [`<h1>One</h1><p>${esc(words)}</p>`], ncxPoints: 1, language: "en" }),
  );
  assert(
    !r.findings.some((f) => f.code === "not-english" || f.code === "language-mismatch"),
    "🔴 under MIN_WORDS_FOR_VERDICT there is NO language claim, right or wrong",
  );
}
{
  const v = detectLanguage(tokenizeWords("word ".repeat(500)));
  assert(
    v.isEnglish === false && v.code === null,
    "text that is no language at all reads as not-English but is never NAMED",
  );
}

console.log("\n🔴 stray single letters — the signal that cried wolf on Tolkien:");
// Provenance: The Return of the King (210,909 words) reported 278 "OCR-style
// artifacts" at 13 per 10k and was DEGRADED on the card, with no OCR damage in
// it at all. The book cannot live in this repo, so the three shapes that
// produced those 278 are reproduced here on real Gutenberg prose, and the
// numbers in the assertions below are the ones measured on the real file.
const enBook = sampleOf(1342).text;
/** N chapters of real English prose, chapter 1 optionally replaced. */
const chapters = (n: number, first?: string) =>
  Array.from({ length: n }, (_, i) => `<p>${esc(i === 0 && first ? first : enBook)}</p>`);
const ocrOf = (bodies: string[]) =>
  checkEpubHealth(buildEpub({ chapterBodies: bodies })).findings.find(
    (f) => f.code === "ocr-artifacts",
  );

{
  // Appendix E, "Writing and Spelling", discusses letters AS letters: 94 of the
  // real book's hits sat in that ONE file, 7 of 132 documents in total.
  const lettersEssay =
    "The consonant c has always the value of k even before e and i as in celeb " +
    "and the sound g is as in bulge while d is related to t and n to r throughout. ";
  const r = ocrOf(chapters(12, lettersEssay.repeat(30)));
  assert(
    r === undefined,
    `🔴 letters discussed AS letters in one appendix is SUBJECT MATTER, not a scanned book (got: ${r?.summary ?? "clean"})`,
  );
}
{
  // "see p. 1351", "c . 1600" (circa, spaced period in that file's typesetting),
  // and hobbit dialect "a lot o' beer" / "one of them 's in charge".
  const abbrevAndDialect =
    "It was about the end o' last year, see p. 1351 and Vol. I p. 6 for the tale. " +
    "c . 1600 Sauron forges the One Ring, and one of them 's in charge at the Tower now. ";
  // 🔴 In EVERY chapter, not one. The real book's dialect and page references
  // run right through it (chapters 11, 12, 17, 18 and three appendices), so a
  // one-chapter fixture would be zeroed by the concentration rule and this
  // case would pass without the punctuation exclusions doing any work at all.
  const r = ocrOf(
    Array.from(
      { length: 12 },
      () => `<p>${esc(enBook)}</p><p>${esc(abbrevAndDialect.repeat(20))}</p>`,
    ),
  );
  assert(
    r === undefined,
    `🔴 abbreviations and dialect elision are not stray letters (got: ${r?.summary ?? "clean"})`,
  );
}
{
  // The signal must still work. Real prose, split after the first letter in
  // EVERY chapter — which is what a bad scan actually looks like.
  const split = (t: string, every: number) => {
    const w = t.split(/\s+/);
    const out: string[] = [];
    w.forEach((x, i) => {
      if (i % every === 0 && x.length > 3 && /[b-hj-z]/.test(x[0])) out.push(x[0], x.slice(1));
      else out.push(x);
    });
    return out.join(" ");
  };
  const damaged = Array.from({ length: 12 }, () => `<p>${esc(split(enBook, 50))}</p>`);
  const r = ocrOf(damaged);
  assert(
    r !== undefined && r.severity === "amber",
    `🔴 …yet a book split in every chapter IS still caught (got: ${r?.summary ?? "MISSED"})`,
  );
  // And the undamaged same book stays silent, so the case is a contrast.
  assert(ocrOf(chapters(12)) === undefined, "…while the same book undamaged is silent");
}
{
  // 🔴 Severity is a rate. The old rule was `total >= 50 || rate >= 5`, so any
  // long book went amber on its own length — 60 hits in 200k words is 3 per 10k.
  // 160 chapters of real prose is ~128k words, so 60 hits is 4.7 per 10k —
  // under the amber rate, but over the old absolute count of 50.
  const withHyphens = `<p>${esc(enBook)}</p><p>${"ex- ample ".repeat(60)}</p>`;
  const long = [withHyphens, ...chapters(160).slice(1)];
  const r = ocrOf(long);
  const words = checkEpubHealth(buildEpub({ chapterBodies: long })).stats.words;
  assert(words > 120_000, `the long-book case really is long (${words.toLocaleString()} words)`);
  assert(
    r !== undefined && r.severity === "info",
    `🔴 60 hits in a 128k-word book is a LOW RATE (4.7/10k) — info, never amber on count alone (got: ${r?.severity ?? "clean"})`,
  );
}

console.log("\npurity + the remedy the card offers:");
{
  // 🔴 The pages.ts lesson: lib/books/health.ts imports AdmZip, so any module a
  // CLIENT component reads must not reach it at runtime. Both of these are
  // asserted structurally, because the failure is invisible — everything works
  // perfectly and only the bundle size ever says so.
  const langSrc = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../lib/books/language.ts"),
    "utf8",
  );
  const runtimeImports = (src: string) =>
    (src.match(/^\s*import\s+(?!type\b)[^\n]*$/gm) ?? []).filter((l) => !/^\s*import\s+type\b/.test(l));
  assert(
    runtimeImports(langSrc).length === 0,
    `🔴 language.ts imports NOTHING at runtime (got: ${JSON.stringify(runtimeImports(langSrc))})`,
  );

  const remedySrc = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../lib/books/healthRemedy.ts"),
    "utf8",
  );
  assert(
    runtimeImports(remedySrc).length === 0,
    `🔴 healthRemedy.ts imports NOTHING at runtime — a client component reads it (got: ${JSON.stringify(runtimeImports(remedySrc))})`,
  );
}
{
  // 🔴 The card's standing advice is "replace the file, which is a new book
  // with a fresh sync identity". That is right for damaged BYTES and wrong for
  // a wrong language tag, which Edit details fixes for free.
  const mismatch = checkEpubHealth(bookOf(sampleOf(22367), "en")).findings[0];
  assert(
    mismatch.code === "language-mismatch" && !needsReplacementFile(mismatch),
    "🔴 a language mismatch does NOT tell the reader to replace a perfectly good file",
  );
  assert(
    /Edit details/.test(mismatch.detail ?? ""),
    "…it points at the metadata editor instead",
  );
  const bodies = [1, 2, 3, 4, 5, 6].map(stdBody);
  bodies[1] += `<p>${(MOJI_RSQUO + " ").repeat(12)}</p>`;
  const damaged = checkEpubHealth(buildEpub({ chapterBodies: bodies })).findings[0];
  assert(
    damaged.code === "mojibake" && needsReplacementFile(damaged),
    "…while damaged bytes still do",
  );
  const info = checkEpubHealth(bookOf(sampleOf(2000), "es")).findings[0];
  assert(
    info.severity === "info" && !needsReplacementFile(info),
    "…and an info-tier fact never asks for anything",
  );
}

console.log("\nchapters:");
{
  const r = checkEpubHealth(buildEpub({ ncxPoints: null }));
  assertCodes(r, ["no-toc"], "🔴 a full-length book with no TOC is flagged");
}
{
  const one = [`<h1>All of it</h1><p>${prose(700)}</p>`];
  const r = checkEpubHealth(buildEpub({ chapterBodies: one, ncxPoints: null }));
  assertCodes(r, ["no-toc"], "single-file spine with no TOC is flagged");
  assert(
    /single file/i.test(r.findings[0].detail ?? ""),
    "…and the detail says the whole book is one file",
  );
}
{
  const r = checkEpubHealth(buildEpub({ ncxPoints: 2 }));
  assertCodes(r, ["sparse-toc"], "a 2-entry TOC on a 12k-word book is flagged");
}
{
  const short = [1, 2].map((i) => `<h1>Chapter ${i}</h1><p>${prose(90)}</p>`);
  const r = checkEpubHealth(buildEpub({ chapterBodies: short, ncxPoints: null }));
  assertCodes(r, [], "🔴 a short book with no TOC is NOT nagged — chapters matter at length");
}

console.log("\ninfo tier:");
{
  const r = checkEpubHealth(buildEpub({ cover: false }));
  assertCodes(r, ["no-cover"], "missing cover is an info line");
  assert(r.findings[0].severity === "info", "…at info severity");
}
{
  const r = checkEpubHealth(buildEpub({ language: null }));
  assertCodes(r, ["no-language"], "missing dc:language is an info line");
}
{
  const r = checkEpubHealth(
    buildEpub({ extraEntries: [{ name: "OEBPS/big.jpg", data: noiseBytes("big", 6 * 1024 * 1024) }] }),
  );
  assertCodes(r, ["image-heavy"], "a 6MB file for 12k words is an info line");
}

console.log("\nbroken containers:");
{
  const r = checkEpubHealth(Buffer.from("this is not a zip archive at all"));
  assertCodes(r, ["unreadable-zip"], "🔴 a non-zip is one red finding");
}
{
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile(
    "loose.xhtml",
    Buffer.from(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>${prose(120)}</p></body></html>`,
    ),
  );
  const r = checkEpubHealth(zip.toBuffer());
  assertCodes(
    r,
    ["unreadable-structure"],
    "🔴 a missing container/OPF is ONE red finding, not a pile of downstream noise",
  );
}

// ---------------------------------------------------------------------------
// B. The persistence path — temp cwd, real modules, real DB
// ---------------------------------------------------------------------------
console.log("\npersistence (temp cwd):");

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixtureBytes = fs.readFileSync(path.resolve(repoRoot, "books-fixture/fixture.epub"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-health-check-"));
process.chdir(tmp);

const { ingestBook, bookFilePath } = await import("../lib/books/store.ts");
const { getBookHealth, recheckBookHealth } = await import("../lib/books/healthData.ts");
const { getDb } = await import("../lib/db.ts");

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const db = getDb();
const rowOf = (id: string) =>
  db
    .prepare(`SELECT health_json, sha256, partial_md5, updated_at FROM books WHERE id = ?`)
    .get(id) as { health_json: string | null; sha256: string; partial_md5: string; updated_at: string };

const { book } = ingestBook(fixtureBytes, "The Fixture Book.epub");
{
  const row = rowOf(book.id);
  assert(row.health_json != null, "ingest stamps a health report at insert time");
  assert(
    row.health_json != null && (JSON.parse(row.health_json) as EpubHealth).version === HEALTH_VERSION,
    "…carrying HEALTH_VERSION",
  );
}

// The read-only guarantee, against a forced recompute.
db.prepare(`UPDATE books SET health_json = NULL WHERE id = ?`).run(book.id);
const fileBefore = sha256(fs.readFileSync(bookFilePath(book)));
const mtimeBefore = fs.statSync(bookFilePath(book)).mtimeMs;
const rowBefore = rowOf(book.id);

const recomputed = getBookHealth(book.id);
{
  assert(recomputed != null && recomputed.version === HEALTH_VERSION, "a NULL cache recomputes");
  const row = rowOf(book.id);
  assert(row.health_json != null, "…and caches the result");
  assert(
    sha256(fs.readFileSync(bookFilePath(book))) === fileBefore,
    "🔴 the stored epub is byte-identical after a health check",
  );
  assert(
    fs.statSync(bookFilePath(book)).mtimeMs === mtimeBefore,
    "the file was not even rewritten",
  );
  assert(row.sha256 === rowBefore.sha256, "🔴 books.sha256 unchanged");
  assert(row.partial_md5 === rowBefore.partial_md5, "🔴 books.partial_md5 (the sync key) unchanged");
  assert(row.updated_at === rowBefore.updated_at, "updated_at not bumped — a cache fill is not an edit");
}

// A stale version is not trusted.
db.prepare(`UPDATE books SET health_json = ? WHERE id = ?`).run(
  JSON.stringify({ version: 0, checkedAt: "2020-01-01T00:00:00Z", findings: [], stats: { spineDocs: 0, words: 0, tocEntries: null } }),
  book.id,
);
{
  const r = getBookHealth(book.id);
  assert(
    r != null && r.version === HEALTH_VERSION,
    "🔴 a cached report from an older HEALTH_VERSION is recomputed, not served",
  );
}

// The Re-check button's path recomputes even over a fresh-version cache —
// getBookHealth serving the cache and recheckBookHealth replacing it are the
// two halves that make the button meaningful.
db.prepare(`UPDATE books SET health_json = ? WHERE id = ?`).run(
  JSON.stringify({
    version: HEALTH_VERSION,
    checkedAt: "1999-01-01T00:00:00Z",
    findings: [],
    stats: { spineDocs: 0, words: 0, tocEntries: null },
  }),
  book.id,
);
{
  const served = getBookHealth(book.id);
  assert(
    served != null && served.checkedAt === "1999-01-01T00:00:00Z",
    "a current-version cache is served by the normal read",
  );
  const r = recheckBookHealth(book.id);
  assert(
    r != null && r.checkedAt !== "1999-01-01T00:00:00Z",
    "🔴 recheckBookHealth recomputes over a fresh-version cache — the Re-check button is not a no-op",
  );
  const row = rowOf(book.id);
  assert(
    row.health_json != null &&
      (JSON.parse(row.health_json) as { checkedAt: string }).checkedAt !== "1999-01-01T00:00:00Z",
    "…and stores the new report",
  );
}

// A missing file reports red but is never cached.
db.prepare(`UPDATE books SET health_json = NULL WHERE id = ?`).run(book.id);
fs.rmSync(bookFilePath(book));
{
  const r = getBookHealth(book.id);
  assert(
    r != null && r.findings.length === 1 && r.findings[0].code === "file-missing",
    "a missing file reports file-missing",
  );
  assert(
    rowOf(book.id).health_json == null,
    "🔴 …and is NOT cached — a volume restore must not be outlived by a stale verdict",
  );
}

process.chdir(os.tmpdir());
fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncheck:books:health FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:health OK");
