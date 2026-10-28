import AdmZip from "adm-zip";
import { inspectEncryption } from "./adept.ts";
import { writeEpub, type ZipEntry } from "./zip.ts";

// Rewriting a book's OWN metadata and cover — the edits a reader actually
// shows once the file is on the device (the OPDS title is the DB row; the
// title on the X3's home screen, in Readest's library and in Sheafs is the
// file's OPF).
//
// 🔴 What this may touch, and nothing else:
//   - the OPF's <metadata> block (dc:title, dc:creator, the series metas, the
//     cover pointer, and a new cover <item> in <manifest> when a book had none)
//   - the cover IMAGE entry (replaced in place, or renamed when its format
//     changes — then the attribute values that pointed at the old name, which
//     in practice is the cover page's <img src>)
// Never the spine, never a chapter's text, never dc:identifier (IDPF font
// obfuscation keys off it). That is the whole reason a position survives the
// edit: an x-pointer is DocFragment[N] over the spine plus an element path in
// that chapter, and neither moves. check:books:edit asserts every other entry
// comes back byte-identical and the spine list is unchanged.
//
// The OUTPUT is a different file, so it has a different partial MD5 — the
// sync key every device computes. Carrying progress across that change is
// replaceBookFile's job (store.ts), not this module's. This module is pure:
// bytes in, bytes out, no db, no fs.
//
// Deterministic (zip.ts's fixed timestamps), so the same edit on the same
// bytes always mints the same new key.

export type EpubEdit = {
  title?: string;
  author?: string;
  /** null removes the series. */
  series?: string | null;
  seriesIndex?: number | null;
  cover?: Buffer;
};

export type EpubEditErrorCode = "not-an-epub" | "drm" | "no-opf" | "bad-cover" | "no-change";

export class EpubEditError extends Error {
  // No TS parameter properties: the gates run under node's type stripping.
  code: EpubEditErrorCode;
  constructor(code: EpubEditErrorCode, message: string) {
    super(message);
    this.name = "EpubEditError";
    this.code = code;
  }
}

const IMAGE_TYPES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    ext: "png",
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: "image/gif", ext: "gif", test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")) },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

