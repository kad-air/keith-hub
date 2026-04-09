import { getDb } from "@/lib/db";
import type { Item } from "@/lib/types";
import SavedClient from "@/components/SavedClient";

export const dynamic = "force-dynamic";

function getSavedItems(): Item[] {
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
        WHERE ist.saved_at IS NOT NULL
        ORDER BY ist.saved_at DESC`
      )
      .all() as Item[];
  } catch (err) {
    console.error("[saved] Failed to load saved items:", err);
    return [];
  }
}

export default function SavedPage() {
  const items = getSavedItems();
  return <SavedClient initialItems={items} />;
}
