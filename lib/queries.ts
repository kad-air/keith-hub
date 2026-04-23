import type Database from "better-sqlite3";
import { getDb } from "./db";
import type { CategoryCounts, Item } from "./types";

// ── Time-based falloff ─────────────────────────────────────────────────────
// RSS items older than their TTL are auto-marked read each poll cycle.
// consumed_at is NEVER set, so /read history is unaffected. Pruned items
// become "pending": still in items, with item_state.read_at set, invisible
// to every view.
//
// Bluesky uses a position-based window instead of a TTL (see BSKY_WINDOW
// below). Anything outside the newest-N unread posts gets auto-marked read,
// so the well is bounded: clearing the feed does NOT dig deeper into the
// backlog — the next refresh only surfaces genuinely-new posts.
export const UNREAD_TTL_HOURS: Record<string, number> = {
  music:       168,   // 7 days
  books:       168,   // 7 days
  film:        168,   // 7 days
  podcasts:    168,   // 7 days
  reading:     168,   // 7 days
  tech_review: 168,   // 7 days
};

// ── Priority weights for interleave ────────────────────────────────────────
// Higher priority → earlier phase offset → items appear sooner/denser in the
// All view. Reviews are the highest-signal content, bluesky is social filler.
export const ALL_VIEW_PRIORITY: Record<keyof CategoryCounts, number> = {
  all:         0,
  music:       4,   // album reviews — highest
  books:       4,   // book reviews — highest
  film:        4,   // film reviews — highest
  tech_review: 4,   // Verge reviews — escalated to review tier
  podcasts:    3,   // daily listening
  reading:     2,   // Verge articles + quickposts
  bluesky:     1,   // social filler
};

// ── Bluesky derivation ────────────────────────────────────────────────────
// Bluesky count is derived from RSS total, not independently capped.
// When RSS items exist: 1 bsky per BSKY_INTERLEAVE_RATIO RSS items.
// When RSS is empty: no bsky in the All view — the feed goes empty and
// honors "enough for now". The Bluesky tab (category filter, pure recency)
// still surfaces every unread post, so the backlog is never stranded.
//
// BSKY_WINDOW sizes the bounded unread backlog: each poll cycle, any unread
// bsky post outside the newest N gets hard-deleted. Combined with the
// RSS-empty = zero-bsky rule above, a dismiss-all settles to empty until
// a genuinely-new post (or RSS item) arrives on the next poll.
export const BSKY_INTERLEAVE_RATIO = 4;
export const BSKY_WINDOW = 100;

