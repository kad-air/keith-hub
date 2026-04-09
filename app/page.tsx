import { ensureInitialized } from "@/lib/init";
import { getDb, RANKED_ORDER } from "@/lib/db";
import { getCategoryCounts } from "@/lib/queries";
import type { Item, CategoryCounts } from "@/lib/types";
import FeedClient from "@/components/FeedClient";

export const dynamic = "force-dynamic";

function getInitialData(): { items: Item[]; counts: CategoryCounts } {
  try {
    const db = getDb();
    const items = db
      .prepare(
        `
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
        WHERE ist.read_at IS NULL
        ORDER BY ${RANKED_ORDER}
        LIMIT 50
      `
      )
      .all() as Item[];
    const counts = getCategoryCounts(db);
    return { items, counts };
  } catch (err) {
    console.error("[page] Failed to load initial items:", err);
    return {
      items: [],
      counts: {
        all: 0,
        reading: 0,
        music: 0,
        film: 0,
        podcasts: 0,
        bluesky: 0,
      },
    };
  }
}

export default function HomePage() {
  ensureInitialized();
  const { items, counts } = getInitialData();

  return <FeedClient initialItems={items} initialCounts={counts} />;
}
