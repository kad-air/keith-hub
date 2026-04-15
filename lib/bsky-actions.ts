// Shared helpers for the Bluesky write endpoints
// (/api/items/[id]/bsky-like, /bsky-repost, /bsky-follow).
//
// Each endpoint loads the item's metadata, asks the AT Protocol to mutate
// something (like/repost/follow record), and persists the updated metadata
// JSON so the next render sees the new viewer state.

import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import type { BlueskyMetadata } from "@/lib/types";

export interface LoadedBlueskyItem {
  db: Database.Database;
  meta: BlueskyMetadata;
}

// Load + parse metadata for a Bluesky item. Throws if the item doesn't exist
// or the row isn't a Bluesky post (missing metadata or missing uri/did).
export function loadBlueskyItem(itemId: string): LoadedBlueskyItem {
  const db = getDb();
  const row = db
    .prepare("SELECT metadata FROM items WHERE id = ?")
    .get(itemId) as { metadata: string | null } | undefined;

  if (!row) {
    throw new BlueskyActionError("Item not found", 404);
  }
  if (!row.metadata) {
    throw new BlueskyActionError("Item has no metadata", 400);
  }

  let meta: BlueskyMetadata;
  try {
    meta = JSON.parse(row.metadata) as BlueskyMetadata;
  } catch {
    throw new BlueskyActionError("Item metadata is not valid JSON", 400);
  }

  // A post from before the uri/did backfill landed won't have these. The
  // next poll cycle will repopulate, but until then interactivity is off.
  if (!meta.uri || !meta.cid) {
    throw new BlueskyActionError("Post identity not available yet", 409);
  }

  return { db, meta };
}

export function saveBlueskyMetadata(
  db: Database.Database,
  itemId: string,
  meta: BlueskyMetadata
): void {
  db.prepare("UPDATE items SET metadata = ? WHERE id = ?").run(
    JSON.stringify(meta),
    itemId
  );
}

// When a follow lands, propagate the follow-record URI to every other
// Bluesky item authored by the same DID so their Follow chips hide too.
// Runs in the background after the endpoint responds — called synchronously
// here because better-sqlite3 is synchronous and the sweep is cheap.
export function propagateFollowToSiblings(
  db: Database.Database,
  authorDid: string,
  followingUri: string
): void {
  const stmt = db.prepare(`
    SELECT i.id, i.metadata
    FROM items i
    JOIN sources s ON s.id = i.source_id
    WHERE s.type = 'bluesky'
      AND i.metadata LIKE ?
  `);
  // LIKE prefilter on the DID string cuts the candidate set drastically
  // without requiring a generated column. Bluesky posts have only a few
  // thousand rows at most, so the JSON.parse sweep is fine.
  const rows = stmt.all(`%${authorDid}%`) as { id: string; metadata: string }[];
  const update = db.prepare("UPDATE items SET metadata = ? WHERE id = ?");
  const tx = db.transaction((candidates: { id: string; metadata: string }[]) => {
    for (const row of candidates) {
      let m: BlueskyMetadata;
      try {
        m = JSON.parse(row.metadata) as BlueskyMetadata;
      } catch {
        continue;
      }
      if (m.did !== authorDid) continue;
      if (m.viewer?.following_uri === followingUri) continue;
      m.viewer = { ...(m.viewer ?? {}), following_uri: followingUri };
      update.run(JSON.stringify(m), row.id);
    }
  });
  tx(rows);
}

export class BlueskyActionError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}
