import type Database from "better-sqlite3";
import type { CategoryCounts, Item } from "./types";

// ── Tunable knobs ───────────────────────────────────────────────────────────
// Both of these control the "finite, not infinite" mission. Tweak freely.

// Per-category unread state cap. After every poll cycle, anything beyond
// rank UNREAD_CAP_PER_CATEGORY in a category's unread queue (sorted by
// published_at DESC) is auto-marked read. This is what bounds tab counts —
// without it, sources with years of backlog would push the unread count
// into the thousands and the queue would feel infinite.
//
// pruneUnreadCategoryCaps NEVER sets consumed_at, so /read history is
// unaffected. Pruned items become "pending": still in items, with
// item_state.read_at set, invisible to every view.
export const UNREAD_CAP_PER_CATEGORY = 300;

// All view per-category quotas. Each category contributes up to its quota
// of the most recent unread items to the All view. Sum is the All view's
// max size. Independent of UNREAD_CAP_PER_CATEGORY: a category tab shows
// up to that cap (300); the All view shows up to its quota for the cat.
//
// Reasoning for the defaults: 100 podcasts ≈ 20 days of "never miss" buffer
// at ~5 new/day, music/film/reading quotas comfortably fit typical volume,
// bluesky capped at 50 because it's the highest-volume lowest-priority and
// would otherwise drown the others. Tunable.
export const ALL_VIEW_QUOTAS: Record<keyof CategoryCounts, number> = {
  all:      0,   // unused — sentinel for the type
  podcasts: 100,
  music:    50,
  film:     50,
  reading:  50,
  bluesky:  50,
};

const ITEM_SELECT = `
  SELECT
    i.*,
    s.name as source_name,
    s.category as source_category,
    ist.read_at,
    ist.saved_at,
    ist.consumed_at,
    ist.notes
  FROM items i
  LEFT JOIN item_state ist ON ist.item_id = i.id
  JOIN sources s ON s.id = i.source_id
`;

/**
 * Returns up to `limit` items for the main feed, sampled by per-category
 * quotas. Each category contributes up to ALL_VIEW_QUOTAS[cat] of its
 * most-recent unread items. Result is sorted by published_at DESC for
 * display, then capped at `limit` as a defensive ceiling.
 *
 * The high-signal categories aren't pinned to the top — they're guaranteed
 * representation via the quotas, then mixed in chronologically.
 */
export function getMainFeedItems(
  db: Database.Database,
  limit: number
): Item[] {
  const stmt = db.prepare(
    `${ITEM_SELECT}
     WHERE ist.read_at IS NULL AND s.category = ?
     ORDER BY i.published_at DESC
     LIMIT ?`
  );

  const all: Item[] = [];
  for (const [cat, quota] of Object.entries(ALL_VIEW_QUOTAS)) {
    if (cat === "all" || quota <= 0) continue;
    all.push(...(stmt.all(cat, quota) as Item[]));
  }

  return all
    .sort((a, b) =>
      a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0
    )
    .slice(0, limit);
}

/**
 * Enforces UNREAD_CAP_PER_CATEGORY across all categories. Anything ranked
 * above the cap (by published_at DESC, within its category) gets read_at
 * set; consumed_at is left null so /read history is unaffected. Idempotent —
 * running twice is the same as once. Returns the number of items pruned.
 *
 * Run this at the END of every poll cycle, after fetches complete, so
 * fresh items get a chance to be ranked before older ones get pruned.
 */
export function pruneUnreadCategoryCaps(db: Database.Database): number {
  const now = new Date().toISOString();
  // Window-function rank within each category. Items at rank > cap are
  // pruned. Uses INSERT … ON CONFLICT DO UPDATE so the upsert handles both
  // "no item_state row yet" and "row exists with read_at NULL" cases.
  const result = db
    .prepare(
      `INSERT INTO item_state (item_id, read_at)
       SELECT id, ? FROM (
         SELECT i.id,
           ROW_NUMBER() OVER (
             PARTITION BY s.category
             ORDER BY i.published_at DESC
           ) AS rn
         FROM items i
         LEFT JOIN item_state ist ON ist.item_id = i.id
         JOIN sources s ON s.id = i.source_id
         WHERE ist.read_at IS NULL
       )
       WHERE rn > ?
       ON CONFLICT(item_id) DO UPDATE SET read_at = excluded.read_at`
    )
    .run(now, UNREAD_CAP_PER_CATEGORY);
  return Number(result.changes);
}

/**
 * Marks every unread item in scope as read in a single transaction.
 * Returns the list of item IDs that were marked, so the caller can build
 * an undo. Scope is either all unread items (no category) or all unread
 * items in a single category.
 */
export function markAllUnreadAsRead(
  db: Database.Database,
  category: string | null
): string[] {
  const now = new Date().toISOString();
  // Find every unread item in scope. We need the IDs explicitly so we can
  // (a) return them for undo and (b) issue a single upsert per id (item_state
  // rows are created lazily, so a bulk UPDATE wouldn't catch items that
  // have never been touched).
  const findSql = category
    ? `SELECT i.id FROM items i
       LEFT JOIN item_state ist ON ist.item_id = i.id
       JOIN sources s ON s.id = i.source_id
       WHERE ist.read_at IS NULL AND s.category = ?`
    : `SELECT i.id FROM items i
       LEFT JOIN item_state ist ON ist.item_id = i.id
       WHERE ist.read_at IS NULL`;
  const ids = (
    category
      ? db.prepare(findSql).all(category)
      : db.prepare(findSql).all()
  ) as Array<{ id: string }>;

  const upsert = db.prepare(`
    INSERT INTO item_state (item_id, read_at)
    VALUES (?, ?)
    ON CONFLICT(item_id) DO UPDATE SET read_at = excluded.read_at
  `);
  const tx = db.transaction((rows: Array<{ id: string }>) => {
    for (const row of rows) upsert.run(row.id, now);
  });
  tx(ids);

  return ids.map((r) => r.id);
}

/**
 * Returns the per-category count of unread items, plus an All count.
 *
 * Per-category counts are the literal unread totals in each category
 * (already bounded by UNREAD_CAP_PER_CATEGORY via the prune step).
 *
 * The All count is NOT the sum — it's the actual cardinality of the All
 * view, computed as `sum(min(quota, unread))` across the categories. This
 * keeps the All tab honest: the number you see matches the number of items
 * that'll appear when you tap it, instead of advertising 600 items but
 * only showing 267.
 */
export function getCategoryCounts(
  db: Database.Database
): CategoryCounts {
  const rows = db
    .prepare(
      `SELECT s.category as cat, COUNT(*) as n
       FROM items i
       LEFT JOIN item_state ist ON ist.item_id = i.id
       JOIN sources s ON s.id = i.source_id
       WHERE ist.read_at IS NULL
       GROUP BY s.category`
    )
    .all() as Array<{ cat: string; n: number }>;

  const counts: CategoryCounts = {
    all: 0,
    reading: 0,
    music: 0,
    film: 0,
    podcasts: 0,
    bluesky: 0,
  };

  for (const row of rows) {
    if (row.cat in counts) {
      counts[row.cat as keyof CategoryCounts] = row.n;
    }
  }

  // All count = the actual visible-in-All-view cardinality, not the grand
  // total. See the doc comment above for rationale.
  for (const cat of Object.keys(ALL_VIEW_QUOTAS) as Array<keyof CategoryCounts>) {
    if (cat === "all") continue;
    counts.all += Math.min(ALL_VIEW_QUOTAS[cat], counts[cat]);
  }

  return counts;
}
