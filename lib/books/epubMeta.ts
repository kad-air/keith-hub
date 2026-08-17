import AdmZip from "adm-zip";

// Minimal EPUB metadata extraction: container.xml → OPF → dc:* + series +
// cover. Regex-based rather than a full XML parser — the fields we want are
// simple leaf elements, and the failure mode is benign by design: extraction
// returning nulls must never fail an ingest (BOOKS_PLAN §8; the caller falls
// back to the file name and the UI edits from there).
export type EpubMeta = {
  title: string | null;
  author: string | null;
  series: string | null;
  seriesIndex: number | null;
  language: string | null;
  description: string | null;
  cover: { bytes: Buffer; ext: string } | null;
};

const EMPTY: EpubMeta = {
  title: null,
  author: null,
  series: null,
  seriesIndex: null,
  language: null,
  description: null,
  cover: null,
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// First <dc:tag ...>text</dc:tag> (any namespace prefix), tags stripped.
function dcText(opf: string, tag: string): string | null {
  const m = opf.match(
    new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${tag}>`, "i"),
  );
  if (!m) return null;
  const text = decodeEntities(m[1].replace(/<[^>]+>/g, "").trim());
  return text || null;
}

function metaContent(opf: string, name: string): string | null {
  const m = opf.match(
    new RegExp(`<meta\\s[^>]*name=["']${name}["'][^>]*>`, "i"),
  );
  if (!m) return null;
  const c = m[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]) : null;
}

// EPUB3 <meta property="...">value</meta>
function metaProperty(opf: string, property: string): string | null {
  const m = opf.match(
    new RegExp(`<meta\\s[^>]*property=["']${property}["'][^>]*>([\\s\\S]*?)</meta>`, "i"),
  );
  return m ? decodeEntities(m[1].trim()) || null : null;
}

function attrOf(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`${attr}=["']([^"']*)["']`, "i"));
  return m ? decodeEntities(m[1]) : null;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

function findCover(zip: AdmZip, opf: string, opfDir: string): EpubMeta["cover"] {
  const items = opf.match(/<(?:[A-Za-z0-9]+:)?item\s[^>]*>/gi) ?? [];
  // EPUB3: manifest item with properties containing "cover-image".
  let coverItem = items.find((t) => /properties=["'][^"']*cover-image[^"']*["']/i.test(t));
  // EPUB2: <meta name="cover" content="<manifest id>">.
  if (!coverItem) {
    const coverId = metaContent(opf, "cover");
    if (coverId) {
      coverItem = items.find((t) => attrOf(t, "id") === coverId);
    }
  }
  if (!coverItem) return null;
  const href = attrOf(coverItem, "href");
  if (!href) return null;
  const mediaType = attrOf(coverItem, "media-type") ?? "";
  // Resolve href relative to the OPF's directory ("." segments and URL-encoding
  // both appear in the wild).
  const resolved = decodeURIComponent(
    (opfDir ? `${opfDir}/` : "") + href.replace(/^\.\//, ""),
  );
  const entry = zip.getEntry(resolved) ?? zip.getEntry(href);
  if (!entry) return null;
  const ext =
    MIME_EXT[mediaType.toLowerCase()] ??
    (resolved.match(/\.(jpe?g|png|gif|webp)$/i)?.[1].toLowerCase().replace("jpeg", "jpg") ?? "jpg");
  return { bytes: entry.getData(), ext };
}

export function extractEpubMeta(bytes: Buffer): EpubMeta {
  try {
    const zip = new AdmZip(bytes);
    const container = zip.getEntry("META-INF/container.xml")?.getData().toString("utf8");
    if (!container) return EMPTY;
    const opfPath = container.match(/full-path=["']([^"']+)["']/i)?.[1];
    if (!opfPath) return EMPTY;
    const opfEntry = zip.getEntry(opfPath);
    if (!opfEntry) return EMPTY;
    const opf = opfEntry.getData().toString("utf8");
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";

    // Series: Calibre's meta pair, else EPUB3 belongs-to-collection.
    let series = metaContent(opf, "calibre:series");
    let seriesIndexRaw = metaContent(opf, "calibre:series_index");
    if (!series) {
      series = metaProperty(opf, "belongs-to-collection");
      seriesIndexRaw = seriesIndexRaw ?? metaProperty(opf, "group-position");
    }
    const seriesIndex = seriesIndexRaw != null && seriesIndexRaw !== "" ? Number(seriesIndexRaw) : null;

    let cover: EpubMeta["cover"] = null;
    try {
      cover = findCover(zip, opf, opfDir);
    } catch {
      // A broken cover must not cost us the text metadata.
    }

    return {
      title: dcText(opf, "title"),
      author: dcText(opf, "creator"),
      series: series || null,
      seriesIndex: seriesIndex != null && Number.isFinite(seriesIndex) ? seriesIndex : null,
      language: dcText(opf, "language"),
      description: dcText(opf, "description"),
      cover,
    };
  } catch {
    return EMPTY;
  }
}
