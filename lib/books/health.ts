import AdmZip from "adm-zip";
// Relative + explicit .ts so plain node can execute check-books-health.ts
// against the REAL module — the lib/books convention (see store.ts).
import { resolveSpine } from "./epubText.ts";
import { inspectEncryption } from "./adept.ts";
import { extractEpubMeta } from "./epubMeta.ts";
import {
  type LanguageVerdict,
  detectLanguage,
  tokenizeWords,
  tagLanguageCode,
  describeTag,
  MEASURED_LANGUAGES,
} from "./language.ts";

// EPUB health: a pure read over the stored bytes that answers "is this file
// actually a working book?" — rendered on /books/[id].
//
// Why it exists: every red check below is a failure that has already happened
// here or is one upload away. The DRM gate (prepare.ts) stops ADEPT files at
// UPLOAD — but a book ingested before that gate shipped can be sitting in the
// catalog right now as the "34-page ghost": ciphertext spine docs, a garbage
// word count, a catch-up search that finds nothing, every layer reporting
// success. This module is the retroactive sweep the upload-time gate can't be.
//
// 🔴 DIAGNOSES, NEVER REPAIRS. A "fixed" file is new bytes → new partial_md5 →
// detached sync on every device at once (BOOKS_PLAN §4). Everything here is a
// read; the only remedy this feature ever offers is "replace the file, which
// is a new book". check:books:health asserts the persistence path leaves the
// file, its sha256 and its partial_md5 untouched.
//
// 🔴 Pure in the stats.ts sense: no DB, no fs, no clock — bytes in, report
// out — so the gate can drive it with in-memory fixtures whose answer is
// known independently. `checkedAt` is stamped by the impure edge
// (healthData.ts / ingest), never here.
//
// Every finding is a MEASUREMENT with its number, never a vibe — the house
// honesty convention. Severities:
//   red   — the file is likely broken as a book (ciphertext, no text,
//           unreadable structure)
//   amber — readable but degraded (mojibake, OCR damage, no chapters)
//   info  — worth a line, not a warning (no cover, no language tag, a book
//           that is not in English)

/** Bump to invalidate every cached report when a check changes — improved
 *  heuristics re-run instead of trusting a stale verdict forever. */
export const HEALTH_VERSION = 3;

export type HealthSeverity = "red" | "amber" | "info";

export type HealthCode =
  | "unreadable-zip"
  | "unreadable-structure"
  | "encrypted-content"
  | "unreadable-spine-docs"
  | "no-text"
  | "sparse-text"
  | "mojibake"
  | "artifact-characters"
  | "ocr-artifacts"
  | "no-toc"
  | "sparse-toc"
  | "no-cover"
  | "no-language"
  | "not-english"
  | "language-mismatch"
  | "image-heavy"
  | "file-missing"; // emitted by healthData.ts, never by checkEpubHealth

export type HealthFinding = {
  code: HealthCode;
  severity: HealthSeverity;
  /** One line, always carrying the measurement. */
  summary: string;
  /** Optional second line: where, or what it costs on the device. */
  detail?: string;
};

export type EpubHealth = {
  version: number;
  findings: HealthFinding[];
  /** Context the UI prints even when clean. */
  stats: {
    spineDocs: number;
    words: number;
    /** null = no NCX and no EPUB3 nav found. */
    tocEntries: number | null;
  };
};

// --- thresholds, named so the gate and the UI copy can reason about them ---

/** Below this, "no chapters" is not worth flagging — a short story doesn't
 *  need a TOC. */
const TOC_MATTERS_WORDS = 10_000;
/** A book with readable structure but fewer words than this gets an amber —
 *  virtually no real book is under it; a ghost or a stub is. */
const SPARSE_TEXT_WORDS = 1_000;
/** Artifact/mojibake counts at or above this are amber; below, info. */
const NOISE_AMBER_COUNT = 10;
/** OCR signals: ignore fewer than this (dialect, stylistic oddities). */
const OCR_MIN_TOTAL = 5;
/** OCR signals: amber at this rate per 10k words. Deliberately NOT also an
 *  absolute count — see the severity line below. */
const OCR_AMBER_PER_10K = 5;
/** image-heavy: file at least this big AND this many bytes per word. */
const IMAGE_HEAVY_MIN_BYTES = 5 * 1024 * 1024;
const IMAGE_HEAVY_BYTES_PER_WORD = 150;

