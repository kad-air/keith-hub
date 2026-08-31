import { getDb } from "../db.ts";
import { listBooks } from "./store.ts";
import { listProgress } from "./kosync.ts";
import { getReadingStats } from "./statsData.ts";
import { FINISH_THRESHOLD } from "./stats.ts";
import {
  computeDiscworldProgress,
  type DiscworldProgress,
  type ManualStatus,
  type NodeSync,
} from "./discworld.ts";

// The only impure edge of the Discworld map: pull the catalog, the sync
// positions and the reader's own marks out of SQLite, hand them to the pure
// model in discworld.ts. Same arrangement as statsData.ts → stats.ts.

const MANUAL_STATUSES: ManualStatus[] = ["read", "reading", "skipped"];

export function isManualStatus(value: unknown): value is ManualStatus {
  return typeof value === "string" && (MANUAL_STATUSES as string[]).includes(value);
}

export function listManualMarks(): Map<string, ManualStatus> {
  const rows = getDb()
    .prepare(`SELECT node_id, status FROM discworld_state`)
    .all() as Array<{ node_id: string; status: string }>;
  const out = new Map<string, ManualStatus>();
  for (const r of rows) if (isManualStatus(r.status)) out.set(r.node_id, r.status);
  return out;
}

export function setManualMark(nodeId: string, status: ManualStatus): void {
  getDb()
    .prepare(
      `INSERT INTO discworld_state (node_id, status, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(node_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    )
    .run(nodeId, status);
}

/** Clearing is a DELETE, so the node goes back to being answered by the sync
 *  rather than pinned to whatever it last said. */
export function clearManualMark(nodeId: string): void {
  getDb().prepare(`DELETE FROM discworld_state WHERE node_id = ?`).run(nodeId);
}

/**
 * The map, computed fresh.
 *
 * 🔴 "Ever finished" comes from the reading-events model, not from the current
 * kosync percentage, and both are consulted. The percentage is a single
 * upserted position: finish a book, then open it again to look something up,
 * and it reports 3%. The events log remembers the crossing. Using only the
 * percentage would un-read books on the map at random; using only the log
 * would miss every book finished before the log existed (see lib/db.ts on
 * reading_events) — which is exactly the gap the manual mark fills.
 */
export function getDiscworldProgress(): DiscworldProgress {
  const books = listBooks().map((b) => ({
    id: b.id,
    title: b.title,
    series: b.series,
    seriesIndex: b.seriesIndex,
    partialMd5: b.partialMd5,
  }));

  // Newest position per document. listProgress orders by timestamp DESC, so
  // the first row for a document wins — a second device that is behind can't
  // drag the map backwards.
  const syncByDocument = new Map<string, NodeSync>();
  for (const p of listProgress()) {
    if (!syncByDocument.has(p.document)) {
      syncByDocument.set(p.document, { percentage: p.percentage, timestamp: p.timestamp });
    }
  }

  const stats = getReadingStats();
  const finishedDocuments = new Set(stats.finished.map((f) => f.document));

  return computeDiscworldProgress({
    books,
    syncByDocument,
    finishedDocuments,
    manual: listManualMarks(),
    finishThreshold: FINISH_THRESHOLD,
  });
}
