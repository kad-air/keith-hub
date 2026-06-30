import type { NextRequest } from "next/server";
import { cookies } from "next/headers";

export const AUTH_COOKIE = "hub-auth";

/**
 * Build a redirect URL that respects the reverse proxy's forwarded headers.
 * Behind Railway/Traefik, request.url resolves to localhost — this reads
 * x-forwarded-host/proto to reconstruct the public origin.
 */
export function publicUrl(path: string, request: NextRequest): URL {
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "localhost";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  return new URL(path, `${proto}://${host}`);
}

/**
 * Derives a deterministic auth token from the password using HMAC-SHA256.
 * Uses Web Crypto API so it works in both Edge (middleware) and Node.js
 * (API routes) runtimes. The token is what gets stored in the cookie —
 * the raw password never leaves the server's env vars.
 */
export async function deriveAuthToken(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode("hub-auth-token"),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Server-component equivalent of the middleware's cookie check. Used by pages
 * that render different UI (e.g. hiding write affordances) depending on
 * whether the visitor is the logged-in owner or an anonymous public reader.
 */
export async function isAuthenticated(): Promise<boolean> {
  const password = process.env.FEED_PASSWORD;
  if (!password) return true; // no password configured — local dev, fully trusted
  const cookie = cookies().get(AUTH_COOKIE);
  if (!cookie) return false;
  const expected = await deriveAuthToken(password);
  return cookie.value === expected;
}
