// ── Dismiss outbox ──────────────────────────────────────────────────────────
//
// Every dismissal (per-card, clear-above, dismiss-visible, and their undos)
// goes through here instead of a fire-and-forget fetch.
//
// 🔴 Why: on the phone the dismiss request is the LAST thing that happens
// before the app is put away — clear above, lock the phone — and iOS suspends
// a backgrounded PWA fast enough to kill an in-flight fetch. The card had
// already vanished optimistically, the server never heard about it, and the
// next resume's silent refresh brought the article straight back: "I clear
// stuff, the feed refreshes, and the articles come back". A flaky network or
// an expired cookie loses the request the same way.
//
// So a dismissal is first written to localStorage as a batch, then posted
// with `keepalive` (which lets the browser finish the request after the page
// is gone), and the batch is removed only when the server answers 2xx.
// Anything left over is replayed on the next mount, on `online`, and before
// every refresh — BEFORE the refetch, so a replayed dismissal can't be
// undone by the list it would otherwise race.
//
// Batches are FIFO, so a dismiss followed by its undo replays in that order.
// The server side (markReadBulk) ignores ids that no longer exist, so a
// batch can never wedge the queue.

const KEY = "hub-dismiss-outbox";
// fetch keepalive caps the body at 64 KB; ids are UUIDs (~40 bytes each with
// JSON overhead), so 500 per batch leaves plenty of headroom.
const MAX_BATCH = 500;

interface Batch {
  id: string;
  ids: string[];
  unread: boolean;
  ts: number;
}

function load(): Batch[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Batch[]) : [];
  } catch {
    return [];
  }
}

function store(batches: Batch[]): void {
  try {
    if (batches.length === 0) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(batches));
  } catch {
    // Storage unavailable (private mode, quota) — the keepalive send below
    // still happens, we just lose the replay safety net.
  }
}

/** Queue a dismiss (or, with unread=true, an undo) for the given ids. */
export function enqueueDismiss(ids: string[], unread = false): void {
  if (ids.length === 0) return;
  const batches = load();
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    batches.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ids: ids.slice(i, i + MAX_BATCH),
      unread,
      ts: Date.now(),
    });
  }
  store(batches);
}

let inFlight: Promise<boolean> | null = null;

/**
 * Replay every queued batch in order, stopping at the first failure (it
 * stays queued). Resolves true if at least one batch reached the server —
 * callers use that to decide whether their current list is now stale.
 * Concurrent callers share one flush.
 */
export function flushDismissOutbox(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = flush().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function flush(): Promise<boolean> {
  let sent = false;
  for (;;) {
    const batch = load()[0];
    if (!batch) return sent;
    try {
      const res = await fetch("/api/items/read-bulk", {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: batch.ids, unread: batch.unread }),
      });
      if (!res.ok) return sent;
    } catch {
      return sent;
    }
    sent = true;
    store(load().filter((b) => b.id !== batch.id));
  }
}

/** Queue and immediately try to send. */
export function dismissViaOutbox(ids: string[], unread = false): Promise<boolean> {
  enqueueDismiss(ids, unread);
  return flushDismissOutbox();
}

/** For diagnostics: how many batches are still waiting. */
export function pendingDismissBatches(): number {
  return load().length;
}
