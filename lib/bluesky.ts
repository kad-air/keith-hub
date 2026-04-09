import { AtpAgent } from "@atproto/api";
import type Database from "better-sqlite3";
import type { SourceConfig } from "@/lib/config";

let agent: AtpAgent | null = null;

async function getAgent(): Promise<AtpAgent> {
  if (agent) return agent;

  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;

  if (!identifier || !password) {
    throw new Error(
      "BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD env vars are required"
    );
  }

  agent = new AtpAgent({ service: "https://bsky.social" });
  await agent.login({ identifier, password });
  console.log("[bluesky] Authenticated as", identifier);
  return agent;
}

function postUrl(handle: string, uri: string): string {
  // uri format: at://did:plc:.../app.bsky.feed.post/rkey
  const rkey = uri.split("/").pop() || "";
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

function extractImage(post: Record<string, unknown>): string | null {
  try {
    const embed = post.embed as Record<string, unknown> | undefined;
    if (!embed) return null;

    // images embed
    if (embed.$type === "app.bsky.embed.images#view") {
      const images = embed.images as Array<{ thumb: string }> | undefined;
      return images?.[0]?.thumb ?? null;
    }

    // external link embed with thumbnail
    if (embed.$type === "app.bsky.embed.external#view") {
      const external = embed.external as { thumb?: string } | undefined;
      return external?.thumb ?? null;
    }

    // record with media
    if (embed.$type === "app.bsky.embed.recordWithMedia#view") {
      const media = embed.media as Record<string, unknown> | undefined;
      if (media?.$type === "app.bsky.embed.images#view") {
        const images = media.images as Array<{ thumb: string }> | undefined;
        return images?.[0]?.thumb ?? null;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function fetchBlueskySource(
  source: SourceConfig,
  db: Database.Database
): Promise<number> {
  const bsky = await getAgent();
  const now = new Date().toISOString();
  let insertedCount = 0;

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO items
      (id, source_id, external_id, title, body_excerpt, author, url, image_url, published_at, fetched_at, metadata)
    VALUES
      (@id, @source_id, @external_id, @title, @body_excerpt, @author, @url, @image_url, @published_at, @fetched_at, @metadata)
  `);

  const updateSource = db.prepare(`
    UPDATE sources SET last_fetched_at = @last_fetched_at WHERE id = @id
  `);

  let posts: Array<{ post: Record<string, unknown> }> = [];

  try {
    if (source.mode === "feed" && source.feed_uri) {
      const res = await bsky.app.bsky.feed.getFeed({ feed: source.feed_uri, limit: 30 });
      posts = res.data.feed as unknown as typeof posts;
    } else if (source.mode === "timeline") {
      const res = await bsky.getTimeline({ limit: 50 });
      posts = res.data.feed as unknown as typeof posts;
    } else if (source.mode === "account" && source.handle) {
      const res = await bsky.getAuthorFeed({
        actor: source.handle,
        limit: 30,
        filter: "posts_no_replies",
      });
      posts = res.data.feed as unknown as typeof posts;
    } else {
      console.error(`[bluesky] Source ${source.id} needs mode + handle or feed_uri`);
      return 0;
    }
  } catch (err) {
    console.error(
      `[bluesky] Failed to fetch ${source.name}:`,
      err instanceof Error ? err.message : err
    );
    // Re-auth on next attempt if session expired
    agent = null;
    return 0;
  }

  const insertMany = db.transaction(
    (items: Parameters<typeof insertItem.run>[0][]) => {
      for (const item of items) {
        const result = insertItem.run(item);
        if (result.changes > 0) insertedCount++;
      }
    }
  );

  const rows = posts
    .map(({ post }) => {
      const record = post.record as Record<string, unknown>;
      const author = post.author as Record<string, string>;
      const text = (record.text as string) || "";
      const handle = author.handle || "";
      const avatar = author.avatar || null;
      const uri = (post.uri as string) || "";
      const indexedAt = (post.indexedAt as string) || now;
      const publishedAt =
        (record.createdAt as string) || indexedAt || now;

      const metadata = JSON.stringify({
        handle,
        avatar_url: avatar,
        like_count: (post.likeCount as number) || 0,
        reply_count: (post.replyCount as number) || 0,
        repost_count: (post.repostCount as number) || 0,
      });

      return {
        id: crypto.randomUUID(),
        source_id: source.id,
        external_id: uri,
        title: null, // Bluesky posts have no title — body_excerpt is used directly
        body_excerpt: text.slice(0, 300),
        author: handle,
        url: postUrl(handle, uri),
        image_url: extractImage(post),
        published_at: new Date(publishedAt).toISOString(),
        fetched_at: now,
        metadata,
      };
    })
    .filter((row) => row.url && row.external_id);

  insertMany(rows);
  updateSource.run({ last_fetched_at: now, id: source.id });

  console.log(`[bluesky] ${source.name}: inserted ${insertedCount} new posts`);
  return insertedCount;
}
