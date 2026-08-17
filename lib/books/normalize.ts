// Metadata normalization, ported from ~/Stump/organize-books.py (the script
// that organized /Volumes/HDD/Books). Same rules, same override table — ported
// rather than re-derived (BOOKS_PLAN §8) so the catalog metadata lands
// identical to what the shelf organization already established.

// (author_key, title_key) -> { series, index }. Keys are compared accent- and
// punctuation-insensitively via fold(), so "John le Carre" matches
// "John le Carré". Add entries when an epub belongs to a series but its OPF
// says nothing about it — deliberately explicit and hand-maintained.
const SERIES_OVERRIDES: Record<string, { series: string; index: number }> = {
  "john le carre|call for the dead": { series: "Smiley", index: 1 },
  "j r r tolkien|the two towers": { series: "The Lord of the Rings", index: 2 },
};

/** Accent-folded, punctuation-free, lowercase — for comparing names. */
export function fold(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(fold(s).split(" ").filter(Boolean));
}

/** 'Pratchett, Terry' -> 'Terry Pratchett'; left alone when it looks risky. */
function flipName(a: string): string {
  if ((a.match(/,/g) ?? []).length !== 1) return a;
  const [last, first] = a.split(",").map((p) => p.trim());
  if (!last || !first) return a;
  if (["jr", "sr", "iii", "ii", "phd", "md"].includes(first.toLowerCase().replace(/\.$/, ""))) return a;
  if (first.length > 40 || last.length > 40) return a;
  return `${first} ${last}`;
}

export function cleanAuthor(a: string | null): string | null {
  if (!a) return null;
  const flipped = flipName(a.trim().replace(/[;,]+$/, "").trim());
  const cleaned = flipped.replace(/[\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/**
 * Drop redundant leading "<name> - " segments from a title, tolerating a
 * trailing volume number: "The Dark Tower II - The Drawing of the Three"
 * against series "The Dark Tower" becomes "The Drawing of the Three", and
 * "Pratchett, Terry - Discworld 15 - Men at Arms" against the author + series
 * becomes "Men at Arms".
 */
export function stripLeading(title: string, name: string | null): string {
  if (!name) return title;
  const want = tokens(name);
  if (want.size === 0) return title;
  const ROMAN = new Set(["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"]);
  let parts = title.split(" - ");
  while (parts.length > 1) {
    const got = tokens(parts[0]);
    const extra = [...got].filter((t) => !want.has(t));
    const covered = [...want].every((t) => got.has(t));
    if (got.size > 0 && covered && extra.every((t) => ROMAN.has(t) || /^\d+$/.test(t))) {
      parts = parts.slice(1);
    } else {
      break;
    }
  }
  return parts.join(" - ");
}

export function seriesOverride(
  author: string | null,
  title: string,
): { series: string; index: number } | null {
  return SERIES_OVERRIDES[`${fold(author)}|${fold(title)}`] ?? null;
}

/**
 * Apply the full rule set to raw extracted metadata. `existingAuthors` is the
 * distinct set already in the catalog: a fold()-match adopts the stored
 * spelling (one spelling per author across the collection — organize-books.py
 * computed this globally; at one-at-a-time ingest, first spelling in wins and
 * the UI can edit).
 */
export function normalizeMeta(
  raw: { title: string | null; author: string | null; series: string | null; seriesIndex: number | null },
  fallbackTitle: string,
  existingAuthors: string[],
): { title: string; author: string | null; series: string | null; seriesIndex: number | null } {
  let author = cleanAuthor(raw.author);
  if (author) {
    const match = existingAuthors.find((e) => fold(e) === fold(author));
    if (match) author = match;
  }

  let title = raw.title?.trim() || fallbackTitle;
  let series = raw.series?.trim() || null;
  let seriesIndex = raw.seriesIndex;

  if (!series) {
    const ov = seriesOverride(author, title);
    if (ov) {
      series = ov.series;
      seriesIndex = ov.index;
    }
  }

  // Strip redundant "<author> - " / "<series N> - " prefixes off the title.
  title = stripLeading(title, author);
  title = stripLeading(title, series);

  return { title, author, series, seriesIndex };
}
