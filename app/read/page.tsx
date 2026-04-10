import { getDb } from "@/lib/db";
import type { Item } from "@/lib/types";
import ReadClient from "@/components/ReadClient";

export const dynamic = "force-dynamic";

function getReadItems(): Item[] {
  try {
    const db = getDb();
    return db
      .prepare(
        `SELECT
          i.*,
          s.name as source_name,
          s.category as source_category,
          ist.read_at,
          ist.saved_at,
          ist.consumed_at,
          ist.notes
        FROM items i
        JOIN item_state ist ON ist.item_id = i.id
        JOIN sources s ON s.id = i.source_id
        WHERE ist.consumed_at IS NOT NULL
        ORDER BY ist.consumed_at DESC
        LIMIT 200`
      )
      .all() as Item[];
  } catch (err) {
    console.error("[read] Failed to load read items:", err);
    return [];
  }
}

export default function ReadPage() {
  const items = getReadItems();
  return <ReadClient initialItems={items} />;
}
