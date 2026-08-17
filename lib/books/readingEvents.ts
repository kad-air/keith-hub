import { getDb } from "../db.ts";

// The append-only reading history that statistics are computed from. See the
// reading_events table comment in lib/db.ts for why it has to exist at all
// (kosync_progress upserts, so it destroys the past on every sync).

export type ReadingEventKind = "baseline" | "read";

export type ReadingEvent = {
  id: number;
  username: string;
  document: string;
  kind: ReadingEventKind;
  percentage: number;
  delta: number;
  device: string | null;
  device_id: string | null;
  timestamp: number;
};

/**
 * Record one sync as history. Called from putProgress with the PREVIOUS row,
 * read before the upsert overwrote it.
 *
 * Returns the event written, or null when the sync was not movement.
 *
 * 🔴 Three rules here, each of which is a wrong number on the stats page if
 * broken, and each pinned by check:books:stats:
 *
 *  1. An UNCHANGED position writes nothing. KOReader and CrossPoint re-PUT the
 *     same position on a timer while a book merely sits open — that is the
 *     device being polite, not the reader reading. Recording it would light up
 *     the streak calendar for days nobody opened a book, which is exactly the
 *     lie a streak must never tell.
 *  2. The FIRST sync of a document is a 'baseline' with delta forced to 0. The
 *     device is announcing where it already is; the reading that got it there
 *     happened before this server could see it (possibly years of it, via the
 *     Stump migration). Crediting it as today's reading would book that whole
 *     history to one afternoon.
 *  3. delta is stored SIGNED. Going backwards is real and worth keeping — a
 *     re-read, or a second device that was behind — but it must never
 *     subtract from a day's pages, which is the reader's side of the contract
 *     handled in stats.ts.
 */
export function recordReadingEvent(
  username: string,
  next: {
    document: string;
    progress: string;
    percentage: number;
    device?: string | null;
    device_id?: string | null;
  },
  previous: { progress: string; percentage: number } | null,
  timestamp: number,
): ReadingEvent | null {
  // Rule 1 — the idle re-sync. Both fields have to be unchanged: a percentage
  // that rounds to the same value while the x-pointer moved IS a page turn on
  // a long chapter, and counts as activity worth a zero-delta event.
  if (
    previous &&
    previous.progress === next.progress &&
    previous.percentage === next.percentage
  ) {
    return null;
  }

  const kind: ReadingEventKind = previous ? "read" : "baseline";
  const delta = previous ? next.percentage - previous.percentage : 0;

  const info = getDb()
    .prepare(
      `INSERT INTO reading_events
         (username, document, kind, percentage, delta, device, device_id, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      username,
      next.document,
      kind,
      next.percentage,
      delta,
      next.device ?? null,
      next.device_id ?? null,
      timestamp,
    );

  return {
    id: Number(info.lastInsertRowid),
    username,
    document: next.document,
    kind,
    percentage: next.percentage,
    delta,
    device: next.device ?? null,
    device_id: next.device_id ?? null,
    timestamp,
  };
}

/** Every event, oldest first — the order every statistic is computed in. */
export function listReadingEvents(username?: string): ReadingEvent[] {
  const db = getDb();
  return (
    username
      ? db
          .prepare(`SELECT * FROM reading_events WHERE username = ? ORDER BY timestamp ASC, id ASC`)
          .all(username)
      : db.prepare(`SELECT * FROM reading_events ORDER BY timestamp ASC, id ASC`).all()
  ) as ReadingEvent[];
}

export function readingEventCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM reading_events`).get() as { n: number };
  return row.n;
}

/**
 * Seed a baseline for every position that already exists in kosync_progress
 * with no history behind it — the one-time bridge for positions that arrived
 * before this table did (the Stump migration's, and everything synced between
 * the Books section shipping and reading stats shipping).
 *
 * Idempotent: a document that already has ANY event is left alone, so this is
 * safe to call on every boot. Baselines carry delta 0, so seeding credits
 * nobody with reading they didn't do here — it only teaches the stats page
 * where each book currently stands.
 */
export function seedBaselinesFromProgress(): number {
  const db = getDb();
  const orphans = db
    .prepare(
      `SELECT p.username, p.document, p.percentage, p.device, p.device_id, p.timestamp
         FROM kosync_progress p
        WHERE NOT EXISTS (
          SELECT 1 FROM reading_events e
           WHERE e.username = p.username AND e.document = p.document
        )`,
    )
    .all() as Array<{
    username: string;
    document: string;
    percentage: number;
    device: string | null;
    device_id: string | null;
    timestamp: number;
  }>;

  const insert = db.prepare(
    `INSERT INTO reading_events
       (username, document, kind, percentage, delta, device, device_id, timestamp)
     VALUES (?, ?, 'baseline', ?, 0, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const o of orphans) {
      insert.run(o.username, o.document, o.percentage, o.device, o.device_id, o.timestamp);
    }
  })();
  return orphans.length;
}
