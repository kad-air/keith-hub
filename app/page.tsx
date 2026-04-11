import { getDb } from "@/lib/db";
import { getCategoryCounts, getMainFeedItems } from "@/lib/queries";
import type { Item, CategoryCounts } from "@/lib/types";
import FeedClient from "@/components/FeedClient";

export const dynamic = "force-dynamic";

// Safety ceiling passed to getMainFeedItems. The actual feed size is
// determined by TTL-based pruning, not this limit. 2000 is generous
// enough to never clip a real 7-day window.
const MAIN_FEED_LIMIT = 2000;

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
        books: 0,
        music: 0,
        film: 0,
        podcasts: 0,
        bluesky: 0,
      },
    };
  }
}

export default function HomePage() {
  const { items, counts } = getInitialData();

  return <FeedClient initialItems={items} initialCounts={counts} />;
}
