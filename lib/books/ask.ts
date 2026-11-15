import type { ParsedBook } from "./pageText.ts";

// "Ask about the book I'm reading": what the model is allowed to see.
//
// 🔴 The whole feature rests on one cut. The model is sent the book's text up
// to the synced reading position and NOT ONE WORD past it — a question about a
// book you are halfway through must not be answered from its ending. A leak
// here has no error surface (the answer just quietly knows too much), so the
// cut lives in this pure module, apart from the route and the SDK, where
// check:books:ask can sweep it.
//
// The rule: every word with a global index < `cutoff` is included, in order;
// no word with an index >= `cutoff` is. `cutoff` is the word the synced
// pointer resolves to (pageText.resolvePosition), so the cut errs toward LESS:
// the word the position names is itself withheld, and so is the rest of the
// page the reader may be partway down.
//
// 🔴 What this cannot do: remove what the model already knows. A famous book
// is in its training data. The system prompt welcomes everything it knows
// about the outside world (allusions, history, jargon) and forbids what it
// knows of the rest of THIS book, which is an instruction and not a guarantee
// — the UI says so.
//
// Pure: imports types only.

/** Words per cached chunk. Chunk boundaries depend only on the book, never on the position. */
export const CHUNK_WORDS = 20_000;

export type ReadSoFar = {
  /**
   * The text before the cutoff, in order. Every chunk but the last holds
   * exactly CHUNK_WORDS words, so advancing the position only ever changes the
   * last chunk (or appends) — the earlier ones stay byte-identical, which is
   * what lets the prompt cache survive a day's reading.
   */
  chunks: string[];
  /** Words included: min(cutoff, totalWords), never more. */
  words: number;
  totalWords: number;
};

/** The book's text strictly before global word `cutoff`. */
export function readSoFar(book: ParsedBook, cutoff: number): ReadSoFar {
  const total = book.totalWords;
  const end = Math.min(Math.max(0, Math.floor(Number.isFinite(cutoff) ? cutoff : 0)), total);

  const chunks: string[] = [];
  let current = "";
  let inCurrent = 0;
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
    inCurrent = 0;
  };

  for (const b of book.blocks) {
    if (b.wordStart >= end) break;
    if (b.words.length === 0) continue;
    const upTo = Math.min(end - b.wordStart, b.words.length);
    let from = 0;
    while (from < upTo) {
      const take = Math.min(upTo - from, CHUNK_WORDS - inCurrent);
      const piece = b.text.slice(b.words[from][0], b.words[from + take - 1][1]);
      // A paragraph starts on a new line pair; a paragraph split by a chunk
      // boundary simply continues at the top of the next chunk.
      if (from === 0) current += (current ? "\n\n" : "") + (b.heading ? "## " : "") + piece;
      else current += piece;
      inCurrent += take;
      from += take;
      if (inCurrent === CHUNK_WORDS) flush();
      else if (from < upTo) current += " ";
    }
  }
  flush();
  return { chunks, words: end, totalWords: total };
}

export const MAX_QUESTION_CHARS = 4_000;

export const ASK_INSTRUCTIONS = `You are helping someone who is partway through reading a book. The text that follows is the part they have read so far: it runs from the beginning of the book to their current position and stops there, usually mid-chapter. They have not read anything after it.

There are two kinds of knowledge here and they are treated differently.

Everything you know about the world outside this book is welcome, and is often the point of the question. Explain literary allusions and quotations and where they come from, historical events and figures, places, institutions, foreign phrases, period slang, professional jargon, and anything else the author assumes a reader will recognise. When a passage echoes another work, say which and what the echo is doing there. Bring the same knowledge you would bring to any conversation.

What happens in this book after the point they have reached is off limits. They are asking precisely because they do not want the rest spoiled. If you recognise the book, do not draw on what you know of how it continues: nothing that happens later, no later reveals about a character, no "as we find out", and no hints, including hints by omission such as "that isn't explained yet" or "keep an eye on her". Do not let an explanation of an allusion carry a hint either: say what the reference means, not what it foreshadows. The same care applies to sequels, adaptations, and criticism that gives later events away, and to the plots of other books in the same series unless they ask. When a question is about the story itself and the text so far does not answer it, say that it has not come up in what they have read, and leave it there.

Within the text they have read, be as helpful as you can: remind them who people are and how they are connected, recap what has happened, explain a passage, trace where something was first mentioned. Quote or point to the passage when it helps.

Keep answers short and plain. This is read on a phone.`;
