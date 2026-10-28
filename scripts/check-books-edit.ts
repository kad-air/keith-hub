#!/usr/bin/env node
//
// 🔴 THE "EDIT THE FILE, KEEP THE PLACE" GATE.
//
//   npm run check:books:edit       (standalone)
//   npm run build                  (via prebuild)
//
// Editing a book's own file (a new cover, a fixed title) changes its bytes,
// and the kosync document key every device computes is a hash of those bytes.
// Done naively that silently strands every device's position on a key no
// file has any more — no error anywhere, just a book that "starts over".
// Two halves keep it from happening, and this gate pins both:
//
//   1. lib/books/epubEdit.ts touches the OPF and the cover image and NOTHING
//      else — every other entry comes back byte-identical and the spine list
//      is unchanged, so an x-pointer (DocFragment[N] over the spine + an
//      element path in that chapter) means the same place in both files.
//   2. replaceBookFile + rekeyDocument move the position, the reading
//      history and every older alias to the new key in one transaction, and
//      kosync GET/PUT resolve the OLD key to it — a device still holding the
//      old copy reads and writes the SAME position as one holding the new
//      copy, and the server always echoes the key the device sent.
//
// Plus: the old file is archived and can be restored (aliases stay flat, no
// self-alias), refusals leave nothing behind, and a DB failure mid-replace
// puts the old file back.
//
// Hermetic: temp cwd before first getDb().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixtureBytes = fs.readFileSync(path.resolve(repoRoot, "books-fixture/fixture.epub"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-edit-check-"));
process.chdir(tmp);

const { editEpub, EpubEditError, openEpub, spinePaths, sniffImage } = await import("../lib/books/epubEdit.ts");
const { writeEpub } = await import("../lib/books/zip.ts");
const { extractEpubMeta } = await import("../lib/books/epubMeta.ts");
const { partialMd5 } = await import("../lib/books/partialMd5.ts");
const store = await import("../lib/books/store.ts");
const kosync = await import("../lib/books/kosync.ts");
const { bookEntry } = await import("../lib/books/opds.ts");
const { getDb } = await import("../lib/db.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}
function throwsCode(fn: () => unknown, code: string): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return (err as { code?: string }).code === code;
  }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function entriesOf(bytes: Buffer): Map<string, Buffer> {
  const zip = new AdmZip(bytes);
  return new Map(zip.getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName, e.getData()]));
}
/** Names whose bytes differ (or exist on one side only). */
function diff(a: Buffer, b: Buffer): string[] {
  const x = entriesOf(a);
  const y = entriesOf(b);
  const names = new Set([...x.keys(), ...y.keys()]);
  return [...names].filter((n) => !x.has(n) || !y.has(n) || !x.get(n)!.equals(y.get(n)!)).sort();
}
function mimetypeFirstStored(bytes: Buffer): boolean {
  return (
    bytes.readUInt32LE(0) === 0x04034b50 &&
    bytes.readUInt16LE(8) === 0 &&
    bytes.subarray(30, 38).toString("latin1") === "mimetype"
  );
}
function spineOf(bytes: Buffer): string[] {
  const { opf, opfPath } = openEpub(bytes);
  return spinePaths(opf, opfPath);
}

