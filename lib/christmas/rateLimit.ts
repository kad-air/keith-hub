// In-memory sliding-window limiter for the Christmas routes (one Railway
// process, so a module-level map is the whole picture). Used for the helper
// (so a leaked passcode can't run up the API bill — store.ts adds a durable
// daily cap on top) and for passcode attempts (so a short shared passcode
// can't be guessed by brute force).

const hits = new Map<string, number[]>();

/**
 * Records a hit for `key` and says whether it is allowed under every
 * [limit, windowMs] pair. A refused hit is not recorded.
 */
export function allow(key: string, windows: [number, number][], now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const longest = Math.max(...windows.map(([, w]) => w));
  const list = (hits.get(key) ?? []).filter((t) => now - t < longest);
  for (const [limit, w] of windows) {
    const inWindow = list.filter((t) => now - t < w);
    if (inWindow.length >= limit) {
      hits.set(key, list);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((inWindow[0] + w - now) / 1000)) };
    }
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > longest) hits.delete(k);
  }
  return { ok: true, retryAfterSec: 0 };
}

export function resetRateLimits() {
  hits.clear();
}

/** The caller's address as Railway's proxy reports it. */
export function clientAddress(headers: Headers): string {
  return (headers.get("x-forwarded-for") || "").split(",")[0].trim() || headers.get("x-real-ip") || "local";
}
