import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "the-feed.db");
  dbInstance = new Database(dbPath);

  // Enable WAL mode for better performance
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");

  // Initialize schema
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      last_fetched_at TEXT,
      last_item_id TEXT
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id),
      external_id TEXT,
      title TEXT,
      body_excerpt TEXT,
      author TEXT,
      url TEXT NOT NULL,
      image_url TEXT,
      published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      metadata TEXT,
      UNIQUE(source_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS item_state (
      item_id TEXT PRIMARY KEY REFERENCES items(id),
      read_at TEXT,
      saved_at TEXT,
      consumed_at TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_state_saved ON item_state(saved_at) WHERE saved_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_state_consumed ON item_state(consumed_at) WHERE consumed_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comic_state (
      issue_id TEXT PRIMARY KEY,
      read_at TEXT NOT NULL
    );

    -- Practice section: one row per "thing you've completed". item_id is a
    -- composite key like "day:01" or "lick:am-pent-bb-style-box1-opener".
    -- Streak is derived by scanning day:* rows; learned-lick count is a
    -- SELECT over lick:* rows. No separate sessions table in v1.
    CREATE TABLE IF NOT EXISTS practice_progress (
      item_id TEXT PRIMARY KEY,
      done_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_practice_progress_done_at ON practice_progress(done_at);
  `);

  return dbInstance;
}

// Ranked sort for the "All" feed.
//
// Score = weight / (age_hours + C)
//
// Hyperbolic decay — same family as Hacker News. Score falls continuously
// as items age, so nothing is artificially frozen at a rank. Two items of
// equal age rank purely by weight; two items of equal weight rank purely
// by recency. C=2 flattens the curve in the first two hours so a podcast
// published 10 minutes ago doesn't bury a review published 90 minutes ago.
//
// Weights are relative — only the ratios matter:
//   podcasts (8) vs bluesky (1) = an 8h-old episode beats a brand-new post
//   music/film (6) vs reading (3) = reviews surface above general articles
//
// To tune: adjust the weight values below. C rarely needs changing.

const WEIGHTS = {
  podcasts:    8,
  music:       6,
  books:       6,
  film:        6,
  tech_review: 6,
  reading:     3,
  bluesky:     1,
} as const;

const C = 2; // hours — decay curve flattening constant

export const RANKED_ORDER = `
  (CASE s.category
    WHEN 'podcasts' THEN ${WEIGHTS.podcasts}.0
    WHEN 'music'    THEN ${WEIGHTS.music}.0
    WHEN 'books'    THEN ${WEIGHTS.books}.0
    WHEN 'film'        THEN ${WEIGHTS.film}.0
    WHEN 'tech_review' THEN ${WEIGHTS.tech_review}.0
    WHEN 'reading'     THEN ${WEIGHTS.reading}.0
    WHEN 'bluesky'     THEN ${WEIGHTS.bluesky}.0
    ELSE             ${WEIGHTS.reading}.0
  END) / ((julianday('now') - julianday(i.published_at)) * 24.0 + ${C}.0) DESC
`;
