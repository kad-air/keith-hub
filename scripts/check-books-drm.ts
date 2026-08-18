#!/usr/bin/env node
//
// 🔴 THE "NO GHOST BOOKS" GATE.
//
//   npm run check:books:drm   (standalone)
//   npm run build             (via prebuild)
//
// Two properties, asserted on every build:
//
//   1. An epub we cannot bring into the clear is REFUSED, never ingested.
//   2. An epub we CAN bring into the clear comes out byte-for-byte readable —
//      same text, same cover, same word count as the original.
//
// Why (1) needs a gate rather than a comment: measured on a real ADEPT epub
// (The Two Towers), the pre-guard ingest path accepted it happily and produced
// 13,069 words against a true 155,347 — a "34-page" edition of a 400-page
// book, with a cover that was 139 KB of ciphertext stored as cover.jpg, and a
// catch-up phrase search that returned nothing. Every layer reported success.
// That failure has no error surface at all, which is exactly the class of bug
// this repo pins rather than trusts.
//
// 🔴 WHAT THIS GATE CANNOT SEE, stated plainly: the ADEPT fixture below is
// built by this script, so the check proves our decryptor inverts our
// encryptor and that the round trip loses nothing — it does NOT prove our
// reading of Adobe's on-disk layout is right. No independently-produced ADEPT
// file can live in this repo (it would be a DRM'ed book). The genuinely
// 🔴 WHAT FALSIFICATION SHOWED, so the next reader doesn't over-trust it:
// ten perturbations were run against this gate. Eight are caught (guard
// removed, font obfuscation misread as DRM, passthrough repacking a clean
// epub, inflate skipped, clock-derived zip timestamps, mimetype not first,
// rights.xml retained, lenient content-key length). Removing the markup
// plaintext check ALONE is NOT caught — the exact-16-byte content-key length
// check already refuses first — but removing BOTH is. The markup check is
// therefore deliberate redundancy for a wrong key that unwraps to exactly 16
// bytes, which this fixture cannot produce on demand. Keep both.
//
// external anchors it does carry: the decrypted word count is compared against
// books-fixture/expected.json, which was computed OFFLINE by a separate Python
// implementation over the original file, and the metadata against the same
// file's pinned title/author/series/cover_ext. The remaining evidence — that
// the wire layout matches Adobe's — can only come from a real fulfilled file,
// and that is a one-time confirmation, not something a build can replay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  publicEncrypt,
  constants,
  type KeyObject,
} from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixturePath = path.resolve(repoRoot, "books-fixture/fixture.epub");
const fixtureBytes = fs.readFileSync(fixturePath);
const expected = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, "books-fixture/expected.json"), "utf8"),
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-drm-check-"));
process.chdir(tmp);

