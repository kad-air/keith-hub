import { getDb } from "../db.ts";

// The Adobe activation this hub fulfils with.
//
// 🔴 Activation is PROVISIONING, not part of the loop. Registering an
// (anonymous) Adobe account is a one-time act that also needs PKCS#12 parsing,
// which Node has no native support for — so it is done once, out of band, and
// its result is pasted in as ADOBE_ADEPT_ACTIVATION. That keeps ~900 lines of
// account/activation protocol and a PKCS#12 implementation out of this
// codebase entirely, while the ONGOING path (upload .acsm → fulfil → decrypt →
// ingest) stays fully inside the hub.
//
// 🔴 TWO different RSA keys live in here and must not be confused:
//   · signingKey — signs fulfilment requests to Adobe/the operator
//   · licenseKey — decrypts a book's AES content key (what adept.ts needs)
// They are unrelated; swapping them fails in confusing ways.
//
// Fail CLOSED when unset, same convention as BOOKS_API_KEY / ADOBE_ADEPT_KEY.

export type AdeptActivation = {
  user: string;
  device: string;
  deviceType: string;
  fingerprint: string;
  activationUrl: string;
  licenseCertificate: string;
  authenticationCertificate: string;
  /** PKCS#8 DER — signs requests. */
  signingKey: Buffer;
  /** DER — sent to the operator during Auth. */
  certificate: Buffer;
  /** PKCS#8 DER — decrypts book content keys. */
  licenseKey: Buffer;
  hobbesVersion: string;
  clientOS: string;
  clientLocale: string;
};

/** Accumulated as books are fulfilled; lives in the kv table, not the env. */
export type AdeptOperatorState = {
  operatorUrls: string[];
  licenseServices: Array<{ licenseURL: string; certificate: string }>;
};

const KV_KEY = "adept_operator_state";

let cached: AdeptActivation | null | undefined;

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") {
    throw new Error(`ADOBE_ADEPT_ACTIVATION: missing "${key}"`);
  }
  return v;
}

/**
 * The configured activation, or null when none is set (DRM'd uploads then
 * refuse with a reason rather than half-working).
 */
export function getAdeptActivation(): AdeptActivation | null {
  if (cached !== undefined) return cached;
  const raw = process.env.ADOBE_ADEPT_ACTIVATION?.trim();
  if (!raw) {
    cached = null;
    return cached;
  }
  try {
    // Accept either raw JSON or base64-wrapped JSON — the blob is large and
    // multi-line, and Railway's env editor is happier with one long token.
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const o = JSON.parse(text) as Record<string, unknown>;
    cached = {
      user: requireString(o, "user"),
      device: requireString(o, "device"),
      deviceType: requireString(o, "device_type"),
      fingerprint: requireString(o, "fingerprint"),
      activationUrl: requireString(o, "activation_url"),
      licenseCertificate: requireString(o, "license_certificate"),
      authenticationCertificate: requireString(o, "authentication_certificate"),
      signingKey: Buffer.from(requireString(o, "signing_key_pkcs8_der_b64"), "base64"),
      certificate: Buffer.from(requireString(o, "certificate_der_b64"), "base64"),
      licenseKey: Buffer.from(requireString(o, "license_key_pkcs8_der_b64"), "base64"),
      hobbesVersion: requireString(o, "hobbes_version"),
      clientOS: requireString(o, "client_os"),
      clientLocale: requireString(o, "client_locale"),
    };
    return cached;
  } catch (err) {
    console.error("[books] ADOBE_ADEPT_ACTIVATION is set but unusable:", err);
    cached = null;
    return cached;
  }
}

/** Test seam — the gate swaps activations between cases. */
export function resetAdeptActivationCache(): void {
  cached = undefined;
}

/**
 * Operator/license state, seeded from the activation blob's own lists on first
 * read so a freshly-provisioned hub starts with whatever the one-time
 * activation already learned (and doesn't re-authenticate needlessly).
 */
export function getOperatorState(): AdeptOperatorState {
  const row = getDb().prepare(`SELECT value FROM kv WHERE key = ?`).get(KV_KEY) as
    | { value: string }
    | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as AdeptOperatorState;
      return {
        operatorUrls: parsed.operatorUrls ?? [],
        licenseServices: parsed.licenseServices ?? [],
      };
    } catch {
      // Corrupt state must not brick fulfilment — fall through to the seed.
    }
  }
  const raw = process.env.ADOBE_ADEPT_ACTIVATION?.trim();
  if (raw) {
    try {
      const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
      const o = JSON.parse(text) as Record<string, unknown>;
      return {
        operatorUrls: Array.isArray(o.operator_urls) ? (o.operator_urls as string[]) : [],
        licenseServices: Array.isArray(o.license_services)
          ? (o.license_services as AdeptOperatorState["licenseServices"])
          : [],
      };
    } catch {
      // fall through
    }
  }
  return { operatorUrls: [], licenseServices: [] };
}

export function saveOperatorState(state: AdeptOperatorState): void {
  getDb()
    .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`)
    .run(KV_KEY, JSON.stringify(state), JSON.stringify(state));
}