// Tiny real images: a 1×1 PNG and a minimal JPEG header are enough for the
// sniffer and for extraction (nothing here decodes pixels).
const PNG_A = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d4944415478da63f8cfc0f01f0005000201" + "8f0d2a0b0000000049454e44ae426082",
  "hex",
);
const PNG_B = Buffer.concat([PNG_A, Buffer.from("not-the-same-png")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-fixture-cover"), Buffer.from([0xff, 0xd9])]);

// A second, richer book: EPUB2, OPF in a subfolder, a cover PAGE that is
// itself spine item 1 and points at images/cover.jpg, an unrelated
// "cover.jpg" elsewhere that must NOT be rewritten, opf:file-as on the
// author, and a font-obfuscation encryption.xml (not DRM — must survive).
function buildRichBook(withCover = true): Buffer {
  const chapters = [1, 2, 3].map((n) => ({
    name: `OEBPS/text/ch${n}.xhtml`,
    data: Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch ${n}</title></head>` +
        `<body><section><h1>Chapter ${n}</h1>${Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i + 1} of chapter ${n}, in which things happen.</p>`).join("")}` +
        (n === 2 ? `<p><img src="../extras/cover.jpg" alt=""/></p>` : "") +
        `</section></body></html>`,
    ),
  }));
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId" opf:scheme="UUID">urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</dc:identifier>
    <dc:title>the_weird_name (z-lib.org) [EPUB]</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Writer, Wanda">Wanda Writer</dc:creator>
    <dc:language>en</dc:language>
${withCover ? '    <meta name="cover" content="cover-image"/>\n' : ""}  </metadata>
  <manifest>
${withCover ? '    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg"/>\n    <item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>\n' : ""}    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="extra" href="extras/cover.jpg" media-type="image/jpeg"/>
    <item id="font" href="fonts/serif.ttf" media-type="application/vnd.ms-opentype"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
${withCover ? '    <itemref idref="cover-page" linear="no"/>\n' : ""}    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
${withCover ? '  <guide><reference type="cover" title="Cover" href="text/cover.xhtml"/></guide>\n' : ""}</package>`;
  const entries = [
    {
      name: "META-INF/container.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      ),
    },
    {
      name: "META-INF/encryption.xml",
      data: Buffer.from(
        `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><enc:CipherData><enc:CipherReference URI="OEBPS/fonts/serif.ttf"/></enc:CipherData></enc:EncryptedData></encryption>`,
      ),
    },
    { name: "OEBPS/content.opf", data: Buffer.from(opf) },
    ...(withCover
      ? [
          { name: "OEBPS/images/cover.jpg", data: JPEG },
          {
            name: "OEBPS/text/cover.xhtml",
            data: Buffer.from(
              `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>Cover</title></head><body><div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><image width="600" height="800" xlink:href="../images/cover.jpg"/></svg></div></body></html>`,
            ),
          },
        ]
      : []),
    ...chapters,
    { name: "OEBPS/extras/cover.jpg", data: Buffer.concat([JPEG, Buffer.from("extra")]) },
    { name: "OEBPS/fonts/serif.ttf", data: Buffer.from("obfuscated-font-bytes-that-must-never-change") },
    { name: "OEBPS/toc.ncx", data: Buffer.from(`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap/></ncx>`) },
  ];
  return writeEpub(entries);
}

console.log("check:books:edit — edit the file, keep the place\n");

// ── 1. epubEdit: the OPF and the cover, nothing else ──────────────────────
console.log("epubEdit");
{
  const { bytes, changed } = editEpub(fixtureBytes, { title: "A Better Title & Co" });
  assert(extractEpubMeta(bytes).title === "A Better Title & Co", "a title edit is what the file's own OPF now says (entities escaped)");
  assert(extractEpubMeta(bytes).author === extractEpubMeta(fixtureBytes).author, "the author is untouched by a title edit");
  assert(JSON.stringify(diff(fixtureBytes, bytes)) === JSON.stringify(["OEBPS/content.opf"]), "🔴 a title edit changes the OPF and NO other entry");
  assert(JSON.stringify(changed) === JSON.stringify(["OEBPS/content.opf"]), "…and reports exactly that");
  assert(JSON.stringify(spineOf(bytes)) === JSON.stringify(spineOf(fixtureBytes)), "🔴 the spine is unchanged");
  assert(mimetypeFirstStored(bytes), "mimetype is the first entry and STORED (OCF)");
  assert(sha(editEpub(fixtureBytes, { title: "A Better Title & Co" }).bytes) === sha(bytes), "deterministic: the same edit mints the same bytes");
  assert(partialMd5(bytes) !== partialMd5(fixtureBytes), "the edited file has a NEW sync key (which is why part 2 exists)");
  const opf = entriesOf(bytes).get("OEBPS/content.opf")!.toString("utf8");
  assert(opf.includes("urn:uuid:11111111-2222-3333-4444-555555555555"), "dc:identifier untouched (font obfuscation keys off it)");
}
{
  const rich = buildRichBook();
  const { bytes } = editEpub(rich, { title: "The Weird Name, Fixed", author: "Wanda Q. Writer", series: "Fixes", seriesIndex: 2 });
  const meta = extractEpubMeta(bytes);
  assert(meta.title === "The Weird Name, Fixed" && meta.author === "Wanda Q. Writer", "title + author on an EPUB2 book with the OPF in a subfolder");
  assert(meta.series === "Fixes" && meta.seriesIndex === 2, "series added where there was none");
  const opf = entriesOf(bytes).get("OEBPS/content.opf")!.toString("utf8");
  assert(!/file-as=/.test(opf) && /opf:role="aut"/.test(opf), "the stale opf:file-as is dropped, other creator attributes kept");
  assert(JSON.stringify(diff(rich, bytes)) === JSON.stringify(["OEBPS/content.opf"]), "🔴 only the OPF changed");
  const removed = extractEpubMeta(editEpub(bytes, { series: null }).bytes);
  assert(removed.series === null && removed.seriesIndex === null, "series: null removes the series and its index");
  assert(diff(rich, bytes).every((n) => n !== "OEBPS/fonts/serif.ttf"), "the obfuscated font is byte-identical");
}

console.log("\ncovers");
{
  // Same format, in place: the PNG fixture gets a different PNG.
  const { bytes, changed } = editEpub(fixtureBytes, { cover: PNG_B });
  assert(extractEpubMeta(bytes).cover?.bytes.equals(PNG_B) === true, "same-format cover: replaced in place, extracted back exactly");
  assert(JSON.stringify(diff(fixtureBytes, bytes)) === JSON.stringify(["OEBPS/cover.png"]), "…and NOTHING else changed, not even the OPF");
  assert(JSON.stringify(changed) === JSON.stringify(["OEBPS/cover.png"]), "…and reports exactly that");
}
{
  // Different format: a PNG onto the rich book's JPEG cover — renamed, and
  // the cover page's xlink:href follows; the unrelated extras/cover.jpg (same
  // basename, different path, referenced from ch2) must not.
  const rich = buildRichBook();
  const { bytes } = editEpub(rich, { cover: PNG_A });
  const e = entriesOf(bytes);
  const meta = extractEpubMeta(bytes);
  assert(meta.cover?.bytes.equals(PNG_A) === true && meta.cover?.ext === "png", "format change: the new cover is found via the OPF, as a png");
  assert(e.has("OEBPS/images/cover.png") && !e.has("OEBPS/images/cover.jpg"), "the image is renamed to the right extension");
  assert(e.get("OEBPS/text/cover.xhtml")!.toString().includes('xlink:href="../images/cover.png"'), "the cover page now points at the new name");
  assert(e.get("OEBPS/text/ch2.xhtml")!.equals(entriesOf(rich).get("OEBPS/text/ch2.xhtml")!), "🔴 an unrelated cover.jpg reference elsewhere is NOT rewritten");
  assert(
    JSON.stringify(diff(rich, bytes)) ===
      JSON.stringify(["OEBPS/content.opf", "OEBPS/images/cover.jpg", "OEBPS/images/cover.png", "OEBPS/text/cover.xhtml"]),
    "only the OPF, the image and the cover page changed",
  );
  assert(JSON.stringify(spineOf(bytes)) === JSON.stringify(spineOf(rich)), "🔴 the spine is unchanged (cover page still DocFragment 1)");
}
{
  // No cover at all: one is added beside the OPF, never to the spine.
  const bare = buildRichBook(false);
  const { bytes } = editEpub(bare, { cover: JPEG });
  assert(extractEpubMeta(bytes).cover?.bytes.equals(JPEG) === true, "a book with no cover gets one the OPF points at");
  assert(JSON.stringify(spineOf(bytes)) === JSON.stringify(spineOf(bare)), "🔴 …and the spine is unchanged (no cover PAGE inserted)");
  const fx = editEpub(fixtureBytes, { title: "x" }).bytes; // EPUB3 path sanity
  assert(sniffImage(PNG_A)?.mime === "image/png" && sniffImage(JPEG)?.mime === "image/jpeg" && sniffImage(fx) === null, "images are sniffed by content, not name");
}

console.log("\nrefusals");
assert(throwsCode(() => editEpub(fixtureBytes, { cover: Buffer.from("<svg/>") }), "bad-cover"), "a cover that isn't JPEG/PNG/GIF/WebP is refused");
assert(throwsCode(() => editEpub(fixtureBytes, {}), "no-change"), "an empty edit is refused");
assert(throwsCode(() => editEpub(Buffer.from("not a zip"), { title: "x" }), "not-an-epub"), "a non-zip is refused");
{
  const z = new AdmZip(fixtureBytes);
  const entries = z.getEntries().filter((e) => e.entryName !== "mimetype").map((e) => ({ name: e.entryName, data: e.getData() }));
  entries.push({
    name: "META-INF/encryption.xml",
    data: Buffer.from(
      `<encryption xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`,
    ),
  });
  assert(throwsCode(() => editEpub(writeEpub(entries), { title: "x" }), "drm"), "an ADEPT-encrypted file is refused, never rebuilt");
}

// ── 2. replaceBookFile + kosync: the place follows the file ───────────────
console.log("\nreplaceBookFile + kosync");
const wire = md5("pw");
kosync.createUser("reader", wire);
const { book: b0 } = store.ingestBook(fixtureBytes, "The Fixture Book.epub");
store.setToRead(b0.id, true);
const A = b0.partialMd5;
const X1 = "/body/DocFragment[1]/body/p[120]/text()[1].4";
const X2 = "/body/DocFragment[1]/body/p[450]/text()[1].17";
kosync.putProgress("reader", { document: A, progress: X1, percentage: 0.12, device: "X3", device_id: "x3" });
kosync.putProgress("reader", { document: A, progress: X2, percentage: 0.45, device: "X3", device_id: "x3" });
const eventsBefore = (getDb().prepare(`SELECT COUNT(*) AS n FROM reading_events`).get() as { n: number }).n;
const entryBefore = bookEntry(b0, "/opds/k/v1.2");

const edit1 = editEpub(fs.readFileSync(store.bookFilePath(b0)), { title: "Retitled" });
await new Promise((r) => setTimeout(r, 5)); // so updated_at can only move forward
const r1 = store.replaceBookFile(b0.id, edit1.bytes, { edit: { title: "Retitled" } });
const B = r1.book.partialMd5;
assert(B !== A && B === partialMd5(edit1.bytes), "the row's sync key is the new file's");
assert(r1.book.id === b0.id && r1.book.toRead && r1.book.addedAt === b0.addedAt, "same book id, To Read flag and added date");
assert(r1.book.title === "Retitled" && r1.book.updatedAt > b0.updatedAt, "title applied to the row, updated_at moved (the OPDS <updated>)");
assert(sha(fs.readFileSync(store.bookFilePath(b0))) === r1.book.sha256, "the stored file IS the new bytes");
assert(fs.readFileSync(path.join(store.booksDir(), b0.id, "versions", `${b0.sha256}.epub`)).equals(fixtureBytes), "🔴 the old file is archived byte-identical");
assert(r1.textChanged === false, "an OPF-only edit reports textChanged=false (positions exact)");
const pa = kosync.getProgress("reader", A);
const pb = kosync.getProgress("reader", B);
assert(pa?.progress === X2 && pa?.percentage === 0.45, "🔴 GET with the OLD key still returns the position (device holding the old copy)");
assert(pb?.progress === X2 && pb?.percentage === 0.45, "🔴 GET with the NEW key returns the same position (device holding the new copy)");
assert(pa?.document === A && pb?.document === B, "🔴 each GET echoes the key the device asked with");
const rows = getDb().prepare(`SELECT document FROM kosync_progress`).all() as Array<{ document: string }>;
assert(rows.length === 1 && rows[0].document === B, "exactly one stored position, under the new key");
const evDocs = getDb().prepare(`SELECT DISTINCT document FROM reading_events`).all() as Array<{ document: string }>;
const eventsAfter = (getDb().prepare(`SELECT COUNT(*) AS n FROM reading_events`).get() as { n: number }).n;
assert(evDocs.length === 1 && evDocs[0].document === B && eventsAfter === eventsBefore, "reading history re-keyed whole: same events, new key");

const X3 = "/body/DocFragment[1]/body/p[600]/text()[1].2";
const put = kosync.putProgress("reader", { document: A, progress: X3, percentage: 0.6, device: "X3", device_id: "x3" });
assert(put.document === A, "a PUT with the old key echoes the old key");
assert(kosync.getProgress("reader", B)?.progress === X3, "🔴 …and lands on the shared position the new copy reads");
const X4 = "/body/DocFragment[1]/body/p[700]";
kosync.putProgress("reader", { document: B, progress: X4, percentage: 0.7, device: "Sheafs", device_id: "s" });
assert(kosync.getProgress("reader", A)?.progress === X4, "🔴 a PUT with the new key is what the old copy reads next");
assert(
  (getDb().prepare(`SELECT COUNT(*) AS n FROM kosync_progress`).get() as { n: number }).n === 1,
  "still one stored position after syncs from both copies",
);

const entryAfter = bookEntry(r1.book, "/opds/k/v1.2");
assert(entryAfter !== entryBefore && entryAfter.includes(`<updated>${r1.book.updatedAt}</updated>`), "the OPDS entry carries the new <updated>");
assert(entryAfter.includes(`/cover?v=${r1.book.sha256.slice(0, 12)}`) && !entryAfter.includes(`v=${b0.sha256.slice(0, 12)}`), "the cover href changes with the file (cache-busted)");
assert(entryAfter.includes(`<id>urn:uuid:${b0.id}</id>`), "the OPDS entry id is stable");

// A second edit: A and B both resolve to C, flat.
const edit2 = editEpub(fs.readFileSync(store.bookFilePath(b0)), { cover: PNG_B });
const r2 = store.replaceBookFile(b0.id, edit2.bytes);
const C = r2.book.partialMd5;
assert(kosync.resolveDocument(A) === C && kosync.resolveDocument(B) === C, "after a second edit both older keys resolve to the newest");
assert(r2.book.title === "Retitled", "a cover-only replace keeps the row's metadata by default");
assert(
  fs.readFileSync(path.join(store.booksDir(), b0.id, r2.book.coverName!)).equals(PNG_B),
  "the hub's extracted cover is the new one",
);
assert(kosync.getProgress("reader", A)?.progress === X4, "the position survived two edits");

// Restore the ORIGINAL: A is current again, B and C alias to it, no self-alias.
const r3 = store.restoreVersion(b0.id, b0.sha256);
assert(r3.book.partialMd5 === A && sha(fs.readFileSync(store.bookFilePath(b0))) === b0.sha256, "restoring a version puts the exact original bytes back");
assert(kosync.resolveDocument(A) === A, "🔴 the restored key is not an alias of anything (no self-alias, no loop)");
assert(kosync.resolveDocument(B) === A && kosync.resolveDocument(C) === A, "every later key now resolves to the restored one");
assert(JSON.stringify(kosync.aliasesOf(A).sort()) === JSON.stringify([B, C].sort()), "aliases are flat");
assert(kosync.getProgress("reader", C)?.progress === X4, "the position survived the restore, from every key");
assert(store.listVersions(b0.id).length === 3, "all three files are kept as versions");

console.log("\nrefusals + rollback");
assert(throwsCode(() => store.replaceBookFile(b0.id, fixtureBytes), "same-file"), "replacing with identical bytes is refused");
const { book: other } = store.ingestBook(buildRichBook(), "rich.epub");
assert(throwsCode(() => store.replaceBookFile(b0.id, fs.readFileSync(store.bookFilePath(other))), "duplicate"), "bytes that are another book are refused");
assert(throwsCode(() => store.restoreVersion(b0.id, "f".repeat(64)), "no-version"), "an unknown version is refused");
assert(throwsCode(() => store.replaceBookFile("nope", edit1.bytes), "not-found"), "an unknown book is refused");
{
  const changedText = (() => {
    const z = new AdmZip(fs.readFileSync(store.bookFilePath(other)));
    const entries = z.getEntries().filter((e) => !e.isDirectory && e.entryName !== "mimetype").map((e) => ({ name: e.entryName, data: e.getData() }));
    const ch = entries.find((e) => e.name === "OEBPS/text/ch1.xhtml")!;
    ch.data = Buffer.from(ch.data.toString().replace("Paragraph 1 of", "Paragraph one of"));
    return writeEpub(entries);
  })();
  assert(store.replaceBookFile(other.id, changedText).textChanged === true, "a replacement that changes chapter text reports textChanged=true");
}
{
  // Rollback: break the transaction and the old file must be back on disk,
  // the row untouched, the position where it was.
  const before = store.getBook(b0.id)!;
  getDb().exec(`DROP TABLE kosync_aliases`);
  let threw = false;
  try {
    store.replaceBookFile(b0.id, edit1.bytes);
  } catch {
    threw = true;
  }
  const after = store.getBook(b0.id)!;
  assert(threw, "a DB failure mid-replace throws");
  assert(sha(fs.readFileSync(store.bookFilePath(b0))) === before.sha256, "🔴 …and the old file is put back");
  assert(after.partialMd5 === before.partialMd5 && after.sha256 === before.sha256, "…and the row still names it");
  assert(
    (getDb().prepare(`SELECT progress FROM kosync_progress WHERE document = ?`).get(A) as { progress: string } | undefined)?.progress === X4,
    "…and the position is where it was",
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\ncheck:books:edit FAILED (${failures})`);
  process.exit(1);
}
console.log("\ncheck:books:edit OK");