const { inspectEncryption } = await import("../lib/books/adept.ts");
const { prepareForIngest, PrepareError } = await import("../lib/books/prepare.ts");
const { resetAdeptKeyCache } = await import("../lib/books/adeptKey.ts");
const { countEpubWords, resolveSpine } = await import("../lib/books/epubText.ts");
const { extractEpubMeta } = await import("../lib/books/epubMeta.ts");
const { ingestBook } = await import("../lib/books/store.ts");
const { partialMd5 } = await import("../lib/books/partialMd5.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

function useKey(der: Buffer | null): void {
  if (der) process.env.ADOBE_ADEPT_KEY = der.toString("base64");
  else delete process.env.ADOBE_ADEPT_KEY;
  resetAdeptKeyCache();
}

async function refusal(bytes: Buffer, name: string): Promise<string | null> {
  try {
    await prepareForIngest(bytes, name);
    return null;
  } catch (err) {
    return err instanceof PrepareError ? err.code : `unexpected:${String(err)}`;
  }
}

// ── Build an ADEPT-shaped epub, the way ADE lays one out ──────────────────
// Content entries are deflated, then AES-128-CBC encrypted with a fixed
// content key, IV prepended. The content key is RSA/PKCS#1-v1.5 wrapped with
// the account public key and written to rights.xml. container.xml and the OPF
// stay in the clear, which is what makes the ghost book so convincing.
//
// 🔴 This fixture's SHAPE was corrected against a real Google Play Books
// fulfilment (a copyrighted book, so not committable): the real encryption.xml
// carries NO <Compression> element — an earlier version of this fixture
// invented one, and the decryptor was briefly built around that fiction. Real
// Adobe declares only <EncryptionProperties><ResourceSize>, leaves compression
// implicit, and uses a separate `aes128-cbc-uncompressed` algorithm for
// already-compressed payloads. Both are reproduced here so the gate exercises
// the code paths that actually run in the wild.
const ADEPT_STD = "http://www.w3.org/2001/04/xmlenc#aes128-cbc";
const ADEPT_UNCOMPRESSED = "http://ns.adobe.com/adept/xmlenc#aes128-cbc-uncompressed";
const ADEPT_AES256 = "http://www.w3.org/2001/04/xmlenc#aes256-cbc";
const ENCRYPTABLE = /\.(x?html|htm|css|jpe?g|png|gif|otf|ttf)$/i;

// 🔴 The clip's plaintext is itself a valid deflate stream — an "already
// compressed" payload (video), stored under the uncompressed algorithm. This
// is what makes the uncompressed path testable: if the decryptor wrongly
// inflated it, the bytes would change into CLIP_INNER; storing raw noise
// instead would let a force-inflate bug hide behind the raw fall-back.
const CLIP_INNER = Buffer.from("STORED MEDIA CLIP CONTENT ".repeat(3), "ascii");
const CLIP_STORED = deflateRawSync(CLIP_INNER);

function buildAdept(
  source: Buffer,
  publicKey: KeyObject,
  opts: { deflate?: boolean; algo256?: boolean } = {},
) {
  const { deflate = true, algo256 = false } = opts;
  const src = new AdmZip(source);
  const out = new AdmZip();
  const contentKey = Buffer.from("0123456789abcdef", "ascii"); // 16 bytes, fixed for reproducibility
  const contentAlgo = algo256 ? ADEPT_AES256 : deflate ? ADEPT_STD : ADEPT_UNCOMPRESSED;
  const encrypted: Array<{ name: string; algo: string }> = [];

  for (const e of src.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    const data = e.getData();
    if (name !== "mimetype" && ENCRYPTABLE.test(name)) {
      const payload = deflate ? deflateRawSync(data) : data;
      const iv = Buffer.alloc(16, 7);
      const cipher = createCipheriv("aes-128-cbc", contentKey, iv);
      out.addFile(name, Buffer.concat([iv, cipher.update(payload), cipher.final()]));
      encrypted.push({ name, algo: contentAlgo });
    } else {
      out.addFile(name, data);
    }
  }

  // The uncompressed-variant path: a deflate-stream payload encrypted under
  // aes128-cbc-uncompressed. decryptAdept must AES-decrypt it but NOT inflate,
  // handing back CLIP_STORED (the still-deflated bytes) unchanged.
  const vIv = Buffer.alloc(16, 9);
  const vCipher = createCipheriv("aes-128-cbc", contentKey, vIv); // Node auto-pads PKCS#7
  out.addFile(
    "OEBPS/media/clip.bin",
    Buffer.concat([vIv, vCipher.update(CLIP_STORED), vCipher.final()]),
  );
  encrypted.push({ name: "OEBPS/media/clip.bin", algo: ADEPT_UNCOMPRESSED });

  // 🔴 Wrap FOUR bytes of prefix ahead of the 16-byte content key, so the
  // RSA-unwrapped payload is 20 bytes and the real key is the LAST 16. This is
  // exactly the ">16 → take last-16" case DeDRM handles; without it a
  // first-16 vs last-16 bug is invisible (a 16-byte payload makes them equal).
  const wrapped = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.concat([Buffer.from([0xde, 0xad, 0xbe, 0xef]), contentKey]),
  );
  out.addFile(
    "META-INF/rights.xml",
    Buffer.from(
      `<?xml version="1.0"?><rights xmlns="http://ns.adobe.com/adept"><licenseToken>` +
        `<resource>urn:uuid:fixture</resource>` +
        `<encryptedKey>${wrapped.toString("base64")}</encryptedKey>` +
        `</licenseToken></rights>`,
    ),
  );
  out.addFile(
    "META-INF/encryption.xml",
    Buffer.from(
      `<?xml version="1.0"?>\n<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
        encrypted
          .map(
            ({ name, algo }) =>
              `<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">` +
              `<EncryptionMethod Algorithm="${algo}"/>` +
              `<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
              `<resource xmlns="http://ns.adobe.com/adept">urn:uuid:fixture</resource></KeyInfo>` +
              `<CipherData><CipherReference URI="${name}"/></CipherData>` +
              // Real Adobe: ResourceSize, NOT a Compression element.
              `<EncryptionProperties><ResourceSize>0</ResourceSize></EncryptionProperties>` +
              `</EncryptedData>`,
          )
          .join("\n") +
        `\n</encryption>`,
    ),
  );
  return out.toBuffer();
}

// An epub with obfuscated fonts and NO rights.xml — legal, DRM-free, and it
// must not be mistaken for Adobe DRM.
function buildFontObfuscated(source: Buffer): Buffer {
  const zip = new AdmZip(source);
  zip.addFile("OEBPS/fonts/mangled.otf", Buffer.alloc(64, 3));
  zip.addFile(
    "META-INF/encryption.xml",
    Buffer.from(
      `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
        `<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">` +
        `<EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>` +
        `<CipherData><CipherReference URI="OEBPS/fonts/mangled.otf"/></CipherData>` +
        `</EncryptedData></encryption>`,
    ),
  );
  return zip.toBuffer();
}

