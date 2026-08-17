import { timingSafeEqual } from "crypto";

// The device credential for /opds and /kosync — key-in-URL, the shape proven
// against CrossPoint by the Stump deployment (the X3 stores the whole URL and
// cannot complete an auth challenge; see BOOKS_PLAN §3).
//
// 🔴 Deliberately a DEDICATED env var, not FEED_PASSWORD, and deliberately
// FAIL-CLOSED when unset — same reasoning (and same divergence from
// middleware.ts's fail-open convention) as HOOPS_IMPORT_TOKEN: an unset var
// must yield a dead endpoint, not a public file server. Do not "fix" either
// side to match the other. Generate with: openssl rand -hex 32
export function checkBooksApiKey(candidate: string | undefined): boolean {
  const expected = process.env.BOOKS_API_KEY;
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
