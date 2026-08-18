import AdmZip from "adm-zip";
import {
  createDecipheriv,
  createPrivateKey,
  constants as cryptoConstants,
  privateDecrypt,
} from "crypto";
import { inflateRawSync } from "zlib";
import { writeEpub, type ZipEntry } from "./zip.ts";

// Adobe ADEPT: detection, and removal given the account key.
//
// What ADEPT actually is, inside the zip:
//   META-INF/rights.xml       <encryptedKey> — the book's AES key, RSA-wrapped
//                             with the fulfilling account's public key
//   META-INF/encryption.xml   which entries are encrypted, with what, and
//                             whether they were deflated BEFORE encryption
//   the listed entries        AES-128-CBC, IV = first 16 bytes
//
// 🔴 Unlike epubMeta.ts and epubText.ts, failure here is NOT benign and must
// never degrade. Those two return nulls so a weird file still ingests; a
// half-decrypted book would ingest too, and land in the library as readable
// bytes that are actually garbage — a wrong word count, a broken cover, and
// a phrase search that finds nothing. Every failure below throws AdeptError
// so the upload can refuse with a reason.
//
// 🔴 Font obfuscation is NOT DRM and must not be treated as such. It reuses
// encryption.xml with a different algorithm, carries no rights.xml, and is
// legal in a perfectly ordinary DRM-free epub. Rejecting those would refuse
// books that work fine today.

// 🔴 The algorithm URLs, and how they were pinned. The standard ADEPT content
// algorithm is xmlenc#aes128-cbc; Adobe also uses a private
// aes128-cbc-uncompressed variant for already-compressed payloads (video),
// where the AES plaintext must NOT be inflated. Both were confirmed against a
// real Google Play Books fulfilment (validated in scratchpad, not committable
// — the book is copyrighted), whose encryption.xml carries NEITHER a
// <Compression> element NOR AES-256; it declares the size via <ResourceSize>
// and leaves the compression implicit. So there is deliberately no
// <Compression Method> parsing here (an earlier version invented one from a
// synthetic fixture and it does not exist in the wild) — every ADEPT entry is
// try-inflate-then-fall-back-to-raw, exactly as DeDRM's ineptepub does.
const ALGO_AES128 = "http://www.w3.org/2001/04/xmlenc#aes128-cbc";
const ALGO_AES128_UNCOMPRESSED = "http://ns.adobe.com/adept/xmlenc#aes128-cbc-uncompressed";
const ALGO_AES256 = "http://www.w3.org/2001/04/xmlenc#aes256-cbc";
const ADEPT_ALGOS = new Set([ALGO_AES128, ALGO_AES128_UNCOMPRESSED]);
// The two font-mangling schemes, both harmless.
const FONT_ALGOS = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
]);

export type AdeptErrorCode =
  | "no-key" // ADEPT-encrypted, but this hub holds no account key
  | "bad-key" // the key we hold did not unwrap this book's content key
  | "unsupported" // encrypted by something that isn't ADEPT
  | "malformed"; // encryption.xml / rights.xml unreadable

export class AdeptError extends Error {
  // Plain field + assignment, not a TS parameter property: the check scripts
  // run under `node`'s type stripping, which is erasable-syntax-only.
  code: AdeptErrorCode;
  constructor(code: AdeptErrorCode, message: string) {
    super(message);
    this.name = "AdeptError";
    this.code = code;
  }
}

export type EncryptionKind =
  | "none" // no encryption.xml at all
  | "adept" // Adobe DRM — decryptable with the right key
  | "font-obfuscation" // fonts mangled, content in the clear — not DRM
  | "unknown"; // encrypted by something we can't identify

export type EncryptionInfo = {
  kind: EncryptionKind;
  /** Entry paths under ADEPT encryption (empty for every other kind). */
  encryptedPaths: string[];
  /** Whether META-INF/rights.xml carries a wrapped content key. */
  hasRightsToken: boolean;
};

type EncryptedBlock = {
  raw: string;
  algorithm: string;
  uri: string;
};

