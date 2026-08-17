import { timingSafeEqual } from "crypto";

// Machine credential for the books admin API (`/api/books-admin/*`), used by
// the Mac Mini MCP server so an agent can clean up metadata from the phone.
//
// 🔴 Separate from BOTH FEED_PASSWORD (the human cookie gate) and
// BOOKS_API_KEY (the reading devices' key-in-URL). Three different blast
// radii: revoking the agent's write access must not log the browser out or
// break the X3 mid-book. Same convention as HOOPS_IMPORT_TOKEN — bearer,
// timing-safe, length-checked first, and FAILS CLOSED when unset.
// Generate with: openssl rand -hex 32
export function checkBooksAdminToken(authorization: string | null): boolean {
  const expected = process.env.BOOKS_ADMIN_TOKEN;
  if (!expected) return false;
  const prefix = "Bearer ";
  if (!authorization || !authorization.startsWith(prefix)) return false;
  const candidate = authorization.slice(prefix.length);
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
