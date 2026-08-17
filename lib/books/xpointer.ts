import AdmZip from "adm-zip";
import { resolveSpine } from "./epubText.ts";

// Catch-up positioning: find a heard phrase in an epub and synthesize the
// CRengine x-pointer for the paragraph where it starts, so a position reached
// in the audiobook edition can be written to kosync and picked up by the
// device on its next sync.
//
// 🔴 This is the ONE place a kosync `progress` value is ever CONSTRUCTED
// rather than stored opaquely. The opacity rule in kosync.ts stands for every
// device-written pointer — nothing here parses or rewrites those. What this
// module does is emit NEW pointers in the exact dialect CrossPoint itself
// writes, which was validated byte-for-byte before this shipped: for all three
// paragraph-level pointers real devices had synced to production
// (/body/DocFragment[6]/body/p[21] — Jonathan Strange,
//  /body/DocFragment[11]/body/section[1]/p[105] — The Two Towers,
//  /body/DocFragment[17]/body/p[1] — The Little Drummer Girl),
// regenerating the pointer from the epub bytes reproduced the device's own
// string exactly. check:books:xpointer pins the dialect against an
// independent Python implementation over the committed fixture.
//
// The dialect, as established from those device pointers:
//   /body/DocFragment[N]/body/<path>/p[K]
//   - DocFragment[N]: 1-based index over the FULL OPF spine (every itemref,
//     including cover/front-matter docs — not just chapter-sized ones).
//   - <path>: element steps from the document's <body> down to the paragraph,
//     each step indexed 1-based among same-TAG siblings (section[1], p[105]).
//     A paragraph-level pointer is what CrossPoint emits natively; Readest
//     appends /text()[i].offset, which we deliberately do NOT synthesize —
//     paragraph resolution is what a heard phrase justifies.
//
// 🔴 The SEARCH is built for dictation, not for copy-paste. The phrase arrives
// by ear — spoken into the phone while the audiobook plays — so it comes with
// no punctuation, approximate spelling, missing words, and the odd extra one.
// Substring matching is the wrong tool for that input. This is the same
// problem the chart viewer's voice-follow solved (lib/lyric-follow.ts), and
// the same solution: word-level alignment with tiered fuzzy equality (exact /
// shared-prefix ≥4 / one edit for ≥5-char words — mirrored from wordsMatch
// there), run as a FITTING alignment: the whole query must align, but it may
// start anywhere in the book, and skipped or inserted words cost rather than
// disqualify. Diacritics are folded on both sides (heard "smeagol", printed
// "Sméagol") — lyric-follow never needed that because charts are typed by the
// same person who sings them.
//
// 🔴 Reads only. The file is unzipped in memory and never touched — same
// contract as epubText.ts, and the reason a catch-up can never move a book's
// partial_md5 out from under the very sync it's trying to update.

export type PositionCandidate = {
  /** The synthesized x-pointer, in CrossPoint's own dialect. */
  pointer: string;
  /** Word-based fraction of the whole book at the matched phrase. */
  percentage: number;
  /** Context around the match for the user to confirm against. */
  snippet: string;
  /** 1-based spine index (the DocFragment number). */
  docIndex: number;
  /** Alignment quality 0..1 (1 = every query word matched exactly). */
  confidence: number;
  /** How many query words found a (fuzzy) partner. */
  matchedWords: number;
};

export type PhraseSearchResult = {
  candidates: PositionCandidate[];
  totalWords: number;
  queryWords: number;
};

const VOID_TAGS = new Set([
  "br", "img", "hr", "meta", "link", "input", "area", "base", "col",
  "embed", "source", "track", "wbr", "param",
]);

const NON_PROSE_TAGS = new Set(["script", "style", "head"]);

type Paragraph = {
  /** Pointer path from the document body, e.g. "body/section[1]/p[105]". */
  path: string;
  /** Character offset of the opening <p> tag in the (comment-blanked) xhtml. */
  startOffset: number;
  /** The paragraph's text content, whitespace-collapsed. */
  text: string;
};

