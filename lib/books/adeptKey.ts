import { getAdeptActivation } from "./adeptActivation.ts";

// Where the key that decrypts a book's content key comes from.
//
// 🔴 The ACTIVATION wins over the env var, and that ordering is load-bearing:
// a book this hub fulfilled was encrypted to the licence key of the activation
// that fulfilled it, so any other key is simply the wrong one. ADOBE_ADEPT_KEY
// remains as an override for epubs fulfilled ELSEWHERE (an older activation, a
// desktop ADE) that you still want to ingest.
//
// Fail CLOSED when neither is set, same convention as BOOKS_API_KEY and
// HOOPS_IMPORT_TOKEN: no key means DRM'd uploads are refused with a reason
// rather than ingested broken. DRM-free uploads are unaffected either way.

let cached: Buffer | null | undefined;

export function getAdeptKey(): Buffer | null {
  if (cached !== undefined) return cached;
  const activation = getAdeptActivation();
  if (activation) {
    cached = activation.licenseKey;
    return cached;
  }
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

/** Test seam — the check scripts swap keys between cases. */
export function resetAdeptKeyCache(): void {
  cached = undefined;
}
