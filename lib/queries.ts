import type Database from "better-sqlite3";
import type { CategoryCounts, Item } from "./types";

// Categories whose items must always make the cut into the main feed.
// "Never miss" means: take all unread items from these categories first
// (capped at the total limit if there are more), then fill remaining slots
// with everything else by recency, then sort the merged set by recency for
// display. So high-signal items aren't pinned to the top — they're just
// guaranteed to be IN the 300.
const HIGH_SIGNAL_CATEGORIES = ["podcasts", "music", "film"];

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
 * Returns up to `limit` unread items for the main feed, prioritizing
 * inclusion (not order) of HIGH_SIGNAL_CATEGORIES. Display order is pure
 * published_at DESC across the merged set.
 */
export function getMainFeedItems(
  db: Database.Database,
  limit: number
): Item[] {
  const placeholders = HIGH_SIGNAL_CATEGORIES.map(() => "?").join(",");

  // Step 1: pull all unread high-signal items, newest first, capped at the
  // total limit. If there are MORE high-signal items than the limit, the
  // newest ones win and low-signal gets nothing — backlog phase.
  const highSignal = db
    .prepare(
      `${ITEM_SELECT}
       WHERE ist.read_at IS NULL AND s.category IN (${placeholders})
       ORDER BY i.published_at DESC
       LIMIT ?`
    )
    .all(...HIGH_SIGNAL_CATEGORIES, limit) as Item[];

  // Step 2: fill remaining slots with the most-recent low-signal items.
  const remaining = Math.max(0, limit - highSignal.length);
  let lowSignal: Item[] = [];
  if (remaining > 0) {
    lowSignal = db
      .prepare(
        `${ITEM_SELECT}
         WHERE ist.read_at IS NULL AND s.category NOT IN (${placeholders})
         ORDER BY i.published_at DESC
         LIMIT ?`
      )
      .all(...HIGH_SIGNAL_CATEGORIES, remaining) as Item[];
  }

  // Step 3: merge and sort by recency for display. Stable sort, equal
  // timestamps keep their query order.
  return [...highSignal, ...lowSignal].sort((a, b) =>
    a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0
  );
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
 * Returns the per-category count of unread items, plus a grand total.
 * Uses a single grouped query — much cheaper than 6 separate counts.
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
    counts.all += row.n;
  }

  return counts;
}
