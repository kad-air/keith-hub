import { AtpAgent } from "@atproto/api";
import type Database from "better-sqlite3";
import type { SourceConfig } from "@/lib/config";
import type {
  BlueskyMetadata,
  BlueskyImage,
  BlueskyExternalCard,
  BlueskyQuotedPost,
  BlueskyReplyContext,
  BlueskyRepostContext,
} from "@/lib/types";

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

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// All embed handlers below treat the embed as `any` because the AT Protocol
// embed types are a discriminated union and runtime narrowing via $type is
// simpler than full type guards. The shape we read is documented in
// node_modules/@atproto/api/dist/client/types/app/bsky/embed/*.d.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any;

function extractImages(embed: AnyObj | undefined): BlueskyImage[] | undefined {
  if (!embed?.images || !Array.isArray(embed.images)) return undefined;
  const out = embed.images
    .map((img: AnyObj) => ({
      thumb: img.thumb as string,
      fullsize: img.fullsize as string,
      alt: (img.alt as string) || "",
      aspect_ratio: img.aspectRatio
        ? {
            width: img.aspectRatio.width as number,
            height: img.aspectRatio.height as number,
          }
        : undefined,
    }))
    .filter((img: BlueskyImage) => img.thumb && img.fullsize);
  return out.length > 0 ? out : undefined;
}

function extractExternal(embed: AnyObj | undefined): BlueskyExternalCard | undefined {
  const ext = embed?.external;
  if (!ext?.uri) return undefined;
  return {
    url: ext.uri as string,
    title: (ext.title as string) || "",
    description: (ext.description as string) || "",
    thumb: (ext.thumb as string) || null,
    domain: safeDomain(ext.uri as string),
  };
}

function extractQuoted(embed: AnyObj | undefined): BlueskyQuotedPost | undefined {
  // For app.bsky.embed.record#view the record is at embed.record
  // For app.bsky.embed.recordWithMedia#view it's at embed.record.record
  let viewRecord: AnyObj | undefined;
  if (embed?.$type === "app.bsky.embed.record#view") {
    viewRecord = embed.record;
  } else if (embed?.$type === "app.bsky.embed.recordWithMedia#view") {
    viewRecord = embed.record?.record;
  }
  if (!viewRecord) return undefined;
  // Skip blocked / not-found / non-post records (lists, generators, etc.)
  if (viewRecord.$type !== "app.bsky.embed.record#viewRecord") return undefined;

  const author = viewRecord.author as AnyObj;
  const value = viewRecord.value as AnyObj;
  if (!author?.handle || !value) return undefined;

  // Quoted-post embeds (yes, quotes can have their own embeds) live on
  // viewRecord.embeds (an array). We pull out images and external link cards
  // recursively, but we don't go deeper to avoid runaway nesting.
  const innerEmbed = (viewRecord.embeds as AnyObj[] | undefined)?.[0];
  const innerImages = innerEmbed ? extractImages(innerEmbed) : undefined;
  const innerExternal = innerEmbed ? extractExternal(innerEmbed) : undefined;

  return {
    handle: author.handle as string,
    display_name: (author.displayName as string) || undefined,
    avatar_url: (author.avatar as string) || null,
    text: (value.text as string) || "",
    indexed_at: (viewRecord.indexedAt as string) || "",
    url: postUrl(author.handle as string, viewRecord.uri as string),
    images: innerImages,
    external: innerExternal,
  };
}

// recordWithMedia has BOTH a quoted record AND media (images/external).
// Pull the media out separately so we render it as the post's own embed
// alongside the quoted card.
function extractRecordWithMediaMedia(embed: AnyObj | undefined): {
  images?: BlueskyImage[];
  external?: BlueskyExternalCard;
} {
  if (embed?.$type !== "app.bsky.embed.recordWithMedia#view") return {};
  const media = embed.media as AnyObj;
  if (!media) return {};
  return {
    images: extractImages(media),
    external: extractExternal(media),
  };
}

function extractReplyContext(reply: AnyObj | undefined): BlueskyReplyContext | undefined {
  if (!reply?.parent) return undefined;
  const parent = reply.parent as AnyObj;
  // Skip if parent is blocked, not found, or otherwise unavailable
  if (parent.$type !== "app.bsky.feed.defs#postView") return undefined;
  const author = parent.author as AnyObj;
  const record = parent.record as AnyObj;
  if (!author?.handle || !record) return undefined;
  const text = (record.text as string) || "";
  return {
    handle: author.handle as string,
    display_name: (author.displayName as string) || undefined,
    text: text.length > 240 ? text.slice(0, 237) + "…" : text,
  };
}

function extractRepostContext(reason: AnyObj | undefined): BlueskyRepostContext | undefined {
  if (reason?.$type !== "app.bsky.feed.defs#reasonRepost") return undefined;
  const by = reason.by as AnyObj;
  if (!by?.handle) return undefined;
  return {
    handle: by.handle as string,
    display_name: (by.displayName as string) || undefined,
  };
}

