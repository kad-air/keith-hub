// Chord-chart line wrapping.
//
// A chord chart is plain monospace text where chord lines sit above lyric
// lines, aligned column-for-column by spaces:
//
//        C              G        Am           F
//   Twinkle twinkle little star, how I wonder what you are
//
// On a narrow screen that line is too wide. Naive CSS wrapping breaks it two
// ways: word-wrap makes the chord line and the lyric line break at *different*
// columns (they have different content), so chords drift off their syllable;
// char-wrap (break-all) keeps them aligned but splits lyric words mid-word.
//
// The fix is to do the wrapping ourselves: pick the break points from the
// *lyric* line (always on a word boundary) and slice the *chord* line at the
// exact same columns. Because the font is monospace, "column N" is the same x
// position on both lines, so every chord stays locked over its syllable while
// the lyrics still break on whole words.

export interface ChartLineBlock {
  /** The chord line, or null when this block has no chords. */
  chord: string | null;
  /** The lyric / header / text line. "" for a blank line or a chord-only block. */
  text: string;
  /** True for a standalone chord line (instrumental) with no lyric beneath it. */
  chordOnly: boolean;
}

export interface WrappedRow {
  /** Chord segment for this visual row, or null when there's nothing to show. */
  chord: string | null;
  /** Lyric / text segment for this visual row. */
  text: string;
  /** True when this row is just vertical space (a blank source line). */
  blank: boolean;
}

// A chord token: root + optional accidental, quality, extensions, alterations,
// and a slash bass. Deliberately strict so ordinary lyric words that happen to
// start with A–G (Be, Dad, Cab, Fade…) are rejected — a line only counts as a
// chord line when *every* token looks like a chord.
const CHORD_RE =
  /^[A-G][#b]?(?:m|maj|min|dim|aug|sus|add|M)*[0-9]*(?:[#b][0-9]+)*(?:sus[0-9]?)?(?:add[0-9]+)?(?:\/[A-G][#b]?)?$/;

// Non-chord tokens that still legitimately appear on a chord line.
const CHORD_EXTRA_RE = /^(?:\|{1,2}|:\|?|\|:|%|N\.?C\.?|[xX][0-9]+|-|–)$/;

/** Heuristic: is this line a row of chords (every token reads as a chord)? */
export function isChordLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  const tokens = trimmed.split(/\s+/);
  for (const t of tokens) {
    if (!CHORD_RE.test(t) && !CHORD_EXTRA_RE.test(t)) return false;
  }
  return true;
}

/**
 * Parse raw chart text into blocks. A chord line immediately followed by a
 * non-blank lyric line becomes a paired block; otherwise lines stand alone.
 */
export function parseChart(content: string): ChartLineBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ChartLineBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isChordLine(line)) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() !== "" && !isChordLine(next)) {
        // chord line + its lyric line
        blocks.push({ chord: line, text: next, chordOnly: false });
        i++;
      } else {
        // standalone chord line (instrumental break, or chords then a blank)
        blocks.push({ chord: line, text: "", chordOnly: true });
      }
    } else {
      // lyric / header / blank line
      blocks.push({ chord: null, text: line, chordOnly: false });
    }
  }
  return blocks;
}

/**
 * Wrap a single block to at most `cols` monospace columns per row.
 *
 * Break points come from the lyric line and always land on a word boundary
 * (falling back to a hard char break only for a single word longer than the
 * whole row). The chord line is sliced at the same columns so it stays aligned.
 */
export function wrapBlock(block: ChartLineBlock, cols: number): WrappedRow[] {
  const width = Math.max(1, Math.floor(cols));
  const chord = block.chord ?? "";
  const text = block.text;

  // Blank source line → a single empty spacer row.
  if (chord === "" && text.trim() === "" && !block.chordOnly) {
    return [{ chord: null, text: "", blank: true }];
  }

  const len = Math.max(chord.length, text.length);
  if (len === 0) return [{ chord: null, text: "", blank: true }];

  const c = chord.padEnd(len, " ");
  const y = text.padEnd(len, " ");
  const rows: WrappedRow[] = [];

  let start = 0;
  while (start < len) {
    // Drop columns that are blank on BOTH lines — this consumes the space at a
    // wrap point without ever discarding a chord that sits above it.
    while (start < len && c[start] === " " && y[start] === " ") start++;
    if (start >= len) break;

    let end = Math.min(start + width, len);
    if (end < len) {
      // Prefer a break where both lines are blank (a clean word + chord gap).
      let brk = -1;
      for (let i = end; i > start; i--) {
        if (y[i] === " " && c[i] === " ") {
          brk = i;
          break;
        }
      }
      // Otherwise break on any lyric word boundary, even if a chord floats above
      // the gap (that chord travels intact to the next row).
      if (brk < 0) {
        for (let i = end; i > start; i--) {
          if (y[i] === " ") {
            brk = i;
            break;
          }
        }
      }
      // brk < 0 means a single token longer than the row: hard-break at `end`.
      if (brk > start) end = brk;
    }

    const chordSlice = c.slice(start, end).replace(/\s+$/, "");
    const textSlice = y.slice(start, end).replace(/\s+$/, "");
    rows.push({
      chord: chordSlice.trim() === "" ? null : chordSlice,
      text: textSlice,
      blank: false,
    });
    start = end;
  }

  return rows.length > 0 ? rows : [{ chord: null, text: "", blank: true }];
}

/** Convenience: parse + wrap an entire chart to `cols` columns. */
export function wrapChart(content: string, cols: number): WrappedRow[][] {
  return parseChart(content).map((b) => wrapBlock(b, cols));
}