/** Replace comments with spaces of equal length so offsets stay stable. */
function blankComments(xhtml: string): string {
  return xhtml.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
}

/**
 * Walk one XHTML document and give every <p> its CRengine path. The path
 * indexes each element 1-based among siblings of the SAME tag, from <body>
 * down — the shape validated against real device pointers above.
 */
export function paragraphsOf(xhtml: string): Paragraph[] {
  const src = blankComments(xhtml);
  const out: Paragraph[] = [];

  // Each frame: the element's path segment and its per-child-tag counters.
  const stack: Array<{ seg: string; counts: Map<string, number> }> = [];
  let inBody = false;
  let skipDepth = 0;

  // Open paragraph being captured (top-most only; books don't nest <p>).
  let open: { path: string; startOffset: number; parts: string[]; depth: number } | null = null;

  const token = /<[^>]*>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(src)) !== null) {
    const tok = m[0];
    if (tok[0] !== "<") {
      if (inBody && skipDepth === 0 && open) open.parts.push(tok);
      continue;
    }
    const name = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(tok)?.[1]?.toLowerCase();
    if (!name) continue;
    const closing = tok.startsWith("</");
    const selfClosing = /\/\s*>$/.test(tok) || VOID_TAGS.has(name);

    if (name === "body") {
      if (!closing) {
        inBody = true;
        stack.length = 0;
        stack.push({ seg: "body", counts: new Map() });
      } else {
        inBody = false;
      }
      continue;
    }
    if (!inBody) continue;

    if (NON_PROSE_TAGS.has(name)) {
      if (!closing && !selfClosing) skipDepth++;
      else if (closing && skipDepth > 0) skipDepth--;
      continue;
    }

    if (!closing) {
      if (selfClosing) continue; // occupies no path step, can't contain a <p>
      const parent = stack[stack.length - 1];
      if (!parent) continue;
      const n = (parent.counts.get(name) ?? 0) + 1;
      parent.counts.set(name, n);
      stack.push({ seg: `${name}[${n}]`, counts: new Map() });
      if (name === "p" && !open) {
        open = {
          path: stack.map((f) => f.seg).join("/"),
          startOffset: m.index,
          parts: [],
          depth: stack.length,
        };
      }
    } else {
      // Pop to the matching open tag if it's on the stack (tolerates the
      // stray unbalanced close a hand-made epub sometimes carries).
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].seg.startsWith(`${name}[`)) {
          stack.length = i;
          break;
        }
      }
      if (open && stack.length < open.depth) {
        out.push({
          path: open.path,
          startOffset: open.startOffset,
          text: open.parts.join(" ").replace(/\s+/g, " ").trim(),
        });
        open = null;
      }
    }
  }
  return out;
}

/** Same word definition as epubText's counter: runs of non-whitespace. */
function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

/** Strip tags the way epubText does, so prefix word counts share its units. */
function stripToProse(xhtml: string): string {
  return xhtml
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, "w");
}

/**
 * Dictation-grade word normalization: fold diacritics, drop apostrophes,
 * strip everything non-alphanumeric. The lyric-follow normalizeWord plus the
 * diacritic fold (heard words carry no accents).
 */
export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la === lb) {
      i++;
      j++;
    } else if (la > lb) {
      i++;
    } else {
      j++;
    }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/** lyric-follow's tiers: exact / shared prefix ≥4 / one edit for ≥5 chars. */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (a.length >= 5 && b.length >= 5) return withinOneEdit(a, b);
  return false;
}

// Fitting-alignment scoring. A perfect word is worth MATCH_EXACT; the accept
// threshold is a fraction of the perfect score, so longer phrases tolerate
// proportionally more damage.
const MATCH_EXACT = 2.0;
const MATCH_FUZZY = 1.4;
const MISMATCH = -0.8;
const GAP = -0.7; // a word the book has and the ear missed, or vice versa
const ACCEPT_FRACTION = 0.5;
const MIN_QUERY_WORDS = 3;
const CANDIDATE_SEPARATION_WORDS = 25;
const MAX_CANDIDATES = 6;