function parseBlocks(encryptionXml: string): EncryptedBlock[] {
  const blocks: EncryptedBlock[] = [];
  for (const m of encryptionXml.matchAll(/<(?:[A-Za-z0-9]+:)?EncryptedData\b[\s\S]*?<\/(?:[A-Za-z0-9]+:)?EncryptedData>/gi)) {
    const raw = m[0];
    const algorithm =
      raw.match(/<(?:[A-Za-z0-9]+:)?EncryptionMethod\b[^>]*\bAlgorithm=["']([^"']+)["']/i)?.[1] ?? "";
    const uriRaw = raw.match(/<(?:[A-Za-z0-9]+:)?CipherReference\b[^>]*\bURI=["']([^"']+)["']/i)?.[1] ?? "";
    if (!uriRaw) continue;
    let uri = uriRaw;
    try {
      uri = decodeURIComponent(uriRaw);
    } catch {
      // A literal '%' in a filename is legal; keep the raw form.
    }
    blocks.push({ raw, algorithm, uri: uri.replace(/^\.?\//, "") });
  }
  return blocks;
}

/**
 * What kind of encryption, if any, this epub carries. Never throws — it is
 * the gate the upload path consults before deciding what to do, and a file
 * too broken to inspect is reported as "none" so the normal ingest path
 * handles it exactly as it does today.
 */
export function inspectEncryption(bytes: Buffer): EncryptionInfo {
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    return { kind: "none", encryptedPaths: [], hasRightsToken: false };
  }
  const encXml = zip.getEntry("META-INF/encryption.xml")?.getData().toString("utf8");
  if (!encXml) return { kind: "none", encryptedPaths: [], hasRightsToken: false };

  const hasRightsToken = /<(?:[A-Za-z0-9]+:)?encryptedKey\b/i.test(
    zip.getEntry("META-INF/rights.xml")?.getData().toString("utf8") ?? "",
  );

  const blocks = parseBlocks(encXml);
  const adept = blocks.filter((b) => ADEPT_ALGOS.has(b.algorithm) || b.algorithm === ALGO_AES256);
  if (adept.length > 0) {
    return { kind: "adept", encryptedPaths: adept.map((b) => b.uri), hasRightsToken };
  }
  if (blocks.length > 0 && blocks.every((b) => FONT_ALGOS.has(b.algorithm))) {
    return { kind: "font-obfuscation", encryptedPaths: [], hasRightsToken };
  }
  if (blocks.length === 0) return { kind: "none", encryptedPaths: [], hasRightsToken };
  return { kind: "unknown", encryptedPaths: [], hasRightsToken };
}

function unwrapContentKey(rightsXml: string, privateKeyDer: Buffer): Buffer {
  const b64 = rightsXml.match(
    /<(?:[A-Za-z0-9]+:)?encryptedKey[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?encryptedKey>/i,
  )?.[1];
  if (!b64) throw new AdeptError("malformed", "rights.xml carries no <encryptedKey>");
  const wrapped = Buffer.from(b64.replace(/\s+/g, ""), "base64");

  // 🔴 PKCS#1 v1.5 unwrap, then take the LAST 16 bytes — DeDRM's ineptepub
  // does exactly this (`PKCS1_v1_5.decrypt(...)` then `bookkey[-16:]`), and it
  // is what a real Google Play Books key needs. Node's PKCS1 unpadding matches
  // Python's, and it THROWS on a padding failure — the primary wrong-key
  // signal (a wrong key almost never yields a valid 0x00 0x02 … 0x00 block).
  // It is not a perfect signal (a wrong key can pass PKCS1 by chance), so the
  // markup canary below is the second, content-based line of defence.
  let unwrapped: Buffer;
  try {
    const keyObject = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
    unwrapped = privateDecrypt(
      { key: keyObject, padding: cryptoConstants.RSA_PKCS1_PADDING },
      wrapped,
    );
  } catch {
    throw new AdeptError(
      "bad-key",
      "the stored Adobe key did not unwrap this book — it was fulfilled by a different account",
    );
  }
  if (unwrapped.length < 16) {
    throw new AdeptError(
      "bad-key",
      `unwrapped content key is ${unwrapped.length} bytes, need at least 16 — wrong account`,
    );
  }
  return unwrapped.subarray(unwrapped.length - 16);
}

type DecryptedEntry = { data: Buffer; inflated: boolean };

/**
 * Decrypt one entry. AES-128-CBC with the IV as the first 16 bytes (equivalent
 * to DeDRM's zero-IV-decrypt-then-discard-first-block), PKCS#7 unpad, then —
 * unless the entry is the uncompressed variant — raw-inflate, falling back to
 * the un-inflated bytes if it wasn't a deflate stream (DeDRM's `decompress`).
 * Reports whether the inflate actually happened, which is the load-bearing
 * wrong-key signal below.
 */
function decryptEntry(data: Buffer, key: Buffer, decompress: boolean): DecryptedEntry {
  if (data.length <= 16) return { data: Buffer.alloc(0), inflated: false };
  const iv = data.subarray(0, 16);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  // Manual unpad: ADE's padding is PKCS#7 but not always well-formed, and a
  // throw from Node's auto-unpad would lose the whole book over a last block.
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
  const pad = plain.length > 0 ? plain[plain.length - 1] : 0;
  if (pad > 0 && pad <= 16 && pad <= plain.length) plain = plain.subarray(0, plain.length - pad);

  if (!decompress) return { data: plain, inflated: false };
  try {
    return { data: inflateRawSync(plain), inflated: true };
  } catch {
    // Not a deflate stream — Adobe stored it raw. DeDRM does the same fall-back.
    return { data: plain, inflated: false };
  }
}

// 🔴 The wrong-key canary, and why it is inflate-based.
//
// PKCS1 is the first line of defence, but a wrong key can pass it by chance
// (~1 in 65k); then every entry decrypts to noise, and a book of noise must
// never ingest (the ghost-book failure this whole module exists to prevent).
// The naive backstop — "a markup file must contain a '<'" — is far too weak:
// measured, random bytes carry a '<' in the first 1 KB ~98% of the time, so
// garbage sails past it. The STRONG signal is that the AES plaintext of a
// content document is a valid DEFLATE stream: random noise inflates with
// probability ~0, so a single content entry that both inflates AND then reads
// as markup proves the key for the entire book (one key decrypts every entry).
//
// 🔴 CSS is deliberately excluded from the markup half, found on a real file:
// a correctly-decrypted Google stylesheet begins `img#cover_image { … }` with
// no angle bracket, so a css-inclusive check FALSELY rejected a perfect
// decryption. XHTML/OPF/NCX/SVG always carry a `<` almost immediately.
const MARKUP_CANARY = /\.(x?html|htm|opf|ncx|svg)$/i;

function looksLikeMarkup(data: Buffer): boolean {
  return data.length > 0 && data.subarray(0, 1024).includes(0x3c); // '<'
}

/**
 * Strip ADEPT DRM, returning a clean epub.
 *
 * The output is a freshly built archive (see zip.ts) — deterministic, with
 * `mimetype` first and STORED. Any font-obfuscation entries in encryption.xml
 * are PRESERVED, since dropping the file wholesale would leave a reader
 * unable to de-mangle fonts that were never DRM in the first place.
 *
 * @param privateKeyDer the Adobe account's RSA private key, PKCS#8 DER.
 */
export function decryptAdept(bytes: Buffer, privateKeyDer: Buffer): Buffer {
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    throw new AdeptError("malformed", "not a readable zip");
  }

  const encXml = zip.getEntry("META-INF/encryption.xml")?.getData().toString("utf8");
  if (!encXml) throw new AdeptError("malformed", "no META-INF/encryption.xml");
  const rightsXml = zip.getEntry("META-INF/rights.xml")?.getData().toString("utf8");
  if (!rightsXml) throw new AdeptError("malformed", "no META-INF/rights.xml");

  const blocks = parseBlocks(encXml);
  if (blocks.some((b) => b.algorithm === ALGO_AES256)) {
    throw new AdeptError("unsupported", "AES-256 ADEPT is not supported");
  }
  const adeptBlocks = blocks.filter((b) => ADEPT_ALGOS.has(b.algorithm));
  if (adeptBlocks.length === 0) throw new AdeptError("malformed", "no ADEPT entries to decrypt");

  const key = unwrapContentKey(rightsXml, privateKeyDer);
  const byUri = new Map(adeptBlocks.map((b) => [b.uri, b]));

  const kept = blocks.filter((b) => FONT_ALGOS.has(b.algorithm));
  // 🔴 The decryption must be CONFIRMED before we ship it: at least one content
  // document has to both inflate and read as markup (see the canary note). If
  // nothing does — a wrong key, or the pathological all-STORED-markup epub that
  // real tools never produce — we refuse rather than hand a possibly-garbage
  // book to ingest. Safe failure: refuse, never ship unverified bytes.
  let confirmed = false;
  const out: ZipEntry[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/^\.?\//, "");
    if (name === "mimetype") continue; // writeEpub emits it
    if (name === "META-INF/rights.xml") continue; // the license is gone with the DRM
    if (name === "META-INF/encryption.xml") {
      if (kept.length === 0) continue;
      out.push({
        name,
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
            kept.map((b) => b.raw).join("\n") +
            `\n</encryption>\n`,
          "utf8",
        ),
      });
      continue;
    }
    const block = byUri.get(name);
    const data = entry.getData();
    if (!block) {
      out.push({ name, data });
      continue;
    }
    const clear = decryptEntry(data, key, block.algorithm !== ALGO_AES128_UNCOMPRESSED);
    if (clear.inflated && MARKUP_CANARY.test(name) && looksLikeMarkup(clear.data)) {
      confirmed = true;
    }
    out.push({ name, data: clear.data });
  }

  if (!confirmed) {
    throw new AdeptError(
      "bad-key",
      "could not confirm the decryption (no content document inflated to readable markup) — wrong key or corrupt file",
    );
  }
  return writeEpub(out);
}
