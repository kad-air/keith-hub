import fs from "fs";
// Relative + explicit .ts — the lib/books convention (see store.ts).
import { getDb } from "../db.ts";
import { bookFilePath } from "./store.ts";
import { checkEpubHealth, HEALTH_VERSION, type EpubHealth } from "./health.ts";

// The impure edge of the health checker (the statsData.ts role): read the
// cached report off the books row, or compute it from the stored bytes and
// cache it. The check itself lives in health.ts and is pure.

export type BookHealth = EpubHealth & { checkedAt: string };

/**
 * The health report for one book — cached, or computed now and cached.
 *
 * Lazy on purpose (the word_count backfill pattern): books ingested before
 * health_json existed, and every book after a HEALTH_VERSION bump, get
 * re-checked on their next detail-page open — one unzip, then a row read
 * forever. Keeps the boot path clean and makes the page self-healing after
 * a restore.
 *
 * 🔴 This is a THIRD write path into the books table (after updateBook and
 * setToRead), and it carries the same guarantee as the other two: it writes
 * ONE DB column and never opens the stored file for writing — bytes, sha256
 * and partial_md5 (the sync key) are untouched, so checking a book someone
 * is reading right now cannot disturb it. check:books:health asserts this,
 * because check:books:metadata only reasons about updateBook.
 *
 * `updated_at` is deliberately not bumped — that column means "the metadata
 * was edited", and a cache fill is invisible housekeeping.
 *
 * A missing file reports red but is NEVER cached: a volume restore could
 * bring the bytes back, and a cached "file missing" would outlive the repair.
 */
export function getBookHealth(bookId: string): BookHealth | null {
  const db = getDb();
  const row = db.prepare(`SELECT health_json FROM books WHERE id = ?`).get(bookId) as
    | { health_json: string | null }
    | undefined;
  if (!row) return null;

  if (row.health_json) {
    try {
      const cached = JSON.parse(row.health_json) as BookHealth;
      if (cached.version === HEALTH_VERSION) return cached;
    } catch {
      // Unparseable cache — fall through and recompute.
    }
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(bookFilePath({ id: bookId }));
  } catch {
    return {
      version: HEALTH_VERSION,
      checkedAt: new Date().toISOString(),
      findings: [
        {
          code: "file-missing",
          severity: "red",
          summary: "The stored epub is missing from the volume — downloads and device sync will fail.",
        },
      ],
      stats: { spineDocs: 0, words: 0, tocEntries: null },
    };
  }

  const report: BookHealth = { ...checkEpubHealth(bytes), checkedAt: new Date().toISOString() };
  db.prepare(`UPDATE books SET health_json = ? WHERE id = ?`).run(JSON.stringify(report), bookId);
  return report;
}
