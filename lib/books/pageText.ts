import AdmZip from "adm-zip";
import { resolveSpine } from "./epubText.ts";

// The "current page" view: the epub's own text at the synced reading position,
// a page's worth at a time, for pointing Audible's camera page-sync at from a
// second screen (the phone that reads in Sheafs also runs Audible, so it can't
// point its camera at itself).
//
// 🔴 This is the one place a device-written `progress` string is PARSED. The
// opacity rule in kosync.ts still holds where it matters: nothing here writes,
// normalizes or stores a pointer — the stored value is read, resolved to a
// spot in the text for display, and thrown away. A pointer this module can't
// resolve degrades to the synced percentage; it never errors the page.
//
// The dialect (same as xpointer.ts, which was validated against real device
// pointers, and SheafsKit's XPointer/XHTMLConverter):
//   /body/DocFragment[N]/body/<steps>[/text()[k].offset]
//   - DocFragment[N]: 1-based over the FULL OPF spine (resolveSpine).
//   - steps: tag[n], 1-based among same-TAG siblings, from <body> down; a
//     missing index means 1.
//   - Sheafs always writes `text().offset`: the UTF-16 offset into the BLOCK's
//     whitespace-collapsed text (its own convention, text node 1 = the block).
//     CrossPoint writes the paragraph alone (no text()); Readest/KOReader write
//     `text()[k].offset` where k counts text nodes — read here as an offset into
//     the block too, which can land a few words early when k > 1.
//
// Blocks mirror SheafsKit's ElementRole so a Sheafs offset counts the same
// characters: p/h1–h6/li/pre/figcaption/caption/dt/dd/tr own a block; text
// directly inside a container (div, section, blockquote…) is an implicit block
// carrying the container's path; everything else is inline and flows through.
//
// 🔴 Reads only. Unzipped in memory, never written — same contract as
// epubText.ts / xpointer.ts.

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "figcaption", "caption", "dt", "dd", "tr",
]);
const CONTAINER_TAGS = new Set([
  "div", "section", "article", "aside", "nav", "header", "footer", "main", "blockquote",
  "ul", "ol", "table", "tbody", "thead", "tfoot", "figure", "dl", "center", "body",
  "address", "details", "summary", "form", "fieldset", "hgroup",
]);
const HIDDEN_TAGS = new Set(["script", "style", "head", "template", "title"]);
const VOID_TAGS = new Set([
  "br", "img", "hr", "meta", "link", "input", "area", "base", "col",
  "embed", "source", "track", "wbr", "param",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "­",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  sbquo: "‚", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", bull: "•",
  middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", sect: "§", para: "¶",
  dagger: "†", Dagger: "‡", prime: "′", Prime: "″", thinsp: " ", ensp: " ",
  emsp: " ", zwnj: "‌", zwj: "‍", times: "×", divide: "÷", frac12: "½",
  frac14: "¼", frac34: "¾", pound: "£", euro: "€", cent: "¢", yen: "¥", iexcl: "¡",
  iquest: "¿", szlig: "ß", aelig: "æ", AElig: "Æ", oelig: "œ", OElig: "Œ", eth: "ð",
  thorn: "þ", oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å", ccedil: "ç", Ccedil: "Ç",
  ntilde: "ñ", Ntilde: "Ñ",
};
// Accented vowels: &eacute; &Uuml; … built rather than listed.
for (const [mark, combining] of [
  ["acute", "́"], ["grave", "̀"], ["circ", "̂"], ["uml", "̈"], ["tilde", "̃"],
] as const) {
  for (const v of "aeiouyAEIOUY") NAMED_ENTITIES[v + mark] = (v + combining).normalize("NFC");
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export type TextBlock = {
  /** 0-based spine index. */
  doc: number;
  /** Element path from <body>, every step indexed: "body/section[1]/p[3]". */
  path: string;
  /** Characters of the same element's text before this block (text split by a nested block). */
  base: number;
  /** Whitespace-collapsed text; <br> is "\n". */
  text: string;
  heading: boolean;
  /** Global index of this block's first word. */
  wordStart: number;
  /** [start, end) character range of each word in `text`. */
  words: Array<[number, number]>;
};

type ElementMark = { block: number; char: number };

export type ParsedBook = {
  blocks: TextBlock[];
  totalWords: number;
  /** Per spine doc: path → where that element starts (block index + char in it). */
  elements: Array<Map<string, ElementMark>>;
  /** Per spine doc: [firstWord, endWord). */
  docWords: Array<[number, number]>;
};

/** Split one spine document into text blocks with their CREngine paths. */
export function blocksOf(xhtml: string, doc = 0): {
  blocks: Omit<TextBlock, "wordStart" | "words">[];
  elements: Map<string, ElementMark>;
} {
  const src = xhtml.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const blocks: Omit<TextBlock, "wordStart" | "words">[] = [];
  const elements = new Map<string, ElementMark>();
  const charsByPath = new Map<string, number>();

  type Frame = { tag: string; seg: string; counts: Map<string, number>; owner: boolean };
  const stack: Frame[] = [];
  let inBody = false;
  let hidden = 0;
  type Draft = Omit<TextBlock, "wordStart" | "words">;
  // Cast so the closures' writes aren't narrowed away to `null`.
  let current = null as Draft | null;

  const pathOf = (depth: number) => stack.slice(0, depth).map((f) => f.seg).join("/");
  const endBlock = () => {
    if (current) {
      current.text = current.text.replace(/ +$/, "");
      charsByPath.set(current.path, current.base + current.text.length);
      current = null;
    }
  };
  const appendText = (raw: string) => {
    let ownerDepth = stack.length;
    while (ownerDepth > 0 && !stack[ownerDepth - 1].owner) ownerDepth--;
    if (ownerDepth === 0) return;
    if (!current) {
      if (!/[^ \t\n\r\f]/.test(raw)) return; // inter-tag whitespace starts no block
      const path = pathOf(ownerDepth);
      current = {
        doc,
        path,
        base: charsByPath.get(path) ?? 0,
        text: "",
        heading: /^h[1-6]$/.test(stack[ownerDepth - 1].tag),
      };
      blocks.push(current);
    }
    for (const ch of raw) {
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
        if (current.text.length === 0 || current.text.endsWith(" ") || current.text.endsWith("\n")) continue;
        current.text += " ";
      } else {
        current.text += ch;
      }
    }
  };

  const token = /<[^>]*>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(src)) !== null) {
    const tok = m[0];
    if (tok[0] !== "<") {
      if (inBody && hidden === 0) appendText(decodeEntities(tok));
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
        stack.push({ tag: "body", seg: "body", counts: new Map(), owner: true });
        elements.set("body", { block: blocks.length, char: 0 });
      } else {
        endBlock();
        inBody = false;
      }
      continue;
    }
    if (!inBody) continue;

    if (name === "br" && !closing) {
      if (hidden === 0 && current && current.text.length > 0) {
        current.text = current.text.replace(/ +$/, "") + "\n";
      }
      continue;
    }

    const isOwner = BLOCK_TAGS.has(name) || CONTAINER_TAGS.has(name);
    if (!closing) {
      const parent = stack[stack.length - 1];
      if (!parent) continue;
      const n = (parent.counts.get(name) ?? 0) + 1;
      parent.counts.set(name, n);
      if (selfClosing) continue; // occupies a sibling index, holds no text
      if (isOwner) endBlock();
      // A table cell runs into its row's block; keep cells apart.
      if ((name === "td" || name === "th") && current && current.text && !current.text.endsWith(" ")) {
        current.text += " ";
      }
      stack.push({ tag: name, seg: `${name}[${n}]`, counts: new Map(), owner: isOwner });
      elements.set(pathOf(stack.length), {
        block: current ? blocks.length - 1 : blocks.length,
        char: current ? current.text.length : 0,
      });
      if (HIDDEN_TAGS.has(name)) hidden++;
    } else {
      // Pop to the matching open tag (tolerates a stray unbalanced close).
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === name) {
          const popped = stack.slice(i);
          if (popped.some((f) => f.owner)) endBlock();
          hidden = Math.max(0, hidden - popped.filter((f) => HIDDEN_TAGS.has(f.tag)).length);
          stack.length = i;
          break;
        }
      }
    }
  }
  endBlock();
  return { blocks, elements };
}

