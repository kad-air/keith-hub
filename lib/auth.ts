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
