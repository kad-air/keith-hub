import type Database from "better-sqlite3";
import type { CategoryCounts, Item } from "./types";

// ── Time-based falloff ─────────────────────────────────────────────────────
// RSS items older than their TTL are auto-marked read each poll cycle.
// consumed_at is NEVER set, so /read history is unaffected. Pruned items
// become "pending": still in items, with item_state.read_at set, invisible
// to every view.
//
// Bluesky has NO TTL — it doesn't need one. The All view only pulls enough
// bsky posts to interleave between RSS items (see BSKY_INTERLEAVE_RATIO),
// so stale posts naturally fall off as the selection window slides forward.
// The bluesky tab still shows all unread posts via pure recency.
export const UNREAD_TTL_HOURS: Record<string, number> = {
  music:    168,   // 7 days
  books:    168,   // 7 days
  film:     168,   // 7 days
  podcasts: 168,   // 7 days
  reading:  168,   // 7 days
};

// ── Priority weights for interleave ────────────────────────────────────────
// Higher priority → earlier phase offset → items appear sooner/denser in the
// All view. Reviews are the highest-signal content, bluesky is social filler.
export const ALL_VIEW_PRIORITY: Record<keyof CategoryCounts, number> = {
  all:      0,
  music:    4,   // album reviews — highest
  books:    4,   // book reviews — highest
  film:     4,   // film reviews — highest
  podcasts: 3,   // daily listening
  reading:  2,   // Verge articles
  bluesky:  1,   // social filler
};

// ── Bluesky derivation ────────────────────────────────────────────────────
// Bluesky count is derived from RSS total, not independently capped.
// When RSS items exist: 1 bsky per BSKY_INTERLEAVE_RATIO RSS items.
// When RSS is empty: fall back to BSKY_FALLBACK_MAX.
export const BSKY_INTERLEAVE_RATIO = 4;
export const BSKY_FALLBACK_MAX = 100;

// ── Variety knobs for the All view ─────────────────────────────────────────
// These control the surprise sampling (for bluesky's capped selection) and
// the interleave jitter (for all categories).

// SURPRISE_POOL_MULTIPLIER — how much to oversample bluesky before narrowing.
// 1.0 = no surprise. 1.5 = pull 50% more then sample down.
export const SURPRISE_POOL_MULTIPLIER = 1.5;

// SURPRISE_RECENCY_BIAS — how strongly the weighted sample favors newer items.
// 0 = uniform random. 3 = newest ~20x more likely than oldest.
export const SURPRISE_RECENCY_BIAS = 3;

// INTERLEAVE_JITTER — perturbation applied to stride-scheduled positions.
// 0 = perfectly mechanical cadence. ~0.35 = mild swaps between adjacent slots.
export const INTERLEAVE_JITTER = 0.35;

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
 * Weighted random sample without replacement using the Efraimidis–Spirakis
 * algorithm. Each item gets a key = -ln(random) / weight; the k items with
 * the smallest keys are selected. Returned in original input order so a
 * recency-sorted input stays approximately recency-sorted on output.
 */
function weightedSample<T>(
  items: T[],
  k: number,
  weight: (item: T, index: number) => number
): T[] {
  if (items.length <= k) return [...items];
  const keyed = items.map((item, index) => {
    const w = Math.max(weight(item, index), 1e-9);
    const r = Math.random() || 1e-30;
    return { item, index, key: -Math.log(r) / w };
  });
  keyed.sort((a, b) => a.key - b.key);
  return keyed
    .slice(0, k)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.item);
}

/**
 * Narrows an already-oversampled recency-sorted pool down to `quota` items
 * via weighted sampling, with SURPRISE_RECENCY_BIAS favoring newer items.
 * Output preserves recency order so the interleaver downstream can use rank
 * as position cleanly.
 */
function selectWithSurprise(items: Item[], quota: number): Item[] {
  if (items.length <= quota) return items;
  const poolSize = items.length;
  return weightedSample(items, quota, (_item, rank) =>
    Math.exp((-SURPRISE_RECENCY_BIAS * rank) / Math.max(poolSize - 1, 1))
  );
}

/**
 * Priority-weighted stride interleave. Categories are sorted by priority
 * descending so higher-priority categories get earlier phase offsets (their
 * first items appear first in the feed). Stride is based on actual item
 * count — categories with more items appear more often, fewer items less.
 * INTERLEAVE_JITTER perturbs positions for mild randomness.
 */