const SEVERITY_ORDER: Record<HealthSeverity, number> = { red: 0, amber: 1, info: 2 };

// Elements whose contents are not prose — same rule as epubText.ts.
const NON_PROSE = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Tag-stripped, entity-decoded text of one XHTML document. Unknown named
 *  entities become "w" (a word-ish placeholder that can't trip the artifact
 *  patterns), mirroring epubText.ts's counting behaviour. */
function extractText(xhtml: string): string {
  return xhtml
    .replace(NON_PROSE, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(?:nbsp);/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;/gi, "w");
}

/**
 * Is this spine entry readable text at all? The discriminator for the ghost:
 * ciphertext stored under an .xhtml name.
 *
 * 🔴 Not the "<" canary — adept.ts measured that random bytes carry a "<"
 * within 1 KB ~98% of the time. Two stronger signals together: a multi-char
 * structural tag near the top (noise never spells "<html"), and a low
 * U+FFFD density (ciphertext decoded as UTF-8 is dense with replacement
 * characters, real markup has almost none).
 */
function looksLikeMarkup(doc: string): boolean {
  const head = doc.slice(0, 4096);
  if (!/<(?:\?xml|!doctype|html|head|body|section|div|p)\b/i.test(head)) return false;
  let bad = 0;
  for (const ch of head) if (ch === "\ufffd") bad++;
  return bad / Math.max(head.length, 1) < 0.05;
}

// Mojibake: UTF-8 read as Latin-1. "â€" is the E2 80 prefix of every curly
// quote/dash/ellipsis; "Ã"/"Â" + a char in U+0080–U+00BF are the C3/C2
// two-byte sequences (Ã© = é, Â  = nbsp). None of these pairs occur in real
// prose, which is what makes the patterns high-precision.
const MOJIBAKE = [/\u00e2\u20ac/g, /\u00c3[\u0080-\u00bf]/g, /\u00c2[\u0080-\u00bf]/g];

// OCR "scannos": tokens that are not words in any register of English and are
// classic h/li, t/b confusions. Language-gated — see `english` below.
const SCANNO_WORDS =
  /\b(?:tbe|tlie|tliat|tbat|tbis|witli|wliich|wlien|wben|wbo|sbe|liave|bave|tban|beeu|liere|tliere|otber|anotber|cliapter)\b/gi;

type DocText = { index: number; text: string };

function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s) !== null) n++;
  return n;
}

/** U+FFFD, U+FFFC, C0 controls (minus tab/LF/CR), and private-use-area
 *  codepoints — each renders as a box or worse on the device. */
function countArtifactChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd || c === 0xfffc) n++;
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) n++;
    else if (c >= 0xe000 && c <= 0xf8ff) n++;
  }
  return n;
}

/** Spine documents that must carry the stray-letter signal before it counts
 *  as damage rather than subject matter. Below this many, a book is too few
 *  files for "spread" to mean anything and the share test is skipped. */
const STRAY_MIN_DOCS = 8;
/** 🔴 Share of documents that must show stray letters. MEASURED on a real
 *  book: The Return of the King carries 104 of them and 94 sit in ONE file —
 *  Appendix E, "Writing and Spelling", an essay whose SUBJECT is individual
 *  letters ("C has always the value of k even before e and i"). 7 of its 132
 *  documents show the signal, 5%. A scanned book is damaged in every chapter,
 *  not in one appendix, so spread is what separates damage from subject. */
const STRAY_MIN_DOC_SHARE = 0.25;

/**
 * Stray single letters — the weakest of the four OCR signals and the one that
 * false-positives on perfectly good books, so it is the one with rules.
 *
 * 🔴 Every exclusion here came from a real file (Return of the King, 210k
 * words), which reported 278 "OCR-style artifacts" and had NO OCR damage at
 * all. What it actually had:
 *   - 78 abbreviations and elisions — "see p. 1351", "c . 1600" (circa),
 *     hobbit dialect "a lot o' beer", "one of them 's in charge". Stripping
 *     the trailing punctuation turned each into a bare letter. A real OCR
 *     split ("t he") leaves NO punctuation attached, so requiring a bare
 *     token costs the true signal nothing.
 *   - 96 more of the `c .` form, where this file's typesetting puts a space
 *     before the period, so the abbreviation arrives as two tokens.
 *   - 94 in Appendix E, which discusses letters AS letters.
 * Measured after these rules: real English prose (Alice, Pride and Prejudice,
 * Madame Bovary) scores 0.0 per 10k, Return of the King scores 0, and text
 * with one split word per 100 scores 29.
 */