function spineText(bytes: Buffer): Map<string, string> {
  const zip = new AdmZip(bytes);
  const byName = new Map(zip.getEntries().map((e) => [e.entryName.replace(/^\.?\//, ""), e]));
  const read = (n: string) => byName.get(n.replace(/^\.?\//, ""))?.getData().toString("utf8") ?? null;
  const out = new Map<string, string>();
  for (const name of resolveSpine(read)) out.set(name, read(name) ?? "");
  return out;
}

// 🔴 Committed throwaway keys, not generated per run. A freshly generated
// "wrong" key made the wrong-key assertion PROBABILISTIC: PKCS#1 v1.5
// unpadding succeeds by chance often enough that the refusal depended on the
// draw. A gate that passes most of the time is worse than no gate.
const testKeys = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, "books-fixture/adept-test-keys.json"), "utf8"),
);
const keyDer = Buffer.from(testKeys.right_private_pkcs8_der_b64, "base64");
const otherKeyDer = Buffer.from(testKeys.wrong_private_pkcs8_der_b64, "base64");
const publicKey: KeyObject = createPublicKey({
  key: Buffer.from(testKeys.right_public_spki_der_b64, "base64"),
  format: "der",
  type: "spki",
});
// Sanity: the two keys really are different, or every "wrong key" case below
// would be quietly testing the right one.
if (
  createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" })
    .export({ format: "der", type: "pkcs8" })
    .equals(
      createPrivateKey({ key: otherKeyDer, format: "der", type: "pkcs8" }).export({
        format: "der",
        type: "pkcs8",
      }),
    )
) {
  throw new Error("fixture keys are identical — the wrong-key cases would be vacuous");
}

const adeptBytes = buildAdept(fixtureBytes, publicKey);
const fontBytes = buildFontObfuscated(fixtureBytes);

console.log("check:books:drm — a book is readable or it is refused\n");

// ── 1. Detection ──────────────────────────────────────────────────────────
console.log("detection");
assert(inspectEncryption(fixtureBytes).kind === "none", "a clean epub reads as unencrypted");
assert(inspectEncryption(adeptBytes).kind === "adept", "an ADEPT epub is identified as ADEPT");
assert(inspectEncryption(adeptBytes).hasRightsToken, "its wrapped content key is found");
assert(
  inspectEncryption(fontBytes).kind === "font-obfuscation",
  "🔴 font obfuscation is NOT reported as DRM",
);

// ── 2. The landmine: what ingesting an ADEPT file WOULD have produced ─────
console.log("\nthe ghost book (why the guard exists)");
const trueWords = expected.text.words as number;
const ghostWords = countEpubWords(adeptBytes);
assert(
  ghostWords !== null && ghostWords > 0 && ghostWords < trueWords * 0.5,
  `an encrypted epub still yields a plausible-but-wrong word count (${ghostWords} vs ${trueWords})`,
);
assert(
  extractEpubMeta(adeptBytes).title === expected.meta.title,
  "…and correct-looking metadata, because the OPF is never encrypted",
);

// ── 3. Refusals ───────────────────────────────────────────────────────────
console.log("\nrefusals");
useKey(null);
assert((await refusal(adeptBytes, "book.epub")) === "drm-no-key", "no key configured → refused");
useKey(otherKeyDer);
assert(
  (await refusal(adeptBytes, "book.epub")) === "drm-failed",
  "🔴 the WRONG key fails loudly rather than producing garbage",
);
// An .acsm is recognised as a fulfilment token, not mistaken for a corrupt
// zip. With no ADOBE_ADEPT_ACTIVATION configured (as here) it refuses for that
// reason specifically — the fulfilment path itself is covered by
// check:books:acsm, which pins the signing offline.
assert(
  (await refusal(Buffer.from("<fulfillmentToken xmlns='http://ns.adobe.com/adept'/>"), "x.acsm")) ===
    "acsm-not-activated",
  "an .acsm is refused as un-activated, not as a corrupt zip",
);
assert(
  (await refusal(Buffer.from("not a zip at all"), "x.epub")) === "not-a-book",
  "a non-zip is refused",
);
// AES-256 ADEPT is real but unsupported here — it must refuse cleanly, never
// attempt an AES-128 decrypt and ship garbage.
useKey(keyDer);
const aes256Bytes = buildAdept(fixtureBytes, publicKey, { algo256: true });
assert(
  inspectEncryption(aes256Bytes).kind === "adept",
  "an AES-256 ADEPT epub is still recognised as ADEPT",
);
assert(
  (await refusal(aes256Bytes, "aes256.epub")) === "drm-unsupported",
  "🔴 AES-256 ADEPT is refused as unsupported, not mis-decrypted",
);

// ── 4. Decryption ─────────────────────────────────────────────────────────
console.log("\ndecryption");
useKey(keyDer);
const prepared = await prepareForIngest(adeptBytes, "The Fixture Book.epub");
assert(prepared.origin === "epub-drm", "the DRM path is taken");

const clearWords = countEpubWords(prepared.bytes);
assert(
  clearWords === trueWords,
  `🔴 decrypted word count matches the offline Python reference (${clearWords} vs ${trueWords})`,
);
const meta = extractEpubMeta(prepared.bytes);
const originalMeta = extractEpubMeta(fixtureBytes);
// Raw OPF extraction, compared against the SAME layer on the original file —
// expected.meta.author is the post-normalizeMeta form ("Frances Fixture"),
// which the end-to-end section below anchors on instead.
assert(
  meta.title === originalMeta.title &&
    meta.author === originalMeta.author &&
    meta.series === originalMeta.series &&
    meta.seriesIndex === originalMeta.seriesIndex &&
    meta.language === originalMeta.language,
  "metadata survives decryption unchanged",
);
assert(meta.title === expected.meta.title, "…and still matches the pinned title");
assert(
  meta.cover !== null && meta.cover.ext === expected.meta.cover_ext,
  "the cover survives as a real image, not ciphertext",
);
const originalCover = extractEpubMeta(fixtureBytes).cover;
assert(
  originalCover != null && meta.cover != null && meta.cover.bytes.equals(originalCover.bytes),
  "…byte-identical to the original cover",
);

// The aes128-cbc-uncompressed path: decrypt but do NOT inflate. The clip must
// come back as its original STORED bytes, proving the variant is handled.
const clearZip = new AdmZip(prepared.bytes);
const clip = clearZip.getEntry("OEBPS/media/clip.bin")?.getData();
assert(
  clip != null && clip.equals(CLIP_STORED),
  "🔴 the aes128-cbc-uncompressed entry is decrypted but NOT inflated (bytes still deflated)",
);
assert(
  clip != null && inflateRawSync(clip).equals(CLIP_INNER),
  "…and those still-deflated bytes are the genuine payload",
);

const before = spineText(fixtureBytes);
const after = spineText(prepared.bytes);
assert(before.size > 0 && before.size === after.size, "the spine is the same length");
assert(
  [...before].every(([name, text]) => after.get(name) === text),
  "🔴 every spine document is byte-identical to the original",
);

// ── 5. Output shape and stability ─────────────────────────────────────────
console.log("\noutput shape");
assert(
  prepared.bytes.subarray(30, 38).toString() === "mimetype" &&
    prepared.bytes.readUInt16LE(8) === 0,
  "🔴 output is OCF-conforming: mimetype first and STORED",
);
assert(
  new AdmZip(prepared.bytes).getEntry("META-INF/rights.xml") === null &&
    new AdmZip(prepared.bytes).getEntry("META-INF/encryption.xml") === null,
  "the DRM files are gone",
);
const again = await prepareForIngest(adeptBytes, "The Fixture Book.epub");
assert(
  again.bytes.equals(prepared.bytes) && partialMd5(again.bytes) === partialMd5(prepared.bytes),
  "decryption repeats byte-for-byte within a run",
);
// 🔴 Run-to-run equality above is vacuous for a clock-derived timestamp — two
// calls a millisecond apart agree. Falsification proved it: swapping the fixed
// DOS date/time for `new Date()` sailed through. So the timestamp fields are
// asserted structurally instead. A decrypt today and the same decrypt next
// month must produce identical bytes, or a re-decrypt silently mints a new
// partial_md5 and detaches every device's progress.
function timestampFields(zipBytes: Buffer): Set<number> {
  const seen = new Set<number>();
  for (let i = 0; i + 4 <= zipBytes.length; i++) {
    if (zipBytes.readUInt32LE(i) === 0x04034b50) {
      seen.add(zipBytes.readUInt16LE(i + 10));
      seen.add(zipBytes.readUInt16LE(i + 12));
    }
  }
  return seen;
}
const stamps = timestampFields(prepared.bytes);
assert(
  stamps.size > 0 && [...stamps].every((v) => v === 0x0000 || v === 0x0021),
  "🔴 every entry carries the FIXED epoch timestamp, not the wall clock",
);

// ── 5b. Confirmation is inflate-based, and its safe failure ───────────────
// 🔴 The wrong-key defence is that a content document must INFLATE to markup —
// noise is never a valid deflate stream. A weaker "contains a '<'" check was
// tried and rejected: on a REAL Google stylesheet it false-rejected a perfect
// decryption, and on garbage it false-PASSES ~98% of the time (random bytes
// carry a '<' within 1 KB). Two consequences are pinned here:
//
//   (a) the main fixture mixes deflated XHTML with a STORED (uncompressed)
//       clip, exactly like a real book with an embedded video — the wrong key
//       is refused because the XHTML no longer inflates, the stored clip
//       notwithstanding; and
//   (b) the pathological all-STORED epub (which ADE/Google/Calibre never
//       produce — content XHTML is always deflated) cannot be confirmed and is
//       therefore REFUSED even with the RIGHT key. That is the deliberate safe
//       failure: refuse an unverifiable file rather than risk shipping garbage.
console.log("\ninflate-based confirmation (and its safe failure)");
const storedBytes = buildAdept(fixtureBytes, publicKey, { deflate: false });
assert(inspectEncryption(storedBytes).kind === "adept", "an all-STORED ADEPT epub is still ADEPT");
useKey(keyDer);
assert(
  (await refusal(storedBytes, "Stored.epub")) === "drm-failed",
  "🔴 an all-STORED epub is refused even with the RIGHT key (can't confirm — safe failure)",
);
useKey(otherKeyDer);
assert(
  (await refusal(adeptBytes, "Mixed.epub")) === "drm-failed",
  "🔴 the WRONG key on a realistic (deflated+stored) book is refused, not stored as garbage",
);
useKey(keyDer);

// ── 6. Passthrough must not touch the bytes ───────────────────────────────
console.log("\npassthrough (BOOKS_PLAN §4)");
const cleanThrough = await prepareForIngest(fixtureBytes, "The Fixture Book.epub");
assert(
  cleanThrough.bytes.equals(fixtureBytes) && cleanThrough.origin === "epub",
  "🔴 a DRM-free epub passes through BYTE-IDENTICAL — no repack, no new partial_md5",
);
assert(
  partialMd5(cleanThrough.bytes) === expected.partial_md5,
  "…and still hashes to the pinned partial_md5",
);
const fontThrough = await prepareForIngest(fontBytes, "Fonts.epub");
assert(
  fontThrough.bytes.equals(fontBytes) && fontThrough.origin === "epub",
  "🔴 a font-obfuscated epub also passes through untouched",
);

// ── 7. End to end, through the real ingest ────────────────────────────────
console.log("\nend to end");
const ingested = ingestBook(prepared.bytes, prepared.fileName);
assert(ingested.created && ingested.book.wordCount === trueWords, "the stored book has real pages");
assert(
  ingested.book.author === expected.meta.author && ingested.book.series === expected.meta.series,
  "the stored book carries the pinned normalized author/series",
);
assert(
  ingested.book.partialMd5 === partialMd5(prepared.bytes),
  "the stored sync key is the decrypted file's",
);
useKey(null);
const booksBefore = fs.existsSync(path.join(tmp, "data", "books"))
  ? fs.readdirSync(path.join(tmp, "data", "books")).length
  : 0;
assert(
  (await refusal(adeptBytes, "Refused.epub")) === "drm-no-key" &&
    (fs.existsSync(path.join(tmp, "data", "books"))
      ? fs.readdirSync(path.join(tmp, "data", "books")).length
      : 0) === booksBefore,
  "🔴 a refused upload leaves nothing on the volume",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll DRM checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
