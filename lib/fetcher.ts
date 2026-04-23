import Parser from "rss-parser";
import type Database from "better-sqlite3";
import { getConfig, invalidateConfig, type SourceConfig } from "@/lib/config";
import { fetchBlueskySource } from "@/lib/bluesky";
import { pruneExpiredUnread } from "@/lib/queries";

const RSS_FETCH_TIMEOUT_MS = 10_000;

const parser = new Parser();

// Sanitize bare & characters in XML that aren't part of valid entities.
// Some feeds (e.g. AllMusic) contain unescaped ampersands that cause strict
// XML parsers to reject the entire document.
function sanitizeXml(xml: string): string {
  return xml.replace(/&(?!(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z]\w*);)/g, "&amp;");
}

// ── Source-specific title rewriters ────────────────────────────────────────
//
// Pitchfork publishes album reviews whose <title> is the album name only.
// We rewrite to "Artist - Album" so the music feed reads cleanly. The
// rewriter returns null if it can't extract — leaves the original in place.

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

function toIsoString(date: string | Date | undefined): string {
  if (!date) return new Date().toISOString();
  try {
    return new Date(date).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// AllMusic's /rss/newreleases ships ONE item per week — a newsletter whose
// <description> is an HTML <ul> of editor's-pick album rows. We expand each
// <li> into its own ItemRow so the user gets one card per album. The
// per-<li> shape is reliably:
//
//   <li>
//     <a href=".../artist/...">Artist</a> - <a href=".../album/...">Album</a>
//     <br>
//     Editor's note about the album.
//   </li>
//
// A trailing meta <li> ("Here are our editors' picks for this week...") has
// no /album/ link and is skipped.
//
// external_id is namespaced as `newsletter#<albumUrl>#<weekDate>` for two
// reasons: (1) it can never collide with rows left over from the legacy
// /rss/all "Album of the Day" ingest, whose external_ids were the bare
// album URL; (2) if the same album appears in two consecutive newsletters,
// each becomes its own row so a previous dismiss doesn't suppress it.
function parseAllMusicNewsletter(
  newsletterItem: { content?: string; description?: string; pubDate?: string; isoDate?: string },
  fetchedAt: string,
): ItemRow[] {
  const html = newsletterItem.content || newsletterItem.description || "";
  if (!html) return [];

  const publishedAt = toIsoString(newsletterItem.pubDate || newsletterItem.isoDate);
  const weekDate = publishedAt.slice(0, 10);

  const rows: ItemRow[] = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  for (const match of Array.from(html.matchAll(liRegex))) {
    const li = match[1];
    const [heading, ...descParts] = li.split(/<br\s*\/?>/i);

    const artistMatch = heading.match(
      /<a[^>]+href="[^"]*\/artist\/[^"]+"[^>]*>([^<]+)<\/a>/i,
    );
    const albumMatch = heading.match(
      /<a[^>]+href="([^"]*\/album\/[^"]+)"[^>]*>([^<]+)<\/a>/i,
    );
    if (!artistMatch || !albumMatch) continue;

    const artist = decodeEntities(artistMatch[1].trim());
    const albumUrl = albumMatch[1];
    const album = decodeEntities(albumMatch[2].trim());
    const description = descParts.length
      ? decodeEntities(stripHtml(descParts.join(" "))).trim()
      : "";

    rows.push({
      id: crypto.randomUUID(),
      source_id: "allmusic",
      external_id: `newsletter#${albumUrl}#${weekDate}`,
      title: `${artist} - ${album}`,
      body_excerpt: description || null,
      author: null,
      url: albumUrl,
      image_url: null,
      published_at: publishedAt,
      fetched_at: fetchedAt,
      metadata: null,
    });
  }
  return rows;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS);
    let raw: string;
    try {
      const res = await fetch(source.url, {
        signal: controller.signal,
        headers: { "User-Agent": "TheFeed/0.1 (personal RSS reader)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      raw = await res.text();
    } finally {
      clearTimeout(timer);
    }
    feed = await parser.parseString(sanitizeXml(raw));
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Request timed out after ${RSS_FETCH_TIMEOUT_MS}ms`
          : err.message
        : String(err);
    console.error(`[fetcher] Failed to fetch ${source.name}:`, message);
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

  const itemsToInsert: ItemRow[] = (feed.items || []).flatMap((rawItem) => {
    // rss-parser's Item type fights us once we touch fields by name — every
    // standard field becomes typed too narrowly. Cast to any for ergonomic
    // access to both standard and custom fields, defended by the explicit
    // string|null on the row shape itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = rawItem as any;

    // AllMusic ships a single weekly newsletter item; expand it into one
    // row per editor's-pick album. See parseAllMusicNewsletter for the
    // shape and the external_id namespacing rationale.
    if (source.id === "allmusic") {
      return parseAllMusicNewsletter(item, now);
    }

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

    // Source-specific title rewrites for music album reviews. Pitchfork's
    // album review <title> is the album name only; we rewrite to "Artist -
    // Album" when the URL matches the album review pattern.
    const url: string = (item.link as string) || source.url || "";
    let title: string | null = (item.title as string) || null;
    if (title) title = decodeEntities(title);
    if (source.id === "pitchfork-reviews" && url.includes("/reviews/albums/") && title) {
      title = rewritePitchforkAlbumTitle(title, url) ?? title;
    }

    return [{
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
    }];
  });

  insertMany(itemsToInsert);

  updateSource.run({ last_fetched_at: now, id: source.id });

  console.log(
    `[fetcher] ${source.name}: inserted ${insertedCount} new items`
  );
  return insertedCount;
}

// Shared in-flight guard. The poller, visibility-change silent refresh, and
// manual refresh all ultimately call fetchAllSources; without this, they
// stack up as parallel crawls whose responses can land out of order and
// overwrite each other in the client. Instead, every caller now awaits
// the same in-flight promise — one real crawl at a time.
let fetchAllSourcesInFlight: Promise<number> | null = null;

export function fetchAllSources(db: Database.Database): Promise<number> {
  if (fetchAllSourcesInFlight) return fetchAllSourcesInFlight;
  fetchAllSourcesInFlight = fetchAllSourcesImpl(db).finally(() => {
    fetchAllSourcesInFlight = null;
  });
  return fetchAllSourcesInFlight;
}

async function fetchAllSourcesImpl(db: Database.Database): Promise<number> {
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

  // Verge dedup: articles that appear in both verge-full and verge-reviews
  // should only exist as tech_review (higher priority). Remove the verge-full
  // copy so the review version wins. Self-healing — runs every cycle.
  const hasVergeFull = config.sources.some((s) => s.id === "verge-full");
  const hasVergeReviews = config.sources.some((s) => s.id === "verge-reviews");
  if (hasVergeFull && hasVergeReviews) {
    const dedup = db.transaction(() => {
      const purgeState = db.prepare(`
        DELETE FROM item_state WHERE item_id IN (
          SELECT f.id FROM items f
          WHERE f.source_id = 'verge-full'
            AND f.url IN (SELECT r.url FROM items r WHERE r.source_id = 'verge-reviews')
        )
      `);
      const purgeItems = db.prepare(`
        DELETE FROM items
        WHERE source_id = 'verge-full'
          AND url IN (SELECT url FROM items WHERE source_id = 'verge-reviews')
      `);
      purgeState.run();
      const result = purgeItems.run();
      if (result.changes > 0) {
        console.log(
          `[fetcher] Verge dedup: removed ${result.changes} full-feed item(s) that also appear in reviews`
        );
      }
    });
    dedup();
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

  // Check tracker release dates and send push notifications (once per day).
  // Imported dynamically to avoid circular deps and keep the import lightweight.
  try {
    const { checkReleaseNotifications } = await import("@/lib/release-notify");
    await checkReleaseNotifications();
  } catch (err) {
    console.error("[fetcher] Release notification check failed:", err);
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
