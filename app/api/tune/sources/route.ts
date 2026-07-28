import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getConfig, invalidateConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export interface SourceHealth {
  id: string;
  unread: number;
  itemsPerWeek: number;
  lastFetchedAt: string | null;
  lastError: string | null;
}

// Roster stats for the Tune sources pane: per-source unread count, weekly
// production rate, and fetch health. Config itself comes from
// /api/tune/config — this endpoint only adds what lives in the DB.
export async function GET(): Promise<NextResponse> {
  try {
    const db = getDb();
    invalidateConfig();
    const config = getConfig();

    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const rows = db
      .prepare(
        `SELECT
           s.id,
           s.last_fetched_at,
           s.last_error,
           SUM(CASE WHEN i.id IS NOT NULL AND ist.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
           SUM(CASE WHEN i.published_at >= ? THEN 1 ELSE 0 END) AS week_items
         FROM sources s
         LEFT JOIN items i ON i.source_id = s.id
         LEFT JOIN item_state ist ON ist.item_id = i.id
         GROUP BY s.id`
      )
      .all(weekAgo) as Array<{
      id: string;
      last_fetched_at: string | null;
      last_error: string | null;
      unread: number | null;
      week_items: number | null;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Keyed to config order so newly added (not yet crawled) sources appear.
    const sources: SourceHealth[] = config.sources.map((s) => {
      const row = byId.get(s.id);
      return {
        id: s.id,
        unread: row?.unread ?? 0,
        itemsPerWeek: row?.week_items ?? 0,
        lastFetchedAt: row?.last_fetched_at ?? null,
        lastError: row?.last_error ?? null,
      };
    });

    return NextResponse.json({ sources });
  } catch (err) {
    console.error("[api/tune/sources] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