/** Parse every spine document of an epub. Null when the spine can't be read. */
export function parseBook(bytes: Buffer): ParsedBook | null {
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

  const blocks: TextBlock[] = [];
  const elements: Array<Map<string, ElementMark>> = [];
  const docWords: Array<[number, number]> = [];
  let totalWords = 0;
  for (let d = 0; d < spine.length; d++) {
    const xhtml = readText(spine[d]);
    const offset = blocks.length;
    const docStart = totalWords;
    if (xhtml) {
      const parsed = blocksOf(xhtml, d);
      for (const b of parsed.blocks) {
        const words: Array<[number, number]> = [];
        const re = /\S+/g;
        let w: RegExpExecArray | null;
        while ((w = re.exec(b.text)) !== null) words.push([w.index, w.index + w[0].length]);
        blocks.push({ ...b, wordStart: totalWords, words });
        totalWords += words.length;
      }
      const shifted = new Map<string, ElementMark>();
      for (const [path, mark] of parsed.elements) shifted.set(path, { block: mark.block + offset, char: mark.char });
      elements.push(shifted);
    } else {
      elements.push(new Map());
    }
    docWords.push([docStart, totalWords]);
  }
  return { blocks, totalWords, elements, docWords };
}

export type ParsedPointer = { doc: number; path: string; offset: number | null };

