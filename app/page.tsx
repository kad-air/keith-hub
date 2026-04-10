import { ensureInitialized } from "@/lib/init";
import { getDb } from "@/lib/db";
import { getCategoryCounts, getMainFeedItems } from "@/lib/queries";
import type { Item, CategoryCounts } from "@/lib/types";
import FeedClient from "@/components/FeedClient";

export const dynamic = "force-dynamic";

// Main feed cap. Big enough to clear daily backlog in one session,
// small enough that 300 cards aren't a perf disaster on iOS.
const MAIN_FEED_LIMIT = 300;

function getInitialData(): { items: Item[]; counts: CategoryCounts } {
  try {
    const db = getDb();
    const items = getMainFeedItems(db, MAIN_FEED_LIMIT);
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
