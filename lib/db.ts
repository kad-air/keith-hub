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

    -- Setlist: uploaded guitar chord charts displayed as clean mono text with
    -- a configurable-speed autoscroll viewer. content is the raw chart text,
    -- preserved verbatim (chord-over-lyric alignment matters). sort_order is
    -- the performance order, rewritten on reorder. See lib/charts.ts.
    CREATE TABLE IF NOT EXISTS charts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_charts_sort ON charts(sort_order);

    -- Setlists: named, ordered collections that REFERENCE library charts
    -- (many-to-many via setlist_charts). The flat charts table is the full
    -- Charts library; a setlist is just a curated subset + performance order.
    -- offline is the per-setlist opt-in for SW cache warming (see app/sw.ts
    -- and the Charts client). See lib/setlists.ts.
    CREATE TABLE IF NOT EXISTS setlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      offline INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Membership + per-setlist order. ON DELETE CASCADE (foreign_keys is ON)
    -- means deleting a library chart drops it from every setlist, and deleting
    -- a setlist drops its membership rows — no orphan rows either way.
    CREATE TABLE IF NOT EXISTS setlist_charts (
      setlist_id TEXT NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
      chart_id   TEXT NOT NULL REFERENCES charts(id)   ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (setlist_id, chart_id)
    );
    CREATE INDEX IF NOT EXISTS idx_setlist_charts ON setlist_charts(setlist_id, sort_order);

    -- ── Hoops ───────────────────────────────────────────────────────────────
    -- The NBA simulation section. Follows the comic_state precedent: its own
    -- tables, entirely outside items/item_state, entirely outside the poller.
    --
    -- Two families, and the split is load-bearing:
    --
    --   READ-MODEL (hoops_params/teams/players/schedule/results/lines) —
    --   projected from the committed hoops-sim export in hoops-data/*.json.
    --   REWRITTEN WHOLESALE on import, like the sources table. Not edited in-app.
    --
    --   USER (hoops_scratch, hoops_runs) — roster experiments and saved sims.
    --   🔴 These NEVER sync back to git or to hoops-sim. A roster edit made on
    --   the phone must not reach hoops-sim's data/roster_edits.json, which
    --   drives the CLI — that is a two-writers-one-file bug that is very hard
    --   to see afterwards. One direction only: Mini → hub. The importer
    --   truncates only the read-model tables; see lib/hoops/import.ts.

    -- Singleton (id = 1). The fitted parameter blob, stored verbatim.
    CREATE TABLE IF NOT EXISTS hoops_params (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      param_version TEXT NOT NULL,
      blob TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );

    -- Wide, not long: one row per team with all three rating modes as
    -- columns, so tri stays a real primary key and the mode is chosen at
    -- query time rather than filtered for on every read.
    CREATE TABLE IF NOT EXISTS hoops_teams (
      tri TEXT PRIMARY KEY,
      conference TEXT NOT NULL,
      division TEXT NOT NULL,
      results_off REAL NOT NULL,
      results_def REAL NOT NULL,
      roster_off REAL NOT NULL,
      roster_def REAL NOT NULL,
      blend_off REAL NOT NULL,
      blend_def REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hoops_players (
      athlete_id INTEGER PRIMARY KEY,
      nba_player_id INTEGER,
      tri TEXT NOT NULL,
      name TEXT NOT NULL,
      minutes REAL NOT NULL,
      value_per36 REAL,
      game_rates TEXT,
      per36 TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hoops_players_team ON hoops_players(tri, minutes DESC);

    CREATE TABLE IF NOT EXISTS hoops_schedule (
      game_id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      neutral_site INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_hoops_schedule_date ON hoops_schedule(date);

    CREATE TABLE IF NOT EXISTS hoops_results (
      game_id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL,
      neutral_site INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_hoops_results_date ON hoops_results(date DESC);

    -- LINES ONLY. No score columns, deliberately: the line provider's own
    -- scores disagree with the truth on 3/1315 games, so real finals live
    -- exclusively in hoops_results. Don't add score columns here.
    CREATE TABLE IF NOT EXISTS hoops_lines (
      game_id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      home_spread REAL,
      total REAL,
      home_odds REAL,
      away_odds REAL,
      n_books_spread INTEGER,
      n_books_total INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hoops_lines_date ON hoops_lines(date);

    -- USER tables. Never truncated by the importer, never exported.
    CREATE TABLE IF NOT EXISTS hoops_scratch (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      edits TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hoops_runs (
      run_id TEXT PRIMARY KEY,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      neutral_site INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL,
      edits TEXT,
      result TEXT NOT NULL,
      saved_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hoops_runs_saved ON hoops_runs(saved_at DESC);
  `);

  // Additive migrations — CREATE IF NOT EXISTS above never alters existing
  // tables, so new columns get bolted on here, guarded by a PRAGMA check.
  const sourceCols = (
    dbInstance.prepare(`PRAGMA table_info(sources)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!sourceCols.includes("last_error")) {
    // Last fetch failure message; NULL = last fetch succeeded. Read by the
    // Tune sources roster for the per-source health indicator.
    dbInstance.exec(`ALTER TABLE sources ADD COLUMN last_error TEXT`);
  }

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
