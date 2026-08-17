// The page convention, alone in its own module.
//
// 🔴 Dependency-free ON PURPOSE. Both the pure stats model and the client
// components need this constant, and the obvious home for it — epubText.ts,
// where words are counted — drags AdmZip into every bundle that touches it.
// That measurably happened: /books/stats shipped 182 kB of first-load JS
// before this split, almost all of it a zip library the browser has no use
// for. Keep this file free of imports.

/** A "page" is 250 words of the book's own text. Printed on screen next to
 *  the numbers it produces, so the convention is never implied. */
export const PAGE_WORDS = 250;

export function pagesFromWords(words: number): number {
  return Math.round(words / PAGE_WORDS);
}
