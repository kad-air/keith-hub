import type { Book } from "./store.ts";

// Metadata quality heuristics — the "this looks wrong" surface that lets an
// agent (or a human) find the books worth fixing without reading all of them.
//
// Deliberately HIGH-PRECISION and narrow: every flag here is something
// mechanically checkable about the string itself. The genuinely valuable
// fixes — knowing that Tinker Tailor Soldier Spy is Smiley #5 — are NOT
// detectable by heuristic at all; they need world knowledge. So this is a
// triage aid, not the cleanup itself: `bare_series` style guesses are left out
// on purpose rather than flagging two-thirds of a library as "suspect".

export type MetadataIssue =
  | "no_author"
  | "author_unflipped"
  | "author_initials_unspaced"
  | "title_looks_like_filename"
  | "series_number_stranded_in_title"
  | "series_without_index"
  | "index_without_series"
  | "no_description";

export const ISSUE_DESCRIPTIONS: Record<MetadataIssue, string> = {
  no_author: "No author — the OPF had none, or extraction failed",
  author_unflipped: 'Author still in "Last, First" form',
  author_initials_unspaced: 'Initials run together (e.g. "J.R.R." vs "J. R. R.")',
  title_looks_like_filename: "Title looks like a raw filename, not a title",
  series_number_stranded_in_title: "Title carries a volume number but no series is set",
  series_without_index: "In a series but has no position number",
  index_without_series: "Has a series position but no series name",
  no_description: "No description",
};

// "Pratchett, Terry - Discworld 15 - Men at Arms", "Annas Archive",
// underscores, long hex fragments, a stray .epub — the shapes that mean the
// title came off a file name rather than out of real metadata.
const FILENAME_SHAPES = [
  /\.epub\b/i,
  /_{2,}|_[a-z]/i,
  /\b[0-9a-f]{16,}\b/i,
  /anna'?s archive/i,
  /\bz-?lib\b|\blibgen\b/i,
  /\(\s*z-?lib(\.org)?\s*\)/i,
];

// "Book 2", "Vol. 3", "Part IV", "#5", "Discworld 15" — a volume marker
// sitting in the title with nothing in the series fields.
const STRANDED_NUMBER =
  /(\b(book|bk|vol|volume|part|pt|no)\b\.?\s*\d+)|(#\s*\d+)|(\s[-–—]\s\d{1,2}\s[-–—]\s)/i;

export function metadataIssues(book: Book): MetadataIssue[] {
  const issues: MetadataIssue[] = [];

  if (!book.author) {
    issues.push("no_author");
  } else {
    if (book.author.includes(",")) issues.push("author_unflipped");
    // "J.R.R. Tolkien" — dotted initials with no spaces between them.
    if (/\b(?:[A-Z]\.){2,}[A-Z]?\b/.test(book.author)) {
      issues.push("author_initials_unspaced");
    }
  }

  if (FILENAME_SHAPES.some((re) => re.test(book.title))) {
    issues.push("title_looks_like_filename");
  }

  if (!book.series && STRANDED_NUMBER.test(book.title)) {
    issues.push("series_number_stranded_in_title");
  }
  if (book.series && book.seriesIndex == null) issues.push("series_without_index");
  if (!book.series && book.seriesIndex != null) issues.push("index_without_series");

  if (!book.description) issues.push("no_description");

  return issues;
}

/** Issues minus the purely-cosmetic ones, for a "needs attention" filter. */
const MINOR: ReadonlySet<MetadataIssue> = new Set<MetadataIssue>([
  "no_description",
  "author_initials_unspaced",
]);

export function needsAttention(book: Book): boolean {
  return metadataIssues(book).some((i) => !MINOR.has(i));
}
