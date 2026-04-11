import Parser from "rss-parser";
import type Database from "better-sqlite3";
import { getConfig, invalidateConfig, type SourceConfig } from "@/lib/config";
import { fetchBlueskySource } from "@/lib/bluesky";
import { pruneExpiredUnread } from "@/lib/queries";

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
    // Strip quotes/apostrophes BEFORE the alnum replace, otherwise they
    // become hyphens. Pitchfork drops them entirely: "Wak'a" → "waka",
    // not "wak-a". Covers ASCII and the common Unicode curly forms.
    .replace(/['"\u2018\u2019\u201C\u201D\u201A\u201E\u2032\u2035]/g, "")
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
// We slugify the title and look for it at the end of the URL slug, then
// derive the artist from what's before. Loses some characters (& → space,
// diacritics → ascii) but the result is recognizable.
//
// Pitchfork sometimes adds suffixes to the URL slug that aren't in the
// title (e.g. title "Wak'a" → URL .../los-thuthanaka-waka-ep/). And
// sometimes the title has a suffix that the URL doesn't. We try a handful
// of plausible album-slug variants and use the first one that matches.
function rewritePitchforkAlbumTitle(rawTitle: string, url: string): string | null {
  const slugMatch = url.match(/\/reviews\/albums\/([^/]+)\/?$/);
  if (!slugMatch) return null;
  const fullSlug = slugMatch[1];
  const baseSlug = slugify(rawTitle);
  if (!baseSlug) return null;

  // Suffixes Pitchfork sometimes adds to or strips from album slugs.
  const SUFFIXES = ["ep", "lp", "album", "deluxe", "edition", "mixtape"];

  const candidates = new Set<string>();
  candidates.add(baseSlug);
  for (const suf of SUFFIXES) {
    candidates.add(`${baseSlug}-${suf}`);
    if (baseSlug.endsWith(`-${suf}`)) {
      candidates.add(baseSlug.slice(0, -suf.length - 1));
    }
  }

  // Prefer the longest candidate that matches (so we don't accidentally
  // match a short word inside a longer artist slug).
  const matches = Array.from(candidates)
    .filter((c) => c.length > 0 && fullSlug.endsWith(c))
    .sort((a, b) => b.length - a.length);

  for (const candidate of matches) {
    const artistSlug = fullSlug
      .slice(0, fullSlug.length - candidate.length)
      .replace(/-+$/, "");
    if (artistSlug) {
      return `${deslugify(artistSlug)} - ${rawTitle}`;
    }
  }

  return null;
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

// Single-pass HTML entity decoder. Handles numeric (&#39;, &#x27;) and the
// named entities that actually show up in RSS feeds. Some sources (notably
// The Verge) XML-escape apostrophes inside <title> as &#8217; — rss-parser
// hands those through verbatim, so we decode here. Single-pass means
// `&amp;lt;` correctly stays `&lt;` instead of cascading to `<`.
function decodeEntities(text: string): string {
  if (!text) return text;
  return text.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g,
    (match, hex, dec, name) => {
      if (hex !== undefined) {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (dec !== undefined) {
        const code = parseInt(dec, 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      switch (name) {
        case "amp":  return "&";
        case "lt":   return "<";
        case "gt":   return ">";
        case "quot": return '"';
        case "apos": return "'";
        case "nbsp": return " ";
        default:     return match;
      }
    }
  );
}

// ── Per-source item filters ─────────────────────────────────────────────────
//
// Some feeds publish a mix of content types and we only want one kind. This
// is a per-source allow-list keyed by source.id, parallel to the title
// rewriters above. Sources without an entry pass everything through.
//
// We apply the filter in two places:
//   1. At ingest (the .filter() in the map step) so new fetches drop items.
//   2. As a SQL cleanup right after the upsert so existing rows that pre-date
//      the filter get pruned. The cleanup is self-healing on every poll.

function shouldKeepRssItem(sourceId: string, url: string): boolean {
  if (sourceId === "allmusic") {
    // AllMusic publishes album reviews, blog posts, interviews, and a weekly
    // newsletter all in the same feed. Album review URLs contain /album/.
    return url.includes("/album/");
  }
  return true;
}

// Returns the SQL WHERE clause (without "WHERE") that matches items to
// REMOVE for this source, or null if no cleanup is needed. Must stay in
// sync with shouldKeepRssItem.
function rssCleanupWhereClause(sourceId: string): string | null {
  if (sourceId === "allmusic") {
    return "url NOT LIKE '%/album/%'";
  }
  return null;
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
    const bodyExcerpt = decodeEntities(stripHtml(rawContent));
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
    if (title) title = decodeEntities(title);
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
  })
  // Drop items that don't pass the per-source allow-list (e.g. AllMusic
  // blog posts / newsletters in the album-reviews-only feed).
  .filter((row) => shouldKeepRssItem(source.id, row.url));

  insertMany(itemsToInsert);

  // Self-healing cleanup: prune existing rows that pre-date the per-source
  // filter. Runs every poll cycle. Cheap (indexed scan + small N), idempotent.
  // Must delete from item_state first because of the FK with no CASCADE.
  const cleanupWhere = rssCleanupWhereClause(source.id);
  if (cleanupWhere) {
    const purgeState = db.prepare(
      `DELETE FROM item_state WHERE item_id IN (
         SELECT id FROM items WHERE source_id = ? AND ${cleanupWhere}
       )`
    );
    const purgeItems = db.prepare(
      `DELETE FROM items WHERE source_id = ? AND ${cleanupWhere}`
    );
    const purge = db.transaction(() => {
      purgeState.run(source.id);
      const result = purgeItems.run(source.id);
      if (result.changes > 0) {
        console.log(
          `[fetcher] ${source.name}: pruned ${result.changes} item(s) outside the source filter`
        );
      }
    });
    purge();
  }

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

  // Enforce per-category unread caps. Runs at the END of every poll cycle
  // so newly fetched items get a chance to compete for the top slots before
  // older ones get pruned. consumed_at is never set by the prune, so /read
  // history is unaffected.
  const pruned = pruneExpiredUnread(db);
  if (pruned > 0) {
    console.log(`[fetcher] pruned ${pruned} item(s) over per-category unread cap`);
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
