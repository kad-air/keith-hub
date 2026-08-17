// The page convention, alone in its own module.
//
// 🔴 Dependency-free ON PURPOSE. Both the pure stats model and the client
// components need this constant, and the obvious home for it — epubText.ts,
// where words are counted — drags AdmZip into every bundle that touches it.
// That measurably happened: /books/stats shipped 182 kB of first-load JS
// before this split, almost all of it a zip library the browser has no use
// for. Keep this file free of imports.

/**
 * Words to a page. Printed on screen next to the numbers it produces, so the
 * convention is never implied.
 *
 * 🔴 MEASURED, not a publishing convention. The obvious value — 250 — is the
 * MANUSCRIPT standard (a double-spaced typescript page) and is badly wrong for
 * a printed book: it put The Two Towers at 621 pages against a real edition of
 * 352, and the estimate was visibly off on the first real book that reached
 * the page.
 *
 * The number below comes from the only ground truth that exists here. Some
 * EPUBs carry their print edition's own pagination as `epub:type="pagebreak"`
 * anchors and a nav `page-list` — real page boundaries from a real typesetter,
 * not an estimate. Two books in the library have one, and they were measured
 * with THIS module's own word counter:
 *
 *     The Two Towers       155,347 words   352 printed pages   441 w/p
 *     Call for the Dead     47,621 words   172 printed pages   277 w/p
 *     ─────────────────────────────────────────────────────────────────
 *     combined             202,968 words   524 printed pages   387 w/p
 *
 * Pooled rather than averaged: the question is "across every real page I have
 * evidence for, how many words fit on one", and that is one ratio over all of
 * them, not the mean of two per-book ratios.
 *
 * 🔴 The honest limit, because the numbers on screen depend on it: those two
 * books disagree by 60% (277 vs 441 — a densely-set mass-market Tolkien
 * against an ordinary paperback), and no single constant can serve both. Any
 * given book will land within roughly ±20% of its real edition. That is a
 * fitted estimate from a sample of two, not a fact about books, and it is why
 * the stats page calls these estimates rather than counts.
 *
 * If more page-list books enter the library, re-measure and move this — the
 * derivation above is the whole method. (A book that carries its own page-list
 * could in principle be paged EXACTLY rather than estimated; deliberately not
 * done, so every book on the page is measured the same way and totals stay
 * comparable.)
 */
export const PAGE_WORDS = 387;

export function pagesFromWords(words: number): number {
  return Math.round(words / PAGE_WORDS);
}