/** Parse a CREngine EPUB pointer. Null for anything not of that form. */
export function parsePointer(pointer: string): ParsedPointer | null {
  const s = pointer.trim();
  const m = /^\/body\/DocFragment(?:\[(\d+)\])?(\/.*)?$/.exec(s);
  if (!m) return null;
  const fragment = m[1] ? parseInt(m[1], 10) : 1;
  if (!(fragment >= 1)) return null;
  let rest = m[2] ?? "";
  let offset: number | null = null;
  const t = /\/text\(\)(?:\[\d+\])?(?:\.(\d+))?$/.exec(rest);
  if (t) {
    offset = t[1] != null ? parseInt(t[1], 10) : 0;
    rest = rest.slice(0, t.index);
  }
  const steps = rest.split("/").filter(Boolean);
  if (steps.length === 0) steps.push("body");
  const norm: string[] = [];
  for (const step of steps) {
    const sm = /^([a-zA-Z][a-zA-Z0-9:_-]*)(?:\[(\d+)\])?$/.exec(step);
    if (!sm) return null;
    norm.push(`${sm[1].toLowerCase()}[${sm[2] ?? "1"}]`);
  }
  // <body> is the root frame and carries no index in our paths.
  if (norm[0] !== "body[1]") return null;
  norm[0] = "body";
  return { doc: fragment - 1, path: norm.join("/"), offset };
}

export type Precision = "word" | "paragraph" | "percentage" | "none";

/** The global word a pointer (or, failing that, a percentage) names. */
export function resolvePosition(
  book: ParsedBook,
  pointer: string | null,
  percentage: number | null,
): { word: number; precision: Precision } {
  const last = Math.max(0, book.totalWords - 1);
  const byPercent = (lo = 0, hi = book.totalWords): number => {
    const p = Math.min(1, Math.max(0, percentage ?? 0));
    const w = Math.floor(p * book.totalWords);
    return Math.min(Math.max(w, lo), Math.max(lo, hi - 1), last);
  };

  const parsed = pointer ? parsePointer(pointer) : null;
  if (!parsed || parsed.doc >= book.elements.length) {
    return percentage != null ? { word: byPercent(), precision: "percentage" } : { word: 0, precision: "none" };
  }
  const mark = book.elements[parsed.doc].get(parsed.path);
  if (!mark) {
    // The chapter is right, the element isn't one we can find: the synced
    // percentage, held inside that chapter.
    const [lo, hi] = book.docWords[parsed.doc];
    return { word: percentage != null ? byPercent(lo, hi) : Math.min(lo, last), precision: "percentage" };
  }

  // Blocks carrying exactly this path (a container's text can be split around
  // a nested block — `base` says where each piece starts). Otherwise the
  // element is inline or empty: start where it opened inside its block.
  let blockIndex = mark.block;
  let char = mark.char + (parsed.offset ?? 0);
  const own: number[] = [];
  for (let i = mark.block; i < book.blocks.length && book.blocks[i].doc === parsed.doc; i++) {
    if (book.blocks[i].path === parsed.path) own.push(i);
    else if (!book.blocks[i].path.startsWith(parsed.path + "/")) break; // left the element
  }
  if (own.length > 0) {
    const off = parsed.offset ?? 0;
    blockIndex = own[0];
    for (const i of own) if (book.blocks[i].base <= off) blockIndex = i;
    char = off - book.blocks[blockIndex].base;
  }

  // First word ending after the offset: the word it falls in, or the next one
  // when it sits in the space between.
  for (let i = blockIndex; i < book.blocks.length; i++) {
    const b = book.blocks[i];
    if (b.words.length === 0) {
      char = 0;
      continue;
    }
    const k = b.words.findIndex(([, end]) => end > char);
    if (k >= 0) {
      return { word: b.wordStart + k, precision: parsed.offset != null ? "word" : "paragraph" };
    }
    char = 0; // past this block's end: the next block's first word
  }
  return { word: last, precision: parsed.offset != null ? "word" : "paragraph" };
}

