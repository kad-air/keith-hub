import AdmZip from "adm-zip";

// Word counting for the reading-statistics denominator.
//
// A kosync percentage is a fraction of a book and nothing more — "0.43" is not
// pages, minutes, or words. To say anything a human cares about ("312 pages
// to go", "you read 40 pages today") the book's own length has to come from
// somewhere, and the only honest source is the epub's text.
//
// 🔴 This is a READ. It unzips into memory and never writes — the stored file
// stays byte-identical, so the partial-MD5 sync key is untouched (BOOKS_PLAN
// §4). Same benign-failure contract as epubMeta.ts: extraction returning null
// must never fail an ingest.
//
// Deliberately NOT a page count from the file: EPUB is reflowable and has no
// pages. Every reader invents its own from font size and screen. Words are the
// invariant, and PAGE_WORDS below converts once, in one place, under a label
// the UI prints.

// The page convention lives in pages.ts, which imports nothing — anything
// that only needs the constant must not drag AdmZip into a browser bundle.
// Re-exported here for callers already reasoning about text and length.
export { PAGE_WORDS, pagesFromWords } from "./pages.ts";

// Elements whose contents are not prose. Counting a stylesheet or a script
// block as words would inflate a book by thousands.
const NON_PROSE = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

function countWordsInXhtml(xhtml: string): number {
  const text = xhtml
    .replace(NON_PROSE, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Tags become spaces, not nothing: "<p>one</p><p>two</p>" is two words,
    // and stripping to "" would glue them into one.
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, "w");

  // A "word" is a run of non-whitespace. Matches how `wc -w` counts, which is
  // what the offline reference in books-fixture/expected.json uses — the two
  // implementations have to agree for check:books:stats to mean anything.
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Total words of prose in an epub, walking the OPF spine so front/back matter
 * that isn't in the reading order (and stray files in the zip) don't count.
 * Falls back to every XHTML file in the archive when the spine can't be read.
 * Returns null if the file isn't a readable zip at all.
 */
export function countEpubWords(bytes: Buffer): number | null {
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    return null;
  }

  try {
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

    const spineDocs = resolveSpine(readText);
    const docs =
      spineDocs.length > 0
        ? spineDocs
        : entries
            .filter((e) => /\.(x?html|htm)$/i.test(e.entryName))
            .map((e) => e.entryName);

    let words = 0;
    for (const name of docs) {
      const xhtml = readText(name);
      if (xhtml) words += countWordsInXhtml(xhtml);
    }
    return words;
  } catch {
    return null;
  }
}

/**
 * The spine's document hrefs, resolved against the OPF's own directory.
 * Regex-driven for the same reason epubMeta.ts is: these are simple attributes
 * and a parse failure has to degrade, not throw.
 */
function resolveSpine(readText: (name: string) => string | null): string[] {
  const container = readText("META-INF/container.xml");
  if (!container) return [];
  const rootMatch = container.match(/full-path=["']([^"']+)["']/i);
  if (!rootMatch) return [];
  const opfPath = rootMatch[1];
  const opf = readText(opfPath);
  if (!opf) return [];

  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  // id → href from the manifest.
  const manifest = new Map<string, string>();
  for (const item of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = item.match(/\sid=["']([^"']+)["']/i)?.[1];
    const href = item.match(/\shref=["']([^"']+)["']/i)?.[1];
    const type = item.match(/\smedia-type=["']([^"']+)["']/i)?.[1] ?? "";
    if (!id || !href) continue;
    if (!/xhtml|html/i.test(type) && !/\.(x?html|htm)$/i.test(href)) continue;
    manifest.set(id, href);
  }

  const spine: string[] = [];
  for (const ref of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
    const idref = ref.match(/\sidref=["']([^"']+)["']/i)?.[1];
    if (!idref) continue;
    const href = manifest.get(idref);
    if (href) spine.push(joinPath(opfDir, decodeURIComponent(href.split("#")[0])));
  }
  return spine;
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