function interleaveByPriority(
  byCategory: Array<{ cat: keyof CategoryCounts; items: Item[] }>
): Item[] {
  const active = byCategory.filter((c) => c.items.length > 0);
  if (active.length === 0) return [];

  const totalItems = active.reduce((sum, { items }) => sum + items.length, 0);
  if (totalItems <= 0) return [];

  // Sort by priority DESC so high-priority categories get early phase offsets
  const sorted = [...active].sort(
    (a, b) => (ALL_VIEW_PRIORITY[b.cat] || 0) - (ALL_VIEW_PRIORITY[a.cat] || 0)
  );

  type Slot = { vpos: number; item: Item };
  const slots: Slot[] = [];

  sorted.forEach(({ items }, catIdx) => {
    const count = items.length;
    const stride = totalItems / count;
    const phase = (stride * catIdx) / sorted.length;
    for (let rank = 0; rank < items.length; rank++) {
      const jitter = (Math.random() - 0.5) * stride * INTERLEAVE_JITTER;
      slots.push({ vpos: phase + rank * stride + jitter, item: items[rank] });
    }
  });

  slots.sort((a, b) => a.vpos - b.vpos);
  return slots.map((s) => s.item);
}

/**
 * Returns items for the main feed. Every unread RSS item makes it in
 * (bounded only by the TTL prune — effectively up to 7 days of content).
 * Bluesky is sprinkled in for flavor: 1 post per BSKY_INTERLEAVE_RATIO
 * RSS items, selected via surprise sampling for variety.
 *
 * Priority-weighted interleave ensures reviews appear earlier/denser
 * than articles, with bluesky filling gaps.
 */
export function getMainFeedItems(
  db: Database.Database,
  _limit: number
): Item[] {
  const stmtAll = db.prepare(
    `${ITEM_SELECT}
     WHERE ist.read_at IS NULL AND s.category = ?
     ORDER BY i.published_at DESC`
  );
  const stmtLimited = db.prepare(
    `${ITEM_SELECT}
     WHERE ist.read_at IS NULL AND s.category = ?
     ORDER BY i.published_at DESC
     LIMIT ?`
  );

  const byCategory: Array<{ cat: keyof CategoryCounts; items: Item[] }> = [];

  // Every unread RSS item flows in (TTL prune is the only bound)
  const rssCategories: Array<keyof CategoryCounts> = [
    "music", "books", "film", "podcasts", "reading",
  ];
  for (const cat of rssCategories) {
    const items = stmtAll.all(cat) as Item[];
    if (items.length > 0) byCategory.push({ cat, items });
  }

  // Bluesky: sprinkle in proportional to RSS volume
  const totalRss = byCategory.reduce((sum, { items }) => sum + items.length, 0);
  const bskyTarget = totalRss > 0
    ? Math.max(10, Math.ceil(totalRss / BSKY_INTERLEAVE_RATIO))
    : BSKY_FALLBACK_MAX;
  const bskyPool = stmtLimited.all(
    "bluesky",
    Math.ceil(bskyTarget * SURPRISE_POOL_MULTIPLIER)
  ) as Item[];
  const bskyItems = selectWithSurprise(bskyPool, bskyTarget);
  if (bskyItems.length > 0) byCategory.push({ cat: "bluesky", items: bskyItems });

  return interleaveByPriority(byCategory);
}

/**
 * Enforces time-based falloff across all categories. Items older than their
 * category's TTL get read_at set; consumed_at is left null so /read history
 * is unaffected. Idempotent — running twice is the same as once.
 *
 * Run this at the END of every poll cycle, after fetches complete, so
 * fresh items get a chance to be ranked before older ones expire.
 */
export function pruneExpiredUnread(db: Database.Database): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO item_state (item_id, read_at)
    SELECT i.id, ?
    FROM items i
    LEFT JOIN item_state ist ON ist.item_id = i.id
    JOIN sources s ON s.id = i.source_id
    WHERE ist.read_at IS NULL
      AND s.category = ?
      AND i.published_at < ?
    ON CONFLICT(item_id) DO UPDATE SET read_at = excluded.read_at
  `);

  let total = 0;
  for (const [category, hours] of Object.entries(UNREAD_TTL_HOURS)) {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const result = stmt.run(now, category, cutoff);
    total += result.changes;
  }
  return total;
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
 * (already bounded by TTL-based pruning).
 *
 * The All count reflects the actual composition of the All view:
 * all RSS items + derived bluesky contribution.
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
    books: 0,
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

  // All count = RSS totals + derived bsky contribution (mirrors getMainFeedItems)
  const totalRss = counts.music + counts.books + counts.film + counts.podcasts + counts.reading;
  const bskyContribution = totalRss > 0
    ? Math.min(counts.bluesky, Math.max(10, Math.ceil(totalRss / BSKY_INTERLEAVE_RATIO)))
    : Math.min(counts.bluesky, BSKY_FALLBACK_MAX);
  counts.all = totalRss + bskyContribution;

  return counts;
}
