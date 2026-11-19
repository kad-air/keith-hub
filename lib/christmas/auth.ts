// The Christmas list's own gate (/christmas and /api/christmas/*), separate
// from the hub password on purpose: Kim gets a shared passcode that opens this
// one page and nothing else on the hub. Same spirit as lib/auth.ts — the
// cookie holds an HMAC derived from the passcode, never the passcode itself,
// so changing CHRISTMAS_PASSCODE signs every device out.
//
// 🔴 Fails CLOSED: with CHRISTMAS_PASSCODE unset, no passcode cookie is ever
// valid (unlike FEED_PASSWORD, whose absence opens the hub for local dev).
// The page holds the children's names and ages and an endpoint that spends the
// API key, so "unset" must never mean "public".
//
// Imports nothing: middleware runs on the Edge runtime (Web Crypto only).

export const XMAS_COOKIE = "xmas-auth";
/** ~400 days, the most a browser will keep a cookie — enter it once per device. */
export const XMAS_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

export async function deriveChristmasToken(passcode: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(passcode), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode("xmas-auth-token"));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare over SHA-256 digests (fixed length, no early exit). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function christmasCookieValid(cookie: string | undefined): Promise<boolean> {
  const passcode = process.env.CHRISTMAS_PASSCODE;
  if (!passcode || !cookie) return false;
  return safeEqual(cookie, await deriveChristmasToken(passcode));
}

/** Paths the passcode cookie opens. Anything with an encoded dot or slash is refused. */
export function isChristmasPath(pathname: string): boolean {
  if (/%(2e|2f|5c)/i.test(pathname)) return false;
  return (
    pathname === "/christmas" ||
    pathname.startsWith("/christmas/") ||
    pathname === "/api/christmas" ||
    pathname.startsWith("/api/christmas/")
  );
}

/** The two christmas paths anyone may reach: the passcode form and its POST. */
export function isChristmasPublicPath(pathname: string): boolean {
  return pathname === "/christmas/login" || pathname === "/api/christmas/auth";
}
