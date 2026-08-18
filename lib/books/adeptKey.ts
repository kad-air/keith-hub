// Where the Adobe account key comes from.
//
// Today: the ADOBE_ADEPT_KEY env var — the RSA private key of an activated
// Adobe account, PKCS#8 DER, base64-encoded. Same fail-CLOSED convention as
// BOOKS_API_KEY and HOOPS_IMPORT_TOKEN: unset means we decrypt nothing, and
// the upload path refuses DRM'ed files with a reason rather than ingesting
// them broken.
//
// 🔴 Step 2 (the .acsm fulfilment port) makes this mostly vestigial: the hub
// will create its own ANONYMOUS Adobe activation on first use and store it in
// the kv table, so there is no account to own and no secret to rotate. When
// that lands, this function reads the kv activation FIRST and keeps the env
// var only as an override for a key fulfilled elsewhere. Structured that way
// now so the call sites never change.

let cached: Buffer | null | undefined;

export function getAdeptKey(): Buffer | null {
  if (cached !== undefined) return cached;
  const raw = process.env.ADOBE_ADEPT_KEY?.trim();
  if (!raw) {
    cached = null;
    return cached;
  }
  try {
    const der = Buffer.from(raw.replace(/\s+/g, ""), "base64");
    cached = der.length > 0 ? der : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Test seam — the check script swaps keys between cases. */
export function resetAdeptKeyCache(): void {
  cached = undefined;
}