function countStrayLetters(docs: DocText[]): number {
  let total = 0;
  let docsWithHits = 0;
  for (const doc of docs) {
    const toks = doc.text.split(/\s+/);
    let hits = 0;
    toks.forEach((tok, i) => {
      const bare = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (bare.length !== 1 || !/[b-hj-z]/.test(bare)) return;
      // Punctuation attached => an abbreviation ("p.") or an elision ("o'"),
      // not a letter stranded by a broken scan.
      if (tok !== bare) return;
      // The same abbreviation with a space before its stop ("c . 1600").
      if (/^[.,]$/.test(toks[i + 1] ?? "")) return;
      hits++;
    });
    if (hits > 0) docsWithHits++;
    total += hits;
  }
  // 🔴 Concentrated in a file or two => subject matter, not damage.
  if (docs.length >= STRAY_MIN_DOCS && docsWithHits / docs.length < STRAY_MIN_DOC_SHARE) {
    return 0;
  }
  return total;
}

function per10k(count: number, words: number): number {
  return words > 0 ? (count / words) * 10_000 : 0;
}

function fmtRate(count: number, words: number): string {
  const r = per10k(count, words);
  return r >= 10 ? String(Math.round(r)) : r.toFixed(1);
}

/** Container → OPF, the same resolution epubText's resolveSpine does
 *  internally — needed here for the manifest (TOC discovery). */
function readOpf(
  readText: (name: string) => string | null,
): { opf: string; opfDir: string } | null {
  const container = readText("META-INF/container.xml");
  const opfPath = container?.match(/full-path=["']([^"']+)["']/i)?.[1];
  if (!opfPath) return null;
  const opf = readText(opfPath);
  if (!opf) return null;
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  return { opf, opfDir };
}