function buildBlueskyMetadata(feedViewPost: AnyObj): BlueskyMetadata {
  const post = feedViewPost.post as AnyObj;
  const author = post.author as AnyObj;
  const embed = post.embed as AnyObj | undefined;

  // For recordWithMedia, the media (images/external) lives next to the quoted
  // record. Pull it out so we can render it as the post's own embed.
  const rwmMedia = extractRecordWithMediaMedia(embed);

  return {
    handle: (author?.handle as string) || "",
    display_name: (author?.displayName as string) || undefined,
    avatar_url: (author?.avatar as string) || null,
    like_count: (post.likeCount as number) || 0,
    reply_count: (post.replyCount as number) || 0,
    repost_count: (post.repostCount as number) || 0,
    images: rwmMedia.images ?? extractImages(embed),
    external: rwmMedia.external ?? extractExternal(embed),
    quoted: extractQuoted(embed),
    reply_to: extractReplyContext(feedViewPost.reply as AnyObj | undefined),
    reposted_by: extractRepostContext(feedViewPost.reason as AnyObj | undefined),
  };
}

// First image thumb for the legacy items.image_url column. Kept so non-Bluesky
// code paths that read image_url still work; the Bluesky card itself uses the
// rich metadata.images array.
function firstImageThumb(meta: BlueskyMetadata): string | null {
  if (meta.images && meta.images.length > 0) return meta.images[0].thumb;
  if (meta.external?.thumb) return meta.external.thumb;
  return null;
}

export async function fetchBlueskySource(
  source: SourceConfig,
  db: Database.Database
): Promise<number> {
  const bsky = await getAgent();
  const now = new Date().toISOString();
  let insertedCount = 0;

  // On conflict (re-fetch of an existing post), refresh just the content
  // fields. Don't touch the row's id (so item_state's FK still resolves) or
  // published_at/fetched_at (so ranking and ordering stay stable). This is
  // what lets a code change to the metadata extractor backfill old rows on
  // the next poll cycle, instead of only affecting brand-new posts.
  const insertItem = db.prepare(`
    INSERT INTO items
      (id, source_id, external_id, title, body_excerpt, author, url, image_url, published_at, fetched_at, metadata)
    VALUES
      (@id, @source_id, @external_id, @title, @body_excerpt, @author, @url, @image_url, @published_at, @fetched_at, @metadata)
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      body_excerpt = excluded.body_excerpt,
      image_url = excluded.image_url,
      metadata = excluded.metadata
  `);

  const updateSource = db.prepare(`
    UPDATE sources SET last_fetched_at = @last_fetched_at WHERE id = @id
  `);

  let posts: AnyObj[] = [];

  try {
    if (source.mode === "feed" && source.feed_uri) {
      const res = await bsky.app.bsky.feed.getFeed({ feed: source.feed_uri, limit: 30 });
      posts = res.data.feed as unknown as AnyObj[];
    } else if (source.mode === "timeline") {
      const res = await bsky.getTimeline({ limit: 50 });
      posts = res.data.feed as unknown as AnyObj[];
    } else if (source.mode === "account" && source.handle) {
      const res = await bsky.getAuthorFeed({
        actor: source.handle,
        limit: 30,
        filter: "posts_no_replies",
      });
      posts = res.data.feed as unknown as AnyObj[];
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

  // Pre-check existence so we can count new posts accurately. With ON
  // CONFLICT DO UPDATE, statement.changes returns 1 for both inserts and
  // updates and there's no way to tell them apart without an extra lookup.
  const existsStmt = db.prepare(
    "SELECT 1 FROM items WHERE source_id = ? AND external_id = ?"
  );
  type Row = {
    id: string;
    source_id: string;
    external_id: string;
    title: string | null;
    body_excerpt: string;
    author: string;
    url: string;
    image_url: string | null;
    published_at: string;
    fetched_at: string;
    metadata: string;
  };
  const insertMany = db.transaction((items: Row[]) => {
    for (const item of items) {
      const exists = existsStmt.get(item.source_id, item.external_id);
      insertItem.run(item);
      if (!exists) insertedCount++;
    }
  });

  const rows = posts
    .map((feedViewPost) => {
      const post = feedViewPost.post as AnyObj;
      const record = post.record as AnyObj;
      const author = post.author as AnyObj;
      const text = (record.text as string) || "";
      const handle = (author.handle as string) || "";
      const uri = (post.uri as string) || "";
      const indexedAt = (post.indexedAt as string) || now;
      const publishedAt = (record.createdAt as string) || indexedAt || now;

      const meta = buildBlueskyMetadata(feedViewPost);

      return {
        id: crypto.randomUUID(),
        source_id: source.id,
        external_id: uri,
        title: null, // Bluesky posts have no title — body_excerpt is used directly
        body_excerpt: text,
        author: handle,
        url: postUrl(handle, uri),
        image_url: firstImageThumb(meta),
        published_at: new Date(publishedAt).toISOString(),
        fetched_at: now,
        metadata: JSON.stringify(meta),
      };
    })
    .filter((row) => row.url && row.external_id);

  insertMany(rows);
  updateSource.run({ last_fetched_at: now, id: source.id });

  console.log(`[bluesky] ${source.name}: inserted ${insertedCount} new posts`);
  return insertedCount;
}
