import Parser from "rss-parser";
import type Database from "better-sqlite3";
import { getConfig, invalidateConfig, type SourceConfig } from "@/lib/config";
import { fetchBlueskySource } from "@/lib/bluesky";

// Custom fields expose media:* elements that AllMusic uses to carry the
// artist and album cleanly. media:credit appears multiple times per item
// (one with role="musician" for the artist, one for the publisher), so we
// keep it as an array and filter by role at use site.
const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "TheFeed/0.1 (personal RSS reader)",
  },
  customFields: {
    item: [
      ["media:credit", "mediaCredit", { keepArray: true }],
      ["media:title", "mediaTitle"],
    ],
  },
});

// ── Source-specific title rewriters ────────────────────────────────────────
//
// AllMusic and Pitchfork both publish album reviews where the user-facing
// title is the album name only (or worse). We rewrite those titles to
// "Artist - Album" so the music feed reads cleanly. The rewriters return
// null if they can't extract — leaves the original title in place.

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deslugify(slug: string): string {
  // "the-new-pornographers" → "The New Pornographers". Naive title-case is
  // good enough — common articles like "the", "of" etc. still get
  // capitalized but that's fine for a personal feed.
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Pitchfork: title is the album name, URL slug is "{artist-slug}-{album-slug}".
// Slugify the title, find it as a suffix in the URL slug, derive artist from
// what's before. Loses some characters (& → space, diacritics → ascii) but
// the result is recognizable.
function rewritePitchforkAlbumTitle(rawTitle: string, url: string): string | null {
  const slugMatch = url.match(/\/reviews\/albums\/([^/]+)\/?$/);
  if (!slugMatch) return null;
  const fullSlug = slugMatch[1];
  const albumSlug = slugify(rawTitle);
  if (!albumSlug || !fullSlug.endsWith(albumSlug)) return null;
  const artistSlug = fullSlug.slice(0, fullSlug.length - albumSlug.length).replace(/-+$/, "");
  if (!artistSlug) return null;
  const artist = deslugify(artistSlug);
  return `${artist} - ${rawTitle}`;
}

// AllMusic album review items carry the artist as <media:credit role="musician">
// and the album as <media:title>. The <title> element wraps the artist in an
// <a> tag, which rss-parser strips, leaving us with just " - {album}" — useless.
// rss-parser exposes media:credit with attributes under .$ when keepArray:true
// and the element has children. Defensively handle string|object shapes.
type RawCredit = string | { _?: string; $?: { role?: string } };

function rewriteAllMusicAlbumTitle(rawCredits: RawCredit[] | undefined, mediaTitle: string | undefined): string | null {
  if (!rawCredits || !mediaTitle) return null;
  const musicianCredit = rawCredits.find((c) => {
    if (typeof c === "string") return false;
    return c.$?.role === "musician";
  });
  if (!musicianCredit || typeof musicianCredit === "string") return null;
  const artist = musicianCredit._?.trim();
  if (!artist) return null;
  return `${artist} - ${mediaTitle.trim()}`;
}

interface ItemRow {
  id: string;
  source_id: string;
  external_id: string;
  title: string | null;
  body_excerpt: string | null;
  author: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
  fetched_at: string;
  metadata: string | null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim().slice(0, 300);
}

function toIsoString(date: string | Date | undefined): string {
  if (!date) return new Date().toISOString();
  try {
    return new Date(date).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export async function fetchRssSource(
  source: SourceConfig,
  db: Database.Database
): Promise<number> {
  if (!source.url) {
    console.error(`[fetcher] Source ${source.id} has no URL, skipping`);
    return 0;
  }

  console.log(`[fetcher] Fetching ${source.name} (${source.url})`);

  let feed;
  try {
    feed = await parser.parseURL(source.url);
  } catch (err) {
    console.error(
      `[fetcher] Failed to fetch ${source.name}:`,
      err instanceof Error ? err.message : err
    );
    return 0;
  }

  const now = new Date().toISOString();
  let insertedCount = 0;

  // ON CONFLICT DO UPDATE on the content fields (mirrors the bluesky fetcher
  // pattern) so a code change to a title rewriter or extractor backfills
  // existing rows on the next poll instead of only affecting brand-new items.
  // Per-item state lives in item_state and is untouched by an items upsert.
  const insertItem = db.prepare(`
    INSERT INTO items
      (id, source_id, external_id, title, body_excerpt, author, url, image_url, published_at, fetched_at, metadata)
    VALUES
      (@id, @source_id, @external_id, @title, @body_excerpt, @author, @url, @image_url, @published_at, @fetched_at, @metadata)
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      title = excluded.title,
      body_excerpt = excluded.body_excerpt,
      image_url = excluded.image_url,
      metadata = excluded.metadata
  `);

  const updateSource = db.prepare(`
    UPDATE sources SET last_fetched_at = @last_fetched_at WHERE id = @id
  `);

  // Pre-check existence so we can count NEW posts accurately. With ON
  // CONFLICT DO UPDATE, statement.changes returns 1 for both inserts and
  // updates and there's no way to tell them apart from the result alone.
  const existsStmt = db.prepare(
    "SELECT 1 FROM items WHERE source_id = ? AND external_id = ?"
  );
  const insertMany = db.transaction((rows: ItemRow[]) => {
    for (const row of rows) {
      const exists = existsStmt.get(row.source_id, row.external_id);
      insertItem.run(row);
      if (!exists) insertedCount++;
    }
  });

  const isPodcast = source.type === "podcast";
  // Feed-level artwork: rss-parser exposes itunes namespace under feed.itunes
  const feedItunes = (feed as Record<string, unknown>).itunes as Record<string, unknown> | undefined;
  const feedArtworkUrl = (feedItunes?.image as string) || null;

  const itemsToInsert: ItemRow[] = (feed.items || []).map((rawItem) => {
    // rss-parser's Item type fights us once customFields are added — every
    // standard field becomes typed too narrowly. Cast to any for ergonomic
    // access to both standard and custom fields, defended by the explicit
    // string|null on the row shape itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = rawItem as any;
    const ext = item;
    const itunes = (ext.itunes as Record<string, unknown>) || {};

    const rawContent =
      item.content ||
      (ext["content:encoded"] as string) ||
      item.summary ||
      (itunes.summary as string) ||
      "";
    const bodyExcerpt = stripHtml(rawContent);
    const externalId = String(item.guid || item.id || item.link || "");

    // Podcast image: item itunes.image > feed itunes.image (no enclosure fallback — that's audio)
    const imageUrl = (itunes.image as string) || feedArtworkUrl || null;

    // Audio URL
    const audioUrl =
      item.enclosure?.type?.startsWith("audio") ? item.enclosure.url : null;

    const metadata = isPodcast
      ? JSON.stringify({
          show_name: feed.title || source.name,
          duration: (itunes.duration as string) || null,
          audio_url: audioUrl,
          artwork_url: imageUrl,
          apple_id: source.apple_id || null,
        })
      : null;

    // Source-specific title rewrites for music album reviews. Both Pitchfork
    // and AllMusic publish review titles that are missing or mangled — see
    // the helpers above. We only rewrite when the URL matches the album
    // review pattern so blog posts / interviews / newsletters keep their
    // normal titles.
    const url: string = (item.link as string) || source.url || "";
    let title: string | null = (item.title as string) || null;
    if (source.id === "pitchfork-reviews" && url.includes("/reviews/albums/") && title) {
      title = rewritePitchforkAlbumTitle(title, url) ?? title;
    } else if (source.id === "allmusic" && url.includes("/album/")) {
      const rewritten = rewriteAllMusicAlbumTitle(
        ext.mediaCredit as RawCredit[] | undefined,
        ext.mediaTitle as string | undefined,
      );
      if (rewritten) title = rewritten;
    }

    return {
      id: crypto.randomUUID(),
      source_id: source.id,
      external_id: externalId,
      title,
      body_excerpt: bodyExcerpt || null,
      author: (item.creator || item.author || null) as string | null,
      url,
      image_url: imageUrl,
      published_at: toIsoString(item.pubDate || item.isoDate),
      fetched_at: now,
      metadata,
    };
  });

  insertMany(itemsToInsert);

  updateSource.run({ last_fetched_at: now, id: source.id });

  console.log(
    `[fetcher] ${source.name}: inserted ${insertedCount} new items`
  );
  return insertedCount;
}

export async function fetchAllSources(db: Database.Database): Promise<number> {
  invalidateConfig(); // Re-read feeds.yml on every poll cycle
  const config = getConfig();

  // Sync sources table with config
  const upsertSource = db.prepare(`
    INSERT INTO sources (id, name, type, category)
    VALUES (@id, @name, @type, @category)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      category = excluded.category
  `);

  const configIds = config.sources.map((s) => s.id);
  const placeholders = configIds.map(() => "?").join(",");

  const syncSources = db.transaction(() => {
    // Upsert sources from config
    for (const source of config.sources) {
      upsertSource.run({
        id: source.id,
        name: source.name,
        type: source.type,
        category: source.category,
      });
    }
    // Remove sources (and their items) no longer in config
    db.prepare(`DELETE FROM item_state WHERE item_id IN (SELECT id FROM items WHERE source_id NOT IN (${placeholders}))`).run(...configIds);
    db.prepare(`DELETE FROM items WHERE source_id NOT IN (${placeholders})`).run(...configIds);
    db.prepare(`DELETE FROM sources WHERE id NOT IN (${placeholders})`).run(...configIds);
  });

  syncSources();

  let totalFetched = 0;

  const rssSources = config.sources.filter(
    (s) => s.type === "rss" || s.type === "podcast"
  );
  for (const source of rssSources) {
    const count = await fetchRssSource(source, db);
    totalFetched += count;
  }

  const blueskySources = config.sources.filter((s) => s.type === "bluesky");
  for (const source of blueskySources) {
    const count = await fetchBlueskySource(source, db);
    totalFetched += count;
  }

  return totalFetched;
}

let pollingInterval: ReturnType<typeof setInterval> | null = null;

export function startPolling(db: Database.Database): void {
  const config = getConfig();
  const intervalMs = (config.app.poll_interval_minutes || 15) * 60 * 1000;

  // Fetch immediately on start
  fetchAllSources(db).catch((err) => {
    console.error("[fetcher] Initial fetch failed:", err);
  });

  // Then poll on interval
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }

  pollingInterval = setInterval(() => {
    fetchAllSources(db).catch((err) => {
      console.error("[fetcher] Poll fetch failed:", err);
    });
  }, intervalMs);

  console.log(
    `[fetcher] Polling started — interval: ${config.app.poll_interval_minutes} minutes`
  );
}