/** What an image's bytes ARE, by magic number — never by file name. */
export function sniffImage(bytes: Buffer): { mime: string; ext: string } | null {
  const hit = IMAGE_TYPES.find((t) => t.test(bytes));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

export function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function attrOf(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`\\s${attr}=["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

function setAttr(tag: string, attr: string, value: string): string {
  const re = new RegExp(`(\\s${attr}=)(["'])[^"']*\\2`, "i");
  if (re.test(tag)) return tag.replace(re, `$1"${escXml(value)}"`);
  return tag.replace(/\s*(\/?)>$/, ` ${attr}="${escXml(value)}"$1>`);
}

/** Insert `xml` just before </metadata> (any prefix). */
function intoMetadata(opf: string, xml: string): string {
  const m = opf.match(/<\/(?:[A-Za-z0-9]+:)?metadata>/i);
  if (!m || m.index == null) throw new EpubEditError("no-opf", "OPF has no </metadata>");
  return opf.slice(0, m.index) + `  ${xml}\n  ` + opf.slice(m.index);
}

/** Replace the text of the FIRST <dc:tag> (keeping its attributes), or add one. */
function setDc(opf: string, tag: string, value: string, dropAttrs: string[] = []): string {
  const re = new RegExp(
    `<((?:[A-Za-z0-9]+:)?${tag})(\\s[^>]*)?>[\\s\\S]*?</(?:[A-Za-z0-9]+:)?${tag}>`,
    "i",
  );
  const m = opf.match(re);
  if (m && m.index != null) {
    let attrs = m[2] ?? "";
    for (const a of dropAttrs) attrs = attrs.replace(new RegExp(`\\s${a}=(["'])[^"']*\\1`, "i"), "");
    return opf.slice(0, m.index) + `<${m[1]}${attrs}>${escXml(value)}</${m[1]}>` + opf.slice(m.index + m[0].length);
  }
  return intoMetadata(opf, `<dc:${tag}>${escXml(value)}</dc:${tag}>`);
}

/** EPUB2-style <meta name="..." content="..."/>: set, add, or (null) remove. */
function setNamedMeta(opf: string, name: string, value: string | null): string {
  const re = new RegExp(`[ \\t]*<meta\\s[^>]*name=["']${name.replace(/[.:]/g, "\\$&")}["'][^>]*>(?:\\s*</meta>)?\\n?`, "i");
  const m = opf.match(re);
  if (value == null) return m ? opf.replace(re, "") : opf;
  if (m) {
    const tag = m[0].match(/<meta\s[^>]*>/i)![0];
    return opf.replace(tag, setAttr(tag, "content", value));
  }
  return intoMetadata(opf, `<meta name="${escXml(name)}" content="${escXml(value)}"/>`);
}

/** EPUB3 <meta property="...">text</meta>: set the text if present (never added). */
function setPropertyMetaText(opf: string, property: string, value: string | null): string {
  const re = new RegExp(`(<meta\\s[^>]*property=["']${property}["'][^>]*>)[\\s\\S]*?(</meta>)`, "i");
  if (!re.test(opf)) return opf;
  if (value == null) {
    return opf.replace(new RegExp(`[ \\t]*<meta\\s[^>]*property=["']${property}["'][^>]*>[\\s\\S]*?</meta>\\n?`, "i"), "");
  }
  return opf.replace(re, (_, open: string, close: string) => `${open}${escXml(value)}${close}`);
}

function dirOf(p: string): string {
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
}

/** Resolve an href (relative to `baseDir`, which ends in "/" or is "") to a zip path. */
function resolveHref(baseDir: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0]);
  const parts = (baseDir + clean).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** The ordered spine of hrefs, as zip paths — what an x-pointer's DocFragment counts over. */
export function spinePaths(opf: string, opfPath: string): string[] {
  const base = dirOf(opfPath);
  const manifest = new Map<string, string>();
  for (const item of opf.match(/<(?:[A-Za-z0-9]+:)?item\s[^>]*>/gi) ?? []) {
    const id = attrOf(item, "id");
    const href = attrOf(item, "href");
    if (id && href) manifest.set(id, resolveHref(base, href));
  }
  const spineBlock = opf.match(/<(?:[A-Za-z0-9]+:)?spine\b[\s\S]*?<\/(?:[A-Za-z0-9]+:)?spine>/i)?.[0] ?? "";
  return (spineBlock.match(/<(?:[A-Za-z0-9]+:)?itemref\s[^>]*>/gi) ?? [])
    .map((r) => manifest.get(attrOf(r, "idref") ?? "") ?? `#missing:${attrOf(r, "idref")}`);
}

export type OpenedEpub = {
  entries: ZipEntry[];
  opfPath: string;
  opf: string;
};

/** Read every entry in archive order (directories dropped, mimetype excluded). */
export function openEpub(bytes: Buffer): OpenedEpub {
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    throw new EpubEditError("not-an-epub", "not a zip archive");
  }
  const entries: ZipEntry[] = zip
    .getEntries()
    .filter((e) => !e.isDirectory && e.entryName !== "mimetype")
    .map((e) => ({ name: e.entryName, data: e.getData() }));
  const container = entries.find((e) => e.name === "META-INF/container.xml")?.data.toString("utf8");
  const opfPath = container?.match(/full-path=["']([^"']+)["']/i)?.[1];
  const opfEntry = opfPath ? entries.find((e) => e.name === opfPath) : undefined;
  if (!opfPath || !opfEntry) throw new EpubEditError("no-opf", "no OPF found via META-INF/container.xml");
  return { entries, opfPath, opf: opfEntry.data.toString("utf8") };
}

function findCoverItem(opf: string): string | null {
  const items = opf.match(/<(?:[A-Za-z0-9]+:)?item\s[^>]*>/gi) ?? [];
  const byProp = items.find((t) => /properties=["'][^"']*cover-image[^"']*["']/i.test(t));
  if (byProp) return byProp;
  const meta = opf.match(/<meta\s[^>]*name=["']cover["'][^>]*>/i)?.[0];
  const id = meta ? attrOf(meta, "content") : null;
  return id ? (items.find((t) => attrOf(t, "id") === id) ?? null) : null;
}

const TEXT_ENTRY = /\.(x?html?|xml|ncx|opf|css|svg)$/i;

/**
 * Apply `edit` to an epub. Returns the new bytes and which entries changed.
 * Throws EpubEditError — never returns a half-edited book.
 */
export function editEpub(bytes: Buffer, edit: EpubEdit): { bytes: Buffer; changed: string[] } {
  // An ADEPT-encrypted file is refused, not edited: rebuilding it would keep
  // ciphertext the reader can't open. (The upload path never lets one onto
  // the volume, so this is belt-and-braces for files edited off-hub.)
  if (inspectEncryption(bytes).kind === "adept") {
    throw new EpubEditError("drm", "the file is DRM-encrypted");
  }
  const opened = openEpub(bytes);
  const { entries, opfPath } = opened;
  let opf = opened.opf;
  const originalOpf = opf;
  const changed = new Set<string>();
  const opfDir = dirOf(opfPath);

  if (edit.title != null) {
    const t = edit.title.trim();
    if (!t) throw new EpubEditError("no-change", "title cannot be empty");
    opf = setDc(opf, "title", t);
  }
  if (edit.author != null) {
    const a = edit.author.trim();
    if (!a) throw new EpubEditError("no-change", "author cannot be empty");
    // opf:file-as is the old author's sort key; leaving it would sort the
    // new name under the old one.
    opf = setDc(opf, "creator", a, ["opf:file-as", "file-as"]);
  }
  if (edit.series !== undefined) {
    const s = edit.series?.trim() || null;
    opf = setNamedMeta(opf, "calibre:series", s);
    opf = setPropertyMetaText(opf, "belongs-to-collection", s);
    if (s == null) {
      opf = setNamedMeta(opf, "calibre:series_index", null);
      opf = setPropertyMetaText(opf, "group-position", null);
    }
  }
  if (edit.seriesIndex !== undefined && edit.series !== null) {
    const v = edit.seriesIndex == null ? null : String(edit.seriesIndex);
    opf = setNamedMeta(opf, "calibre:series_index", v);
    opf = setPropertyMetaText(opf, "group-position", v);
  }

  if (edit.cover) {
    const kind = sniffImage(edit.cover);
    if (!kind) throw new EpubEditError("bad-cover", "cover is not a JPEG, PNG, GIF or WebP image");
    const item = findCoverItem(opf);
    if (item) {
      const href = attrOf(item, "href")!;
      const oldPath = resolveHref(opfDir, href);
      const oldMime = (attrOf(item, "media-type") ?? "").toLowerCase();
      if (oldMime === kind.mime || (sniffImage(entries.find((e) => e.name === oldPath)?.data ?? Buffer.alloc(0))?.mime === kind.mime)) {
        // Same format: replace the bytes in place, every reference stays valid.
        const entry = entries.find((e) => e.name === oldPath);
        if (!entry) throw new EpubEditError("bad-cover", `cover item points at a missing entry (${oldPath})`);
        entry.data = edit.cover;
        changed.add(oldPath);
        if (oldMime !== kind.mime) opf = opf.replace(item, setAttr(item, "media-type", kind.mime));
      } else {
        // Different format: same directory and stem, the right extension, and
        // every attribute value that pointed at the old file now points at
        // the new one (in practice the cover page's <img>/<image>).
        const oldBase = oldPath.slice(oldPath.lastIndexOf("/") + 1);
        const stem = oldBase.includes(".") ? oldBase.slice(0, oldBase.lastIndexOf(".")) : oldBase;
        const newBase = `${stem}.${kind.ext}`;
        const newPath = dirOf(oldPath) + newBase;
        if (entries.some((e) => e.name === newPath)) {
          throw new EpubEditError("bad-cover", `cannot rename the cover to ${newPath}: that entry exists`);
        }
        const idx = entries.findIndex((e) => e.name === oldPath);
        if (idx < 0) throw new EpubEditError("bad-cover", `cover item points at a missing entry (${oldPath})`);
        entries[idx] = { name: newPath, data: edit.cover };
        changed.add(oldPath);
        changed.add(newPath);
        const newHref = href.slice(0, href.length - oldBase.length) + newBase;
        let newItem = setAttr(item, "href", newHref);
        newItem = setAttr(newItem, "media-type", kind.mime);
        opf = opf.replace(item, newItem);
        // Rewrite references in the other text entries. Only attribute values
        // whose RESOLVED path is the old cover change, so an unrelated
        // "cover.jpg" elsewhere in the book is left alone.
        for (const e of entries) {
          if (e.name === opfPath || !TEXT_ENTRY.test(e.name)) continue;
          const text = e.data.toString("utf8");
          const base = dirOf(e.name);
          const next = text.replace(
            /(\s(?:src|href|xlink:href)=)(["'])([^"']+)\2/gi,
            (whole, pre: string, q: string, val: string) => {
              if (/^[a-z]+:/i.test(val)) return whole;
              if (resolveHref(base, val) !== oldPath) return whole;
              const vBase = val.split("#")[0];
              const swapped = vBase.slice(0, vBase.length - oldBase.length) + newBase;
              return `${pre}${q}${swapped}${val.slice(vBase.length)}${q}`;
            },
          );
          if (next !== text) {
            e.data = Buffer.from(next, "utf8");
            changed.add(e.name);
          }
        }
      }
    } else {
      // No cover at all: add one beside the OPF, flagged both ways (EPUB3
      // properties, EPUB2 meta). NOT added to the spine — a new spine item
      // would shift every DocFragment index and break every x-pointer.
      let id = "hub-cover";
      while (new RegExp(`\\sid=["']${id}["']`).test(opf)) id += "-x";
      const name = `hub-cover.${kind.ext}`;
      const zipPath = opfDir + name;
      if (entries.some((e) => e.name === zipPath)) {
        throw new EpubEditError("bad-cover", `cannot add ${zipPath}: that entry exists`);
      }
      const epub3 = /<package\b[^>]*\sversion=["']3/i.test(opf);
      const itemXml = `<item id="${id}" href="${name}" media-type="${kind.mime}"${epub3 ? ' properties="cover-image"' : ""}/>`;
      const close = opf.match(/<\/(?:[A-Za-z0-9]+:)?manifest>/i);
      if (!close || close.index == null) throw new EpubEditError("no-opf", "OPF has no </manifest>");
      opf = opf.slice(0, close.index) + `  ${itemXml}\n  ` + opf.slice(close.index);
      opf = setNamedMeta(opf, "cover", id);
      const opfIdx = entries.findIndex((e) => e.name === opfPath);
      entries.splice(opfIdx + 1, 0, { name: zipPath, data: edit.cover });
      changed.add(zipPath);
    }
  }

  if (opf !== originalOpf) {
    entries.find((e) => e.name === opfPath)!.data = Buffer.from(opf, "utf8");
    changed.add(opfPath);
  }
  if (changed.size === 0) throw new EpubEditError("no-change", "nothing to change");

  // The invariant this whole module exists for — checked on the way out, not
  // assumed: the spine is exactly what it was.
  const before = spinePaths(originalOpf, opfPath).join("\n");
  const after = spinePaths(opf, opfPath).join("\n");
  if (before !== after) throw new Error("epubEdit: the spine changed — refusing to emit");

  return { bytes: writeEpub(entries), changed: [...changed] };
}
