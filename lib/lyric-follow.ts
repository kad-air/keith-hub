// Lyric-follow matching for the chart viewer's Voice mode.
//
// The viewer feeds this module a rolling transcript from SpeechRecognition
// (what the user is singing) and it answers "which line of the chart are we
// on?". The matcher is deliberately dumb-but-robust: speech recognition of
// *singing* is noisy (melisma, sustained vowels, backing chords bleeding into
// the mic), so instead of trying to align everything it looks for a handful
// of consecutive-ish word hits inside a local window around the last known
// position, and only moves forward when the evidence clears a threshold.
// Repositioning backwards is manual (tap a line) — forward-only advancement
// keeps a stray false match from yanking the chart around mid-song.

import type { ChartLineBlock } from "./chord-wrap";

export interface LyricWordRef {
  /** Normalized word (lowercase, punctuation stripped). */
  norm: string;
  /** Index into the parseChart() block array this word came from. */
  blockIndex: number;
}

/** How many trailing recognized words are considered per feed() call. */
export const MATCH_TAIL = 8;
/** How far ahead of the current position we search (in lyric words). */
const AHEAD_WINDOW = 40;
/** How far behind we start candidate alignments (tail overlaps prior match). */
const BACK_WINDOW = 6;
/** Max lyric words skippable between two matched words in one alignment. */
const SKIP = 2;

/** Lowercase, drop apostrophes, strip everything non-alphanumeric. */
export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

// Section labels ([Verse 2], "Chorus:", "Bridge x2", parenthetical
// performance notes) are visible in the chart but never sung — exclude them
// so belting the chorus doesn't match the word "chorus".
const HEADER_RE =
  /^(\[[^\]]*\]|\([^)]*\)|(?:pre[-\s]?)?(?:verse|chorus|bridge|intro|outro|interlude|instrumental|solo|tag|coda|refrain|ending|hook|breakdown|turnaround|vamp|riff)\b[\sx\d:.\-]*)$/i;

export function isSectionHeader(line: string): boolean {
  return HEADER_RE.test(line.trim());
}

/**
 * Flatten parsed chart blocks into the singable word stream. Chord-only
 * blocks, blank lines, and section headers contribute nothing; each word
 * remembers which block it belongs to so a match maps back to a visual line.
 */
export function extractLyricWords(blocks: ChartLineBlock[]): LyricWordRef[] {
  const out: LyricWordRef[] = [];
  blocks.forEach((b, blockIndex) => {
    if (b.chordOnly) return;
    if (b.text.trim() === "") return;
    if (isSectionHeader(b.text)) return;
    for (const raw of b.text.split(/\s+/)) {
      const norm = normalizeWord(raw);
      if (norm) out.push({ norm, blockIndex });
    }
  });
  return out;
}

/** Levenshtein distance ≤ 1 (single substitution, insertion, or deletion). */
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

/**
 * Fuzzy word equality tuned for sung speech-to-text: exact, shared prefix
 * ("singin" / "singing"), or one edit apart for longer words.
 */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))
    return true;
  if (a.length >= 5 && b.length >= 5) return withinOneEdit(a, b);
  return false;
}

/**
 * Stateful position tracker. Construct once per chart, feed() it the latest
 * recognized words, read back the block to highlight. seekToBlock() handles
 * manual repositioning (tapping a line).
 */
export class LyricMatcher {
  private readonly norms: string[];
  private readonly blockOf: number[];
  private pos = -1; // index of the last confidently matched lyric word

  constructor(words: LyricWordRef[]) {
    this.norms = words.map((w) => w.norm);
    this.blockOf = words.map((w) => w.blockIndex);
  }

  get wordCount(): number {
    return this.norms.length;
  }

  /** Block index of the current position, or null before the first match. */
  get currentBlock(): number | null {
    return this.pos >= 0 ? this.blockOf[this.pos] : null;
  }

  /**
   * Manually reposition to just before the first lyric word of `blockIndex`,
   * so the next match lands inside that line. Blocks without lyric words snap
   * to the next singable line.
   */
  seekToBlock(blockIndex: number): void {
    let first = -1;
    for (let i = 0; i < this.blockOf.length; i++) {
      if (this.blockOf[i] >= blockIndex) {
        first = i;
        break;
      }
    }
    this.pos = first >= 0 ? first - 1 : this.norms.length - 1;
  }

  /**
   * Feed the latest recognized transcript words (the whole session's — only
   * the tail is used). Returns the block index to highlight when the position
   * advances, or null when the evidence isn't strong enough to move.
   */
  feed(recognizedWords: string[]): number | null {
    const tail = recognizedWords
      .slice(-MATCH_TAIL)
      .map(normalizeWord)
      .filter((w) => w.length > 0);
    if (tail.length === 0) return null;
    // A lone short word ("the", "on") appearing ahead is no evidence at all.
    if (tail.length === 1 && tail[0].length < 4) return null;
    const need = Math.min(2, tail.length);

    const lo = Math.max(0, this.pos - BACK_WINDOW);
    const hi = Math.min(this.norms.length - 1, this.pos + AHEAD_WINDOW);
    let bestEnd = -1;
    let bestScore = 0;
    for (let start = lo; start <= hi; start++) {
      // Greedy in-order alignment of the tail against lyric words from
      // `start`, tolerating up to SKIP unmatched lyric words between hits.
      let si = start;
      let matched = 0;
      let end = -1;
      for (const w of tail) {
        if (si > hi) break;
        let found = -1;
        const kMax = Math.min(hi, si + SKIP);
        for (let k = si; k <= kMax; k++) {
          if (wordsMatch(w, this.norms[k])) {
            found = k;
            break;
          }
        }
        if (found >= 0) {
          matched++;
          end = found;
          si = found + 1;
        }
      }
      // Forward-only; on ties prefer the smallest jump (repeated lyrics
      // resolve to the nearest occurrence).
      if (
        end > this.pos &&
        (matched > bestScore || (matched === bestScore && end < bestEnd))
      ) {
        bestScore = matched;
        bestEnd = end;
      }
    }

    if (bestScore >= need && bestEnd > this.pos) {
      this.pos = bestEnd;
      return this.blockOf[bestEnd];
    }
    return null;
  }
}
