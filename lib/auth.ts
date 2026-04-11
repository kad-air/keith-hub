import type { NextRequest } from "next/server";

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
