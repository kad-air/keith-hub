// The Books app token: lets a native client (a private build of Sheafs) use
// the hub's book features — /api/books/* and nothing else — without the hub
// password. The client sends `Authorization: Bearer <BOOKS_APP_TOKEN>` and
// middleware.ts lets the request through exactly as a valid hub-auth cookie
// would; every route behind it is unchanged and cannot tell the two apart.
//
// 🔴 A DEDICATED env var, never FEED_PASSWORD and never BOOKS_API_KEY. The
// app's token sits in an app on a phone; rotating it must not log the browser
// out of the hub (FEED_PASSWORD) or break the X3 and Readest (BOOKS_API_KEY,
// stored in their OPDS/kosync URLs). Generate with: openssl rand -hex 32
//
// 🔴 FAIL CLOSED: an unset (or blank) BOOKS_APP_TOKEN refuses every bearer
// request — the HOOPS_IMPORT_TOKEN / BOOKS_API_KEY convention, and the
// opposite of middleware.ts's fail-open FEED_PASSWORD. (With FEED_PASSWORD
// unset the middleware waves everything through before this is consulted, as
// it always has — local dev only.)
//
// 🔴 SCOPED to /api/books/*: a right token on any other path is refused, so
// the token can never become a second hub password. appTokenAllows is the
// ONE function middleware calls, so the scope cannot be left off a call site.
//
// 🔴 Runs on the EDGE runtime (middleware), so this file imports NOTHING:
// Node's crypto.timingSafeEqual is not available there. tokensEqual below
// hashes both sides with Web Crypto and compares the digests without an
// early exit. check:books:app-token pins all four rules against the real
// middleware.

/**
 * Whether `pathname` is part of the Books API — the only surface the token
 * opens. An encoded dot, slash or backslash (or a raw backslash) is refused
 * outright: no Books route needs one (ids are UUIDs, keys hex, Discworld
 * nodes slugs), and a path the router might decode differently from how it
 * reads here must not be what decides the scope.
 */
export function isBooksApiPath(pathname: string): boolean {
  if (/%2e|%2f|%5c|\\/i.test(pathname)) return false;
  return pathname === "/api/books" || pathname.startsWith("/api/books/");
}

/** The token from an `Authorization: Bearer <token>` header, or null. The
 *  scheme is case-insensitive (RFC 9110 §11.1); the token itself is exact. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^bearer +(\S+) *$/i.exec(header);
  return m ? m[1] : null;
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/**
 * Constant-time string equality for the edge runtime. Both sides are hashed
 * to 32 bytes first — so a wrong-length token takes the same path as a
 * wrong-content one and the comparison never sees the token's length — then
 * every byte is XOR-accumulated with no early exit.
 */
export async function tokensEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Whether a request to `pathname` carrying this Authorization header is let
 * through on the app token. False off /api/books/*, false without a bearer,
 * false when BOOKS_APP_TOKEN is unset or blank, false on a wrong token.
 * `expected` is a parameter only so the gate can drive it; middleware never
 * passes it.
 */
export async function appTokenAllows(
  pathname: string,
  authorization: string | null,
  expected: string | undefined = process.env.BOOKS_APP_TOKEN,
): Promise<boolean> {
  if (!isBooksApiPath(pathname)) return false;
  const want = expected?.trim();
  if (!want) return false;
  const token = bearerToken(authorization);
  if (!token) return false;
  return tokensEqual(token, want);
}
