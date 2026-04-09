import { ensureInitialized } from "@/lib/init";
import { getDb, RANKED_ORDER } from "@/lib/db";
import type { Item } from "@/lib/types";
import FeedClient from "@/components/FeedClient";

export const dynamic = "force-dynamic";

function getInitialItems(): Item[] {
  try {
    const db = getDb();
    const rows = db
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
    return rows;
  } catch (err) {
    console.error("[page] Failed to load initial items:", err);
    return [];
  }
}

export default function HomePage() {
  ensureInitialized();
  const initialItems = getInitialItems();

  return <FeedClient initialItems={initialItems} />;
}