// ── Universal retention ───────────────────────────────────────────────────
// Items with read_at set but no saved_at and no consumed_at get hard-deleted
// this many hours after being marked read. Applies to every category.
// Saved (saved_at) and opened (consumed_at) items are kept forever.
export const READ_RETENTION_HOURS = 168; // 7 days

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
 * RSS items, selected via surprise sampling for variety. When there is
 * no unread RSS, the All view returns empty — no bsky fallback — so
 * "dismiss all" settles to empty instead of dumping the bsky backlog.
 * The Bluesky tab continues to surface every unread post on its own.
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
    "music", "books", "film", "tech_review", "podcasts", "reading",
  ];
  for (const cat of rssCategories) {
    const items = stmtAll.all(cat) as Item[];
    if (items.length > 0) byCategory.push({ cat, items });
  }

  // Bluesky: sprinkle in proportional to RSS volume. No fallback when RSS
  // is empty — the All view goes empty in that case so "dismiss all"
  // genuinely clears. Unread bsky is still fully available via the
  // Bluesky tab (category filter, pure recency).
  const totalRss = byCategory.reduce((sum, { items }) => sum + items.length, 0);
  if (totalRss > 0) {
    const bskyTarget = Math.max(10, Math.ceil(totalRss / BSKY_INTERLEAVE_RATIO));
    const bskyPool = stmtLimited.all(
      "bluesky",
      Math.ceil(bskyTarget * SURPRISE_POOL_MULTIPLIER)
    ) as Item[];
    const bskyItems = selectWithSurprise(bskyPool, bskyTarget);
    if (bskyItems.length > 0) byCategory.push({ cat: "bluesky", items: bskyItems });
  }

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

  // Bluesky: position-based window. Anything outside the newest BSKY_WINDOW
  // unread bsky posts gets HARD DELETED (unless the user saved it or opened
  // it) — bsky volume is high enough that just marking read would bloat the
  // items table forever. Saved/consumed posts are preserved so /saved and
  // /read stay correct. With LEFT JOIN, "unread-and-untouched" means either
  // no state row at all or a state row with null read/saved/consumed —
  // `ist.read_at IS NULL` etc. handle both uniformly.
  const bskyTargetIds = db
    .prepare(
      `SELECT i.id FROM items i
       LEFT JOIN item_state ist ON ist.item_id = i.id
       JOIN sources s ON s.id = i.source_id
       WHERE s.category = 'bluesky'
         AND ist.read_at IS NULL
         AND ist.saved_at IS NULL
         AND ist.consumed_at IS NULL
         AND i.id NOT IN (
           SELECT i2.id FROM items i2
           LEFT JOIN item_state ist2 ON ist2.item_id = i2.id
           JOIN sources s2 ON s2.id = i2.source_id
           WHERE ist2.read_at IS NULL AND s2.category = 'bluesky'
           ORDER BY i2.published_at DESC
           LIMIT ?
         )`
    )
    .all(BSKY_WINDOW) as Array<{ id: string }>;
  if (bskyTargetIds.length > 0) {
    // item_state has a FK to items with no ON DELETE CASCADE — delete state
    // rows first (if any exist), then the items themselves.
    const deleteState = db.prepare(`DELETE FROM item_state WHERE item_id = ?`);
    const deleteItem = db.prepare(`DELETE FROM items WHERE id = ?`);
    const tx = db.transaction((rows: Array<{ id: string }>) => {
      for (const r of rows) {
        deleteState.run(r.id);
        deleteItem.run(r.id);
      }
    });
    tx(bskyTargetIds);
    total += bskyTargetIds.length;
  }

  // Universal expiry: after 7 days, silently drop anything the user never
  // engaged with — i.e., read but not saved and not opened. Dismissed items
  // and TTL-pruned items both land here. Saved or consumed items survive
  // forever (so /saved is permanent and /read is a full history).
  const staleReadCutoff = new Date(
    Date.now() - READ_RETENTION_HOURS * 3600_000
  ).toISOString();
  const staleDeleteState = db.prepare(`
    DELETE FROM item_state
    WHERE read_at IS NOT NULL
      AND read_at < ?
      AND saved_at IS NULL
      AND consumed_at IS NULL
  `);
  const staleDeleteItems = db.prepare(`
    DELETE FROM items
    WHERE id NOT IN (SELECT item_id FROM item_state)
      AND id IN (
        SELECT i.id FROM items i
        WHERE i.published_at < ?
      )
  `);
  const staleTx = db.transaction(() => {
    staleDeleteState.run(staleReadCutoff);
    // Items orphaned by the state delete above AND old enough to not be
    // in-flight (still loading, waiting for first interaction) get dropped.
    const r = staleDeleteItems.run(staleReadCutoff);
    total += r.changes;
  });
  staleTx();

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
    tech_review: 0,
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

  // All count = RSS totals + derived bsky contribution (mirrors getMainFeedItems).
  // No RSS = no bsky in the All view, so the badge reads zero — matches
  // what the user actually sees when the feed is drained.
  const totalRss = counts.music + counts.books + counts.film + counts.tech_review + counts.podcasts + counts.reading;
  const bskyContribution = totalRss > 0
    ? Math.min(counts.bluesky, Math.max(10, Math.ceil(totalRss / BSKY_INTERLEAVE_RATIO)))
    : 0;
  counts.all = totalRss + bskyContribution;

  return counts;
}

// ─── Comics ────────────────────────────────────────────────
// Backed by the comic_state table. Catalog itself lives in
// lib/comics-data.ts (static); the DB only stores read state.
// Marking unread = deleting the row (read_at is NOT NULL).

export function getReadComicIds(): Set<string> {
  const db = getDb();
  const rows = db.prepare(`SELECT issue_id FROM comic_state`).all() as { issue_id: string }[];
  return new Set(rows.map((r) => r.issue_id));
}

export function markComicRead(issueId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO comic_state (issue_id, read_at)
    VALUES (?, ?)
    ON CONFLICT(issue_id) DO NOTHING
  `).run(issueId, new Date().toISOString());
}

export function markComicUnread(issueId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM comic_state WHERE issue_id = ?`).run(issueId);
}