type StreamWord = {
  norm: string;
  para: number; // index into the flat paragraph list
  charStart: number; // offset of the word in its paragraph's text
};

type FlatParagraph = {
  docIndex: number; // 1-based DocFragment number
  path: string;
  text: string;
  /** Word-based fraction of the book at this paragraph's start. */
  baseFraction: number;
  /** Words-per-book-fraction step for one word inside this paragraph. */
  wordFraction: number;
};

/**
 * Search an epub for a heard phrase. Returns candidates ordered by alignment
 * score. Null only when the epub itself can't be read.
 */
export function findPhrase(bytes: Buffer, phrase: string, limit = MAX_CANDIDATES): PhraseSearchResult | null {
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    return null;
  }
  const byName = new Map(zip.getEntries().map((e) => [e.entryName.replace(/^\.?\//, ""), e]));
  const readText = (name: string): string | null => {
    const entry = byName.get(name.replace(/^\.?\//, ""));
    if (!entry) return null;
    try {
      return entry.getData().toString("utf8");
    } catch {
      return null;
    }
  };

  const spine = resolveSpine(readText);
  if (spine.length === 0) return null;

  // Flatten the book: paragraphs with pointer paths + a global word stream.
  const paras: FlatParagraph[] = [];
  const stream: StreamWord[] = [];
  let totalWords = 0;
  const docData: Array<{ paras: Paragraph[]; blanked: string; words: number } | null> = [];
  for (const name of spine) {
    const xhtml = readText(name);
    if (!xhtml) {
      docData.push(null);
      continue;
    }
    const blanked = blankComments(xhtml);
    const words = countWords(stripToProse(blanked));
    docData.push({ paras: paragraphsOf(xhtml), blanked, words });
    totalWords += words;
  }
  if (totalWords === 0) return null;

  let wordsBefore = 0;
  for (let d = 0; d < docData.length; d++) {
    const doc = docData[d];
    if (!doc) continue;
    for (const para of doc.paras) {
      const wordsIntoDoc = countWords(stripToProse(doc.blanked.slice(0, para.startOffset)));
      const flatIndex = paras.length;
      paras.push({
        docIndex: d + 1,
        path: para.path,
        text: para.text,
        baseFraction: (wordsBefore + wordsIntoDoc) / totalWords,
        wordFraction: 1 / totalWords,
      });
      // Word offsets within the paragraph text, for snippets + percentages.
      const re = /\S+/g;
      let w: RegExpExecArray | null;
      while ((w = re.exec(para.text)) !== null) {
        const norm = normalizeWord(w[0]);
        if (norm) stream.push({ norm, para: flatIndex, charStart: w.index });
      }
    }
    wordsBefore += doc.words;
  }

  const query = phrase.split(/\s+/).map(normalizeWord).filter(Boolean);
  const Q = query.length;
  if (Q < MIN_QUERY_WORDS || stream.length === 0) {
    return { candidates: [], totalWords, queryWords: Q };
  }

  // Fitting alignment: the query aligns in full, anywhere in the stream.
  // D[i][j] = best score aligning query[0..i) ending at stream position j,
  // with free leading/trailing stream. Two columns, plus per-cell tracking of
  // the window start and the matched-word count.
  const N = stream.length;
  const prevScore = new Float64Array(Q + 1);
  const curScore = new Float64Array(Q + 1);
  const prevStart = new Int32Array(Q + 1);
  const curStart = new Int32Array(Q + 1);
  const prevCnt = new Int16Array(Q + 1);
  const curCnt = new Int16Array(Q + 1);
  for (let i = 1; i <= Q; i++) {
    prevScore[i] = i * GAP; // query words before the stream even starts
    prevStart[i] = 0;
  }

  type Hit = { score: number; start: number; end: number; matched: number };
  const hits: Hit[] = [];

  for (let j = 1; j <= N; j++) {
    const sw = stream[j - 1];
    curScore[0] = 0; // free leading stream
    curStart[0] = j;
    curCnt[0] = 0;
    for (let i = 1; i <= Q; i++) {
      const q = query[i - 1];
      const exact = q === sw.norm;
      const s = exact ? MATCH_EXACT : wordsMatch(q, sw.norm) ? MATCH_FUZZY : MISMATCH;
      const diag = prevScore[i - 1] + s;
      const up = curScore[i - 1] + GAP; // skip a query word
      const left = prevScore[i] + GAP; // skip a stream word
      if (diag >= up && diag >= left) {
        curScore[i] = diag;
        curStart[i] = prevStart[i - 1];
        curCnt[i] = prevCnt[i - 1] + (s > 0 ? 1 : 0);
      } else if (up >= left) {
        curScore[i] = up;
        curStart[i] = curStart[i - 1];
        curCnt[i] = curCnt[i - 1];
      } else {
        curScore[i] = left;
        curStart[i] = prevStart[i];
        curCnt[i] = prevCnt[i];
      }
    }
    const endScore = curScore[Q];
    if (endScore >= ACCEPT_FRACTION * MATCH_EXACT * Q) {
      hits.push({ score: endScore, start: curStart[Q], end: j, matched: curCnt[Q] });
    }
    prevScore.set(curScore);
    prevStart.set(curStart);
    prevCnt.set(curCnt);
  }

  // Best hit per neighbourhood: sort by score, then suppress anything within
  // CANDIDATE_SEPARATION_WORDS of an already-accepted window.
  hits.sort((a, b) => b.score - a.score || a.start - b.start);
  const accepted: Hit[] = [];
  for (const h of hits) {
    if (accepted.length >= limit) break;
    if (accepted.some((a) => Math.abs(a.start - h.start) < CANDIDATE_SEPARATION_WORDS)) continue;
    accepted.push(h);
  }

  const candidates: PositionCandidate[] = accepted.map((h) => {
    const startWord = stream[Math.min(h.start, N - 1)];
    const endWord = stream[Math.max(0, h.end - 1)];
    const para = paras[startWord.para];
    const snippetSource = para.text;
    const from = Math.max(0, startWord.charStart - 60);
    const sameParaEnd = endWord.para === startWord.para ? endWord.charStart + 20 : startWord.charStart + 160;
    const to = Math.min(snippetSource.length, Math.max(sameParaEnd, startWord.charStart + 80));
    // Percentage counts words before the paragraph plus words into it —
    // stream index within the paragraph is exactly that count.
    let wordsInto = 0;
    for (let k = h.start; k > 0 && stream[k - 1].para === startWord.para; k--) wordsInto++;
    return {
      pointer: `/body/DocFragment[${para.docIndex}]/${para.path}`,
      percentage: Math.min(1, para.baseFraction + wordsInto * para.wordFraction),
      snippet:
        (from > 0 ? "…" : "") +
        snippetSource.slice(from, to).trim() +
        (to < snippetSource.length ? "…" : ""),
      docIndex: para.docIndex,
      confidence: Math.max(0, Math.min(1, h.score / (MATCH_EXACT * Q))),
      matchedWords: h.matched,
    };
  });

  return { candidates, totalWords, queryWords: Q };
}

/**
 * Structural sanity for a pointer this module synthesized — the write route
 * refuses anything else, so a bug upstream can't smuggle garbage into
 * kosync_progress. Deliberately narrow: device-written pointers never pass
 * through here.
 */
export function isSynthesizedPointer(pointer: string): boolean {
  return /^\/body\/DocFragment\[\d+\]\/body(?:\/[a-z][a-z0-9]*\[\d+\])*\/p\[\d+\]$/.test(pointer);
}
