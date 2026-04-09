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
  `);

  return dbInstance;
}

// Ranked sort for the "All" feed.
// Reviews and podcasts get a time boost so they surface above social noise.
// Bluesky gets a penalty so it fills in gaps without dominating.
export const RANKED_ORDER = `
  CASE s.category
    WHEN 'podcasts' THEN datetime(i.published_at, '+8 hours')
    WHEN 'music'    THEN datetime(i.published_at, '+6 hours')
    WHEN 'film'     THEN datetime(i.published_at, '+6 hours')
    WHEN 'reading'  THEN i.published_at
    WHEN 'bluesky'  THEN datetime(i.published_at, '-12 hours')
    ELSE i.published_at
  END DESC
`;
