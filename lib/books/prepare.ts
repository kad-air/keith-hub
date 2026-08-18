import { AdeptError, decryptAdept, inspectEncryption } from "./adept.ts";
import { getAdeptKey } from "./adeptKey.ts";

// The upload boundary: whatever bytes arrive become a clean epub here, or the
// upload is refused with a reason. Nothing downstream of this — ingestBook,
// the OPDS feed, kosync, the stats — ever sees an encrypted file.
//
// 🔴 This exists so that "upload an .acsm" and "upload an .epub" are the same
// gesture with the same result. Everything that differs between them is
// resolved inside this one function, BEFORE ingest, which is why the route
// and the UI don't branch on file type beyond the accept filter.
//
// 🔴 It is also the ghost-book guard. Measured, on a real ADEPT epub: the
// ingest path happily accepts it, stores ciphertext as the cover, and counts
// 13,069 words against a true 155,347 — a confident, plausible, silently
// wrong 34-page book, with no error anywhere and no way for a reader to open
// it. Refusing is strictly better than ingesting, so a file we cannot bring
// into the clear must never reach ingestBook.

export type PrepareOrigin =
  | "epub" // already clear — passed through untouched
  | "epub-drm" // ADEPT stripped here
  | "acsm"; // fulfilled here, then stripped (step 2)

export type Prepared = { bytes: Buffer; fileName: string; origin: PrepareOrigin };

export type PrepareErrorCode =
  | "not-a-book"
  | "drm-no-key"
  | "drm-failed"
  | "drm-unsupported"
  | "acsm-unsupported";

export class PrepareError extends Error {
  // See AdeptError — no TS parameter properties, the gates run under node's
  // erasable-syntax-only type stripping.
  code: PrepareErrorCode;
  constructor(code: PrepareErrorCode, message: string) {
    super(message);
    this.name = "PrepareError";
    this.code = code;
  }
}

export function isAcsm(fileName: string, bytes: Buffer): boolean {
  if (/\.acsm$/i.test(fileName)) return true;
  // Content sniff, so a renamed file is still recognised for what it is
  // rather than failing later as "not a zip".
  const head = bytes.subarray(0, 512).toString("utf8");
  return /<fulfillmentToken\b/i.test(head);
}

/**
 * Turn uploaded bytes into a clean epub ready for `ingestBook`.
 * Throws `PrepareError` when that isn't possible — the caller turns the code
 * into a per-file message; it never falls through to a partial ingest.
 */
export async function prepareForIngest(bytes: Buffer, fileName: string): Promise<Prepared> {
  if (isAcsm(fileName, bytes)) {
    // ── STEP 2 SEAM ──────────────────────────────────────────────────────
    // Replace this throw with:
    //   const fulfilled = await fulfillAcsm(bytes);   // lib/books/acsm.ts
    //   return { ...(await prepareForIngest(fulfilled, fileName.replace(/\.acsm$/i, ".epub"))),
    //            origin: "acsm" };
    // The recursion is deliberate — a fulfilled file is an ADEPT epub, so it
    // takes the decrypt path below rather than duplicating it. Nothing else
    // in the codebase changes: the route already accepts these bytes and the
    // UI already offers the file type.
    throw new PrepareError(
      "acsm-unsupported",
      "Adobe .acsm fulfilment isn't wired up yet — this file is a download token, not the book",
    );
  }

  // "PK" zip magic. Anything else can't be an epub, whatever it's called.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new PrepareError("not-a-book", "not an epub (no zip header)");
  }

  const info = inspectEncryption(bytes);

  // 🔴 font-obfuscation is not DRM: mangled font files, content in the clear,
  // legal in an ordinary epub. It must pass through untouched.
  if (info.kind === "none" || info.kind === "font-obfuscation") {
    return { bytes, fileName, origin: "epub" };
  }

  if (info.kind === "unknown") {
    throw new PrepareError(
      "drm-unsupported",
      "this epub is encrypted by something other than Adobe DRM and can't be opened here",
    );
  }

  const key = getAdeptKey();
  if (!key) {
    throw new PrepareError(
      "drm-no-key",
      "this epub is Adobe DRM-protected and no Adobe key is configured (set ADOBE_ADEPT_KEY)",
    );
  }

  try {
    const clear = decryptAdept(bytes, key);
    return { bytes: clear, fileName, origin: "epub-drm" };
  } catch (err) {
    if (err instanceof AdeptError) {
      throw new PrepareError(
        err.code === "unsupported" ? "drm-unsupported" : "drm-failed",
        `could not remove the DRM: ${err.message}`,
      );
    }
    throw new PrepareError("drm-failed", "could not remove the DRM from this epub");
  }
}