function blockAt(book: ParsedBook, word: number): number {
  let lo = 0;
  let hi = book.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (book.blocks[mid].wordStart <= word) lo = mid;
    else hi = mid - 1;
  }
  // Skip empty blocks sharing the same wordStart.
  while (lo < book.blocks.length - 1 && book.blocks[lo].words.length === 0) lo++;
  return lo;
}

const SENTENCE_END = /[.!?…]["'”’»)\]]*$/;

export const PAGE_WINDOW_WORDS = 170;
/** How far into a paragraph a position may sit before the page starts mid-paragraph. */
const PARAGRAPH_BACKOFF = 45;
/** A paragraph ending within this many words past the page's end is finished on this page. */
const PARAGRAPH_FINISH = 35;

export type PageBlock = {
  text: string;
  heading: boolean;
  /** The page starts / ends inside this paragraph. */
  cutStart: boolean;
  cutEnd: boolean;
  /** Character range of the synced word in `text`, when it is on this page. */
  mark: [number, number] | null;
};

export type PageWindow = {
  blocks: PageBlock[];
  startWord: number;
  endWord: number;
  totalWords: number;
  /** Start of the page before / after this one (null at the ends of the book). */
  prevFrom: number | null;
  nextFrom: number | null;
  /** Fraction of the book at the page's first word. */
  fraction: number;
};

/** Where a page showing `word` starts: its paragraph, or its sentence in a long one. */
export function pageStartFor(book: ParsedBook, word: number): number {
  if (book.totalWords === 0) return 0;
  const b = book.blocks[blockAt(book, word)];
  if (word - b.wordStart <= PARAGRAPH_BACKOFF) return b.wordStart;
  for (let w = word - 1; w >= Math.max(b.wordStart, word - PARAGRAPH_BACKOFF); w--) {
    const [s, e] = b.words[w - b.wordStart];
    if (SENTENCE_END.test(b.text.slice(s, e))) return w + 1;
  }
  return word;
}

/** A page's worth of text from `start`, with the synced `position` marked if it's on it. */
export function pageWindow(
  book: ParsedBook,
  start: number,
  position: number | null,
  size = PAGE_WINDOW_WORDS,
): PageWindow {
  const total = book.totalWords;
  if (total === 0) {
    return { blocks: [], startWord: 0, endWord: 0, totalWords: 0, prevFrom: null, nextFrom: null, fraction: 0 };
  }
  start = Math.min(Math.max(0, Math.floor(start)), total - 1);
  let end = Math.min(total, start + size);
  if (end < total) {
    const b = book.blocks[blockAt(book, end - 1)];
    const blockEnd = b.wordStart + b.words.length;
    if (blockEnd > end && blockEnd - end <= PARAGRAPH_FINISH) end = blockEnd;
  }

  const blocks: PageBlock[] = [];
  for (let i = blockAt(book, start); i < book.blocks.length; i++) {
    const b = book.blocks[i];
    if (b.wordStart >= end) break;
    if (b.words.length === 0) continue;
    const from = Math.max(start, b.wordStart) - b.wordStart;
    const to = Math.min(end, b.wordStart + b.words.length) - b.wordStart;
    if (to <= from) continue;
    const charFrom = b.words[from][0];
    const text = b.text.slice(charFrom, b.words[to - 1][1]);
    let mark: [number, number] | null = null;
    if (position != null && position >= b.wordStart + from && position < b.wordStart + to) {
      const [s, e] = b.words[position - b.wordStart];
      mark = [s - charFrom, e - charFrom];
    }
    blocks.push({ text, heading: b.heading, cutStart: from > 0, cutEnd: to < b.words.length, mark });
  }

  let prevFrom: number | null = null;
  if (start > 0) {
    prevFrom = Math.max(0, start - size);
    const b = book.blocks[blockAt(book, prevFrom)];
    if (prevFrom - b.wordStart <= PARAGRAPH_FINISH) prevFrom = b.wordStart;
  }
  return {
    blocks,
    startWord: start,
    endWord: end,
    totalWords: total,
    prevFrom,
    nextFrom: end < total ? end : null,
    fraction: start / total,
  };
}

// A poll every few seconds would otherwise unzip and walk the whole book each
// time. Keyed by sha256, so a replaced file can never be served stale.
const cache = new Map<string, ParsedBook>();
const CACHE_MAX = 4;

export function parseBookCached(sha256: string, read: () => Buffer): ParsedBook | null {
  const hit = cache.get(sha256);
  if (hit) {
    cache.delete(sha256);
    cache.set(sha256, hit);
    return hit;
  }
  const parsed = parseBook(read());
  if (!parsed) return null;
  cache.set(sha256, parsed);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return parsed;
}
