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

// ── Variety knobs for the All view ─────────────────────────────────────────
// The All view used to be quota selection + sort by published_at DESC, which
// clumped categories whenever a source published in a tight time window
// (e.g. all four Pitchfork album reviews dropping at the same hour). These
// knobs control the interleaver and the per-category surprise sampling that
// replace that strict recency sort.

// SURPRISE_POOL_MULTIPLIER — how much to oversample per category before
// narrowing to its quota. 1.0 = no surprise (deterministic newest-N).
// 1.5 = pull a 50%-larger window then sample down, so older-but-still-recent
// items can occasionally bubble up. Higher = more surprise, but at some
// point you start surfacing stale stuff.
export const SURPRISE_POOL_MULTIPLIER = 1.5;

// SURPRISE_RECENCY_BIAS — how strongly the weighted sample favors newer
// items in the pool. 0 = uniform random across the pool. With bias=3, the
// newest item in the pool is ~20x more likely to be picked than the oldest;
// every item still has a real chance, so surprise happens regularly without
// burying the freshest stuff.
export const SURPRISE_RECENCY_BIAS = 3;

// INTERLEAVE_JITTER — perturbation applied to stride-scheduled positions
// when interleaving categories. 0 = perfectly mechanical cadence (with
// current quotas: P M F P R B repeating). ~0.35 = mild swaps between
// adjacent slots, breaks the rigid pattern but keeps no-two-in-a-row most
// of the time. 1.0 = chaotic — categories may clump occasionally.
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
 * as position cleanly. The oversampling itself happens upstream in
 * getMainFeedItems where the SQL LIMIT is set.
 */
function selectWithSurprise(items: Item[], quota: number): Item[] {
  if (items.length <= quota) return items;
  const poolSize = items.length;
  return weightedSample(items, quota, (_item, rank) =>
    Math.exp((-SURPRISE_RECENCY_BIAS * rank) / Math.max(poolSize - 1, 1))
  );
}

/**
 * Stride-scheduled interleave. Each category emits items at intervals
 * proportional to its actual item count — high-count categories appear
 * more often, low-count less. Phase offsets prevent multiple categories
 * from landing on the same virtual position. INTERLEAVE_JITTER perturbs
 * positions slightly so the cadence isn't perfectly mechanical.
 *
 * Stride is based on the **actual item count**, not the global quota.
 * The quotas already did their job in the selection phase (picking how
 * many items each category contributes). Here the goal is purely even
 * spacing: if Today has 20 bluesky and 5 music items, the 5 music items
 * should be spread evenly among the 20 bluesky items. Using the quota
 * (which is equal for those two categories) would give them identical
 * strides, so music would run out early and bluesky would clump at the
 * tail.
 *
 * No category appears twice in a row unless one category has more items
 * than all others combined.
 */
function interleaveByQuota(
  byCategory: Array<{ cat: keyof CategoryCounts; items: Item[] }>
): Item[] {
  const active = byCategory.filter((c) => c.items.length > 0);
  if (active.length === 0) return [];

  const totalItems = active.reduce((sum, { items }) => sum + items.length, 0);
  if (totalItems <= 0) return [];

  type Slot = { vpos: number; item: Item };
  const slots: Slot[] = [];

  active.forEach(({ items }, catIdx) => {
    const count = items.length;
    const stride = totalItems / count;
    const phase = (stride * catIdx) / active.length;
    for (let rank = 0; rank < items.length; rank++) {
      const jitter = (Math.random() - 0.5) * stride * INTERLEAVE_JITTER;
      slots.push({ vpos: phase + rank * stride + jitter, item: items[rank] });
    }
  });

  slots.sort((a, b) => a.vpos - b.vpos);
  return slots.map((s) => s.item);
}

/**
 * Returns up to `limit` items for the main feed. Two-phase algorithm:
 *
 * 1. **Per-category selection with surprise.** Each category contributes up
 *    to ALL_VIEW_QUOTAS[cat] items, picked from a SURPRISE_POOL_MULTIPLIER-
 *    sized recency window via weighted sampling — newer items strongly
 *    favored, older items occasionally bubbling up for variety.
 * 2. **Count-based stride interleave.** The selected items are woven
 *    together so each category's items are evenly spaced. Stride is based
 *    on the actual item count per category, not the quota — the quotas
 *    already determined composition in step 1. This means a category with
 *    20 items and one with 5 items get proportional spacing: the 5 items
 *    are spread evenly among the 20, no clumping at the tail. The
 *    downstream groupByDate is order-preserving so the interleave pattern
 *    survives the Today/Yesterday/etc. split.
 *
 * The output is NOT sorted by published_at — that strict recency sort was
 * exactly what caused categories to clump whenever a source published in a
 * tight time window.
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

  const byCategory: Array<{ cat: keyof CategoryCounts; items: Item[] }> = [];
  for (const [catKey, quota] of Object.entries(ALL_VIEW_QUOTAS) as Array<
    [keyof CategoryCounts, number]
  >) {
    if (catKey === "all" || quota <= 0) continue;
    const poolSize = Math.max(quota, Math.ceil(quota * SURPRISE_POOL_MULTIPLIER));
    const pool = stmt.all(catKey, poolSize) as Item[];
    byCategory.push({ cat: catKey, items: selectWithSurprise(pool, quota) });
  }

  return interleaveByQuota(byCategory).slice(0, limit);
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