function joinPath(dir: string, href: string): string {
  if (!dir || href.startsWith("/")) return href.replace(/^\//, "");
  const parts = (dir + href).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** Entries in the book's own navigation: max of the NCX navPoint count and
 *  the EPUB3 toc-nav anchor count. null when neither exists. */
function countTocEntries(readText: (name: string) => string | null): number | null {
  const resolved = readOpf(readText);
  if (!resolved) return null;
  const { opf, opfDir } = resolved;

  let best: number | null = null;
  const items = opf.match(/<(?:[A-Za-z0-9]+:)?item\b[^>]*>/gi) ?? [];

  const ncxItem = items.find(
    (t) => /media-type=["']application\/x-dtbncx\+xml["']/i.test(t) || /href=["'][^"']*\.ncx["']/i.test(t),
  );
  const ncxHref = ncxItem?.match(/\shref=["']([^"']+)["']/i)?.[1];
  if (ncxHref) {
    const ncx = readText(joinPath(opfDir, decodeURIComponent(ncxHref)));
    if (ncx) best = countMatches(/<(?:[A-Za-z0-9]+:)?navPoint\b/gi, ncx);
  }

  const navItem = items.find((t) => /properties=["'][^"']*\bnav\b[^"']*["']/i.test(t));
  const navHref = navItem?.match(/\shref=["']([^"']+)["']/i)?.[1];
  if (navHref) {
    const navDoc = readText(joinPath(opfDir, decodeURIComponent(navHref)));
    const tocNav = navDoc?.match(
      /<nav\b[^>]*epub:type=["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i,
    )?.[1];
    if (tocNav) {
      const anchors = countMatches(/<a\b/gi, tocNav);
      if (best == null || anchors > best) best = anchors;
    }
  }
  return best;
}

/**
 * The health check. One pass over the bytes; every check that could not run
 * (because a structural failure precedes it) is skipped rather than reported
 * as clean — a broken file gets its one true red finding, not a pile of
 * downstream noise.
 */
export function checkEpubHealth(bytes: Buffer): EpubHealth {
  const findings: HealthFinding[] = [];
  const emptyStats = { spineDocs: 0, words: 0, tocEntries: null };

  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    return {
      version: HEALTH_VERSION,
      findings: [
        {
          code: "unreadable-zip",
          severity: "red",
          summary: "Not a readable zip archive — devices cannot open this file at all.",
        },
      ],
      stats: emptyStats,
    };
  }

  const entries = zip.getEntries();
  const byName = new Map(entries.map((e) => [e.entryName.replace(/^\.?\//, ""), e]));
  const readText = (name: string): string | null => {
    const entry = byName.get(name.replace(/^\.?\//, ""));
    if (!entry) return null;
    try {
      return entry.getData().toString("utf8");
    } catch {
      return null;
    }
  };

  // Encryption — reuses adept.ts's classifier so this check and the upload
  // gate can never disagree about the font-obfuscation line (font mangling is
  // NOT DRM and must not be flagged).
  const enc = inspectEncryption(bytes);
  if (enc.kind === "adept") {
    findings.push({
      code: "encrypted-content",
      severity: "red",
      summary: `Adobe DRM (ADEPT) is still present — ${enc.encryptedPaths.length} content ${
        enc.encryptedPaths.length === 1 ? "entry is" : "entries are"
      } ciphertext, not prose.`,
      detail:
        "This file predates the upload-time DRM gate. Word count, catch-up search and the device text are all garbage.",
    });
  } else if (enc.kind === "unknown") {
    findings.push({
      code: "encrypted-content",
      severity: "red",
      summary:
        "encryption.xml declares an algorithm this hub doesn't recognise — content may be unreadable.",
    });
  }

  // Spine. Falls back to every XHTML in the archive (like epubText.ts) so the
  // text checks still run on a structurally broken file.
  const spine = resolveSpine(readText);
  const structureBroken = spine.length === 0;
  if (structureBroken) {
    findings.push({
      code: "unreadable-structure",
      severity: "red",
      summary:
        "EPUB structure unreadable — container.xml / OPF / spine failed to resolve, so readers must guess the reading order.",
    });
  }
  const docs = structureBroken
    ? entries.filter((e) => /\.(x?html|htm)$/i.test(e.entryName)).map((e) => e.entryName)
    : spine;

  // Per-document readability + text extraction.
  const readable: DocText[] = [];
  const unreadableDocs: number[] = [];
  let missingDocs = 0;
  docs.forEach((name, i) => {
    const raw = readText(name);
    if (raw == null) {
      missingDocs++;
      unreadableDocs.push(i + 1);
      return;
    }
    if (!looksLikeMarkup(raw)) {
      unreadableDocs.push(i + 1);
      return;
    }
    readable.push({ index: i + 1, text: extractText(raw) });
  });

  // 🔴 Suppressed when ADEPT already fired: the ciphertext docs and the DRM
  // are the same fact, and two red findings for one cause reads as two
  // problems.
  if (unreadableDocs.length > 0 && enc.kind !== "adept") {
    findings.push({
      code: "unreadable-spine-docs",
      severity: "red",
      summary: `${unreadableDocs.length} of ${docs.length} spine documents are not readable text — the file may be corrupt or still encrypted.`,
      detail:
        (missingDocs > 0 ? `${missingDocs} missing from the archive entirely. ` : "") +
        `Affected: spine document${unreadableDocs.length === 1 ? "" : "s"} ${unreadableDocs
          .slice(0, 8)
          .join(", ")}${unreadableDocs.length > 8 ? ", …" : ""} of ${docs.length}.`,
    });
  }

  const words = readable.reduce((n, d) => n + (d.text.match(/\S+/g)?.length ?? 0), 0);
  const hasRedCause = findings.some((f) => f.severity === "red");

  // Text volume — skipped when a red cause already explains the absence.
  if (!hasRedCause) {
    if (words === 0) {
      findings.push({
        code: "no-text",
        severity: "red",
        summary: `No readable prose in any of the ${docs.length} spine document${docs.length === 1 ? "" : "s"}.`,
      });
    } else if (words < SPARSE_TEXT_WORDS) {
      findings.push({
        code: "sparse-text",
        severity: "amber",
        summary: `Only ${words.toLocaleString()} words of prose across ${docs.length} spine document${
          docs.length === 1 ? "" : "s"
        } — check this file on a device.`,
      });
    }
  }

  // Character-level damage, measured over the readable text only (counting a
  // ciphertext doc's noise here would drown the signal from the real prose).
  const meta = extractEpubMeta(bytes);
  const declaredCode = tagLanguageCode(meta.language);
  // The language verdict, when there is text to measure it on. Shared by
  // the OCR gate below and the findings after it, so the report can never
  // gate on one answer and print another.
  let language: LanguageVerdict | null = null;
  if (words > 0) {
    const fullText = readable.map((d) => d.text).join("\n");
    language = detectLanguage(tokenizeWords(fullText));

    const mojibake = MOJIBAKE.reduce((n, re) => n + countMatches(re, fullText), 0);
    if (mojibake > 0) {
      findings.push({
        code: "mojibake",
        severity: mojibake >= NOISE_AMBER_COUNT ? "amber" : "info",
        summary: `${mojibake.toLocaleString()} mojibake sequence${mojibake === 1 ? "" : "s"} (UTF-8 read as Latin-1: â€™, Ã©, …) — ${fmtRate(mojibake, words)} per 10k words.`,
      });
    }

    const perDocArtifacts = readable
      .map((d) => ({ index: d.index, count: countArtifactChars(d.text) }))
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count);
    const artifacts = perDocArtifacts.reduce((n, d) => n + d.count, 0);
    if (artifacts > 0) {
      findings.push({
        code: "artifact-characters",
        severity: artifacts >= NOISE_AMBER_COUNT ? "amber" : "info",
        summary: `${artifacts.toLocaleString()} artifact character${artifacts === 1 ? "" : "s"} (replacement marks, controls, private-use glyphs) — these render as boxes on the device.`,
        detail: `Worst: ${perDocArtifacts
          .slice(0, 3)
          .map((d) => `spine document ${d.index} (${d.count}×)`)
          .join(", ")} of ${docs.length}.`,
      });
    }

    // OCR damage. Digit-in-word and split hyphens are language-neutral; the
    // scanno list and lone-letter test are English facts, so they only run
    // on an English book.
    //
    // 🔴 Gated on the MEASURED language, with the declared tag only as the
    // fallback when there is too little text to measure. Gating on the tag
    // was the original implementation and it fails in both directions on
    // exactly the files that need it most: a Spanish novel tagged en scores
    // a "stray single letter" on every "y" and "o" in the book, and an
    // English novel tagged de silently skips the scanno list that would
    // have caught its OCR damage.
    const english = language.isEnglish ?? (declaredCode == null || declaredCode === "en");
    const digitWords = countMatches(/[a-z][01][a-z]/g, fullText);
    const hyphenBreaks = countMatches(/[a-z]- [a-z]/g, fullText);
    let scannos = 0;
    let loneLetters = 0;
    if (english) {
      scannos = countMatches(SCANNO_WORDS, fullText);
      loneLetters = countStrayLetters(readable);
    }
    const ocrTotal = digitWords + hyphenBreaks + scannos + loneLetters;
    if (ocrTotal >= OCR_MIN_TOTAL) {
      const parts = [
        digitWords > 0 ? `digit-in-word ${digitWords}` : null,
        hyphenBreaks > 0 ? `split hyphens ${hyphenBreaks}` : null,
        scannos > 0 ? `scanno words ${scannos}` : null,
        loneLetters > 0 ? `stray single letters ${loneLetters}` : null,
      ].filter((p): p is string => p != null);
      findings.push({
        code: "ocr-artifacts",
        // 🔴 Severity is a RATE, never an absolute count. The old rule was
        // `total >= 50 || rate >= 5`, and the absolute half made EVERY long
        // book amber on its own length: 50 hits in a 210k-word book is 2.4
        // per 10k, which is nothing.
        severity: per10k(ocrTotal, words) >= OCR_AMBER_PER_10K ? "amber" : "info",
        summary: `${ocrTotal.toLocaleString()} OCR-style artifacts — ${fmtRate(ocrTotal, words)} per 10k words. Likely a scanned or re-ripped source.`,
        detail: parts.join(" · ") + ".",
      });
    }
  }

  // Chapters. Only meaningful on a book long enough to need them, and only
  // when the structure resolved (a broken OPF already failed above).
  let tocEntries: number | null = null;
  if (!structureBroken) {
    tocEntries = countTocEntries(readText);
    if (!hasRedCause && words >= TOC_MATTERS_WORDS) {
      if (tocEntries == null) {
        findings.push({
          code: "no-toc",
          severity: "amber",
          summary: "No table of contents — the device can't jump chapters in this book.",
          detail:
            docs.length === 1
              ? "The whole book is a single file with no NCX or EPUB3 nav document."
              : "No NCX or EPUB3 nav document in the manifest.",
        });
      } else if (tocEntries <= 2) {
        findings.push({
          code: "sparse-toc",
          severity: "amber",
          summary: `Table of contents has only ${tocEntries} entr${tocEntries === 1 ? "y" : "ies"} for a ${Math.round(words / 1000)}k-word book.`,
        });
      }
    }
  }

  // Info-tier facts — skipped entirely under a red cause (recomputed, since
  // no-text can have fired above), because "no cover" on a file full of
  // ciphertext is noise.
  if (!findings.some((f) => f.severity === "red")) {
    if (meta.cover == null) {
      findings.push({
        code: "no-cover",
        severity: "info",
        summary: "No embedded cover image — the grid and the device list show a text tile instead.",
      });
    }
    if (meta.language == null) {
      findings.push({
        code: "no-language",
        severity: "info",
        summary:
          "No language tag (dc:language) — device hyphenation and dictionary lookup may misbehave.",
      });
    }

    // Is this actually an English book? Two separate facts, at most one
    // finding: the text is not English (info — a real fact about a library
    // that is otherwise entirely English), or the text and the dc:language
    // tag DISAGREE (amber — one of them is wrong, and the device trusts the
    // tag for hyphenation and dictionary).
    //
    // 🔴 Silent when the verdict is null. Under MIN_WORDS_FOR_VERDICT, or in
    // the middle band where nothing scores like prose, there is no claim to
    // make — an unnameable book gets no accusation, and the OCR gate above
    // quietly falls back to the declared tag.
    if (language != null && language.isEnglish != null) {
      const measured = language.name;
      const enPct = `${(language.englishRate * 100).toFixed(language.englishRate < 0.1 ? 1 : 0)}%`;
      const rates =
        language.script != null
          ? `${language.script} script`
          : language.isEnglish
            ? `${enPct} English function words`
            : measured != null
              ? `${(language.bestRate * 100).toFixed(0)}% ${measured} function words against ${enPct} English`
              : `${enPct} English function words`;
      const declaredName = meta.language != null ? describeTag(meta.language) : null;
      // 🔴 Only ever accuse the TAG when the text can be NAMED. Text that
      // matches no known language is far more likely to be damaged, or in a
      // language this check cannot measure, than to be proof the tag lies —
      // and 'tagged English, reads as some other language' claims something
      // no measurement here supports. Unnameable text falls through to the
      // info line below, which states only the number.
      const nameable = language.code != null || language.script != null;
      const tagDisagrees =
        declaredCode != null &&
        nameable &&
        (language.isEnglish
          ? declaredCode !== "en"
          : declaredCode === "en" || (language.code != null && declaredCode !== language.code));

      if (tagDisagrees) {
        findings.push({
          code: "language-mismatch",
          severity: "amber",
          summary: `Tagged ${declaredName}, but the text reads as ${
            language.isEnglish ? "English" : (measured ?? "some other language")
          } — ${rates}.`,
          detail:
            "The device picks hyphenation and dictionary lookup from the tag, so both are wrong for this book. Fix the language in Edit details.",
        });
      } else if (!language.isEnglish) {
        findings.push({
          code: "not-english",
          severity: "info",
          summary:
            measured != null
              ? `Not an English book — the text reads as ${measured} (${rates}).`
              : `The text does not read as English prose — only ${rates}, where real English runs 40–60%.`,
          detail:
            measured != null
              ? "The English-only OCR checks in this report were skipped."
              : `It matches none of the languages this check can name (${MEASURED_LANGUAGES.join(", ")}), so it may be in another language, or the text may be damaged. The English-only OCR checks were skipped.`,
        });
      }
    }
    if (
      words > 0 &&
      bytes.length >= IMAGE_HEAVY_MIN_BYTES &&
      bytes.length / words >= IMAGE_HEAVY_BYTES_PER_WORD
    ) {
      findings.push({
        code: "image-heavy",
        severity: "info",
        summary: `${(bytes.length / (1 << 20)).toFixed(1)} MB for ${words.toLocaleString()} words — the size is mostly images, fonts or media.`,
      });
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    version: HEALTH_VERSION,
    findings,
    stats: { spineDocs: docs.length, words, tocEntries },
  };
}
