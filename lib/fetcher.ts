import Parser from "rss-parser";
import type Database from "better-sqlite3";
import { getConfig, type SourceConfig } from "@/lib/config";
import { fetchBlueskySource } from "@/lib/bluesky";

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "TheFeed/0.1 (personal RSS reader)",
  },
});

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
  metadata: null;
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

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO items
      (id, source_id, external_id, title, body_excerpt, author, url, image_url, published_at, fetched_at, metadata)
    VALUES
      (@id, @source_id, @external_id, @title, @body_excerpt, @author, @url, @image_url, @published_at, @fetched_at, @metadata)
  `);

  const updateSource = db.prepare(`
    UPDATE sources SET last_fetched_at = @last_fetched_at WHERE id = @id
  `);

  const insertMany = db.transaction((rows: ItemRow[]) => {
    for (const row of rows) {
      const result = insertItem.run(row);
      if (result.changes > 0) insertedCount++;
    }
  });

  const itemsToInsert: ItemRow[] = (feed.items || []).map((item) => {
    const rawContent =
      item.content ||
      (item as Record<string, string>)["content:encoded"] ||
      item.summary ||
      "";
    const bodyExcerpt = stripHtml(rawContent);
    const externalId = item.guid || item.id || item.link || "";
    const imageUrl =
      item.enclosure?.url ||
      (item as Record<string, string>)["media:thumbnail"] ||
      null;

    return {
      id: crypto.randomUUID(),
      source_id: source.id,
      external_id: externalId,
      title: item.title || null,
      body_excerpt: bodyExcerpt || null,
      author: item.creator || item.author || null,
      url: item.link || source.url || "",
      image_url: imageUrl || null,
      published_at: toIsoString(item.pubDate || item.isoDate),
      fetched_at: now,
      metadata: null,
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

  const syncSources = db.transaction(() => {
    for (const source of config.sources) {
      upsertSource.run({
        id: source.id,
        name: source.name,
        type: source.type,
        category: source.category,
      });
    }
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
