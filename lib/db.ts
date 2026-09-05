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

    -- Tombstones for silently-dismissed items whose rows retention has
    -- hard-deleted (pruneExpiredUnread in lib/queries.ts). A feed that still
    -- carries the item — the Verge reviews feed runs ~24 days deep, podcast
    -- feeds carry every episode ever — would otherwise re-insert it as a
    -- brand-new unread row on the very next crawl: "the articles I dismissed
    -- keep coming back". Keyed the way the fetchers upsert. The fetchers skip
    -- anything present here; rows leave with their source when a source is
    -- removed from config. The cross-source dedup in lib/fetcher.ts uses the
    -- same table so a folded copy isn't re-inserted (and re-counted as "new")
    -- on every crawl either.
    CREATE TABLE IF NOT EXISTS dismissed_keys (
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      dismissed_at TEXT NOT NULL,
      -- 'dismissed': retention deleted a silently-dismissed row.
      -- 'folded': the cross-source dedup deleted this copy in favour of the
      --           same piece under another source (a Verge review's full-feed
      --           twin, a Vergecast episode's article twin). Only 'dismissed'
      --           tombstones carry the user's verdict onto a later copy.
      reason TEXT NOT NULL DEFAULT 'dismissed',
      PRIMARY KEY (source_id, external_id)
    );

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

    -- The Discworld reading-order map (/books/discworld) — the reader's OWN
    -- marks, and nothing else. Follows the comic_state precedent: the catalog
    -- is static (lib/books/discworld.ts), the DB holds only state.
    --
    -- 🔴 This table is an OVERRIDE, not the map's state. Every node's status is
    -- derived fresh from the library + the kosync log on each render; a row
    -- here exists only where the reader has said something the sync cannot
    -- know. That is why there is no "unread" status and no row per node: the
    -- absence of a row IS "ask the sync", so clearing a mark is a DELETE and
    -- can never leave a stale verdict behind.
    --
    -- 🔴 It must never be written by the sync path. reading_events already
    -- records what the devices report; if putProgress also stamped rows here,
    -- a re-read that dipped below the finish threshold would erase a mark the
    -- reader made by hand. check:books:discworld pins the manual-wins rule.
    CREATE TABLE IF NOT EXISTS discworld_state (
      node_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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

    -- ── Books ───────────────────────────────────────────────────────────────
    -- The EPUB library + KOReader sync server (BOOKS_PLAN.md). Replaces the
    -- Stump deployment on the Mac Mini. Files live at data/books/<id>/ on the
    -- Railway volume; these rows are the catalog metadata.
    --
    -- 🔴 partial_md5 is the KOReader/kosync document key: a partial MD5 of the
    -- FILE BYTES (offsets 1024 << 2i, i = -1..10, 1024 bytes each), computed
    -- on-device by CrossPoint/Readest and independently at ingest here. It is
    -- content-addressed: the stored file must never be rewritten, and the
    -- download route must serve the bytes untouched, or every device silently
    -- stops matching. See lib/books/partialMd5.ts and check:books:bytes.
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      series TEXT,
      series_index REAL,
      language TEXT,
      description TEXT,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      partial_md5 TEXT NOT NULL,
      cover_name TEXT,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- One book = one file, everywhere (BOOKS_PLAN §4): the same bytes uploaded
    -- twice return the existing row instead of forking the progress hash.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_books_sha256 ON books(sha256);
    CREATE INDEX IF NOT EXISTS idx_books_partial_md5 ON books(partial_md5);

    -- kosync users. key_hash is sha256(md5(password)) — the WIRE value is the
    -- client-computed md5 (fixed by the KOReader protocol, do not "fix" it);
    -- only the at-rest storage is hardened. See lib/books/kosync.ts.
    CREATE TABLE IF NOT EXISTS kosync_users (
      username TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Reading positions, keyed by the client's document hash. Deliberately NOT
    -- a foreign key to books: a device may sync a document this library has
    -- never seen (a sideloaded file), and the server must accept it — this is
    -- a key-value store for positions, not a referential model. progress is an
    -- OPAQUE string (an EPUB x-pointer from CrossPoint/KOReader, richer with a
    -- char offset from Readest) — stored and returned untouched, never parsed.
    CREATE TABLE IF NOT EXISTS kosync_progress (
      username TEXT NOT NULL,
      document TEXT NOT NULL,
      progress TEXT NOT NULL,
      percentage REAL NOT NULL,
      device TEXT,
      device_id TEXT,
      timestamp INTEGER NOT NULL,
      PRIMARY KEY (username, document)
    );

    -- Append-only reading history — the ONLY source of reading statistics.
    --
    -- 🔴 It exists because kosync_progress cannot answer a single historical
    -- question: it is one UPSERTED row per document, so every sync destroys
    -- the position it replaces. Where you were is all it has ever known; when
    -- you read is not recoverable from it, at any later date. This table is
    -- written alongside that upsert and never rewritten.
    --
    -- 🔴 It is DECORATION, and the write is wrapped accordingly (see
    -- putProgress in lib/books/kosync.ts): a failure here must never fail a
    -- sync. Losing a statistic costs a number on a page; failing the PUT costs
    -- the reading position on the device, which is the entire point of the
    -- Books section. check:books:stats asserts the PUT still succeeds with
    -- this table dropped out from under it.
    --
    -- kind distinguishes the two rows that look identical but mean opposite
    -- things:
    --   'baseline' — the FIRST sync ever seen for a document. Its delta is
    --                forced to 0: the device is telling us where it already
    --                is, and crediting that as reading done today would book
    --                weeks of past reading (or the whole Stump-era history) to
    --                the afternoon this feature deployed.
    --   'read'     — a real move from a known previous position. delta is
    --                signed: negative means the reader went backwards
    --                (re-reading, or a second device that was behind).
    --
    -- No FK to books, for the same reason kosync_progress has none: sideloaded
    -- documents sync too, and the stats UI joins on books.partial_md5 when a
    -- catalog book happens to match.
    CREATE TABLE IF NOT EXISTS reading_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      document TEXT NOT NULL,
      kind TEXT NOT NULL,
      percentage REAL NOT NULL,
      delta REAL NOT NULL,
      device TEXT,
      device_id TEXT,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reading_events_ts ON reading_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_reading_events_doc
      ON reading_events(document, timestamp);

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
    --
    -- 🔴 import_source distinguishes a committed-bundle cold-start seed from a
    -- real Mac Mini push (kad-air/keith-hub#73 / kad-air/hoops-sim#24). Once a
    -- push lands, ensureHoopsImport() never lets the committed hoops-data/*.json
    -- overwrite it again on a later boot -- see lib/hoops/import.ts.
    CREATE TABLE IF NOT EXISTS hoops_params (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      param_version TEXT NOT NULL,
      blob TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      import_source TEXT NOT NULL DEFAULT 'seed',
      hca_pts REAL,
      replacement_per36 REAL,
      value_as_of TEXT,
      pricing_version INTEGER,
      features_json TEXT,
      constants_json TEXT,
      nightly_as_of TEXT,
      nightly_value_source TEXT,
      nightly_last_n_games INTEGER,
      nightly_priced INTEGER,
      -- How much the 30-team AVERAGE moved between the nightly reading and the
      -- season-typical one. A league-wide level, published apart from the
      -- per-player spread precisely so it is charged to nobody's name.
      nightly_league_typical_shift REAL
    );

    -- Wide, not long: one row per team with every rating mode as columns, so
    -- tri stays a real primary key and the mode is chosen at query time rather
    -- than filtered for on every read.
    --
    -- The nightly_* columns are the fourth mode ("who has actually been on the
    -- floor, last ten games") and are NULLABLE on purpose: an older bundle
    -- carries no nightly block, and all-NULL is what tells the UI not to offer
    -- the lens at all. A zero would read as "exactly average lately".
    CREATE TABLE IF NOT EXISTS hoops_teams (
      tri TEXT PRIMARY KEY,
      conference TEXT NOT NULL,
      division TEXT NOT NULL,
      results_off REAL NOT NULL,
      results_def REAL NOT NULL,
      roster_off REAL NOT NULL,
      roster_def REAL NOT NULL,
      blend_off REAL NOT NULL,
      blend_def REAL NOT NULL,
      nightly_off REAL,
      nightly_def REAL,
      nightly_results_w REAL,
      nightly_n_basis_games INTEGER,
      nightly_abstained INTEGER,
      -- WHAT MOVED: the men behind the nightly gap. Nullable for the same
      -- reason as the columns above, plus one of its own -- a team the read
      -- abstained on has nothing to explain, and an empty movers list would
      -- read on screen as "nobody moved" when the truth is "we never
      -- re-priced this team".
      nightly_movers_json TEXT,
      nightly_delta_pre_mix REAL,
      nightly_delta_post_mix REAL,
      nightly_n_movers_total INTEGER,
      nightly_movers_delta_sum REAL
    );

    -- value_off_per36/value_def_per36 are the genuine offence/defence split of
    -- value_per36. 🔴 They ADD to it (net = off + def) and a positive def is
    -- GOOD defence -- the OPPOSITE of hoops_teams above, where net = off - def
    -- and a positive def means points ALLOWED. See lib/hoops/playervalue.ts.
    CREATE TABLE IF NOT EXISTS hoops_players (
      athlete_id INTEGER PRIMARY KEY,
      nba_player_id INTEGER,
      tri TEXT NOT NULL,
      name TEXT NOT NULL,
      minutes REAL NOT NULL,
      value_per36 REAL,
      value_off_per36 REAL,
      value_def_per36 REAL,
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

  // books.word_count: the denominator that turns an opaque kosync percentage
  // into a number of pages. Extracted from the epub's own text at ingest (see
  // lib/books/epubText.ts) and backfilled lazily for books ingested before
  // this column existed.
  //
  // NULL = never attempted. 0 = attempted and the epub yielded no readable
  // text, which is stored deliberately so the backfill doesn't re-unzip a
  // broken file on every stats page load. Reading it never touches the file's
  // bytes — extraction is a read, and the byte-identity invariant is intact.
  const bookCols = (
    dbInstance.prepare(`PRAGMA table_info(books)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const addBookCol = (name: string, ddl: string): void => {
    if (!bookCols.includes(name)) dbInstance!.exec(`ALTER TABLE books ADD COLUMN ${ddl}`);
  };
  addBookCol("word_count", `word_count INTEGER`);

  // books.to_read: the "To Read" shelf, surfaced as its own OPDS feed.
  //
  // 🔴 This exists for the DEVICE, not the hub. The X3 has no search — the only
  // way to reach a specific book is to scroll the catalog, which stops being
  // viable as the library grows. A flag the reader sets here becomes a short,
  // guaranteed-to-be-near-the-top feed on the device.
  //
  // to_read_at orders that shelf most-recently-added first: the reason to flag
  // a book is "this is what I want next", so the newest decision belongs on top
  // where the device shows it without scrolling. NULL whenever to_read is 0.
  addBookCol("to_read", `to_read INTEGER NOT NULL DEFAULT 0`);
  addBookCol("to_read_at", `to_read_at TEXT`);

  // books.health_json: the file-health report rendered on /books/[id] — a
  // pure read over the stored bytes (lib/books/health.ts), cached here so the
  // detail page doesn't re-unzip the epub on every open. Computed at ingest
  // for new uploads, lazily on the next detail-page open for existing books
  // (the word_count backfill pattern). NULL = never checked. The JSON carries
  // its own `version`; a HEALTH_VERSION bump invalidates every cached report
  // so improved checks re-run instead of trusting a stale verdict forever.
  // Writing it never touches the file, its sha256 or its partial_md5 — same
  // guarantee as a metadata edit, asserted by check:books:health.
  addBookCol("health_json", `health_json TEXT`);

  // hoops_params: added for kad-air/keith-hub#73 (the Mac Mini push endpoint).
  // A pre-existing prod DB has hoops_params from before these columns existed
  // — CREATE TABLE IF NOT EXISTS above never alters it, so bolt them on here.
  const hoopsParamsCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const addHoopsParamsCol = (name: string, ddl: string): void => {
    if (!hoopsParamsCols.includes(name)) {
      dbInstance!.exec(`ALTER TABLE hoops_params ADD COLUMN ${ddl}`);
    }
  };
  addHoopsParamsCol("import_source", `import_source TEXT NOT NULL DEFAULT 'seed'`);
  addHoopsParamsCol("hca_pts", `hca_pts REAL`);
  addHoopsParamsCol("replacement_per36", `replacement_per36 REAL`);
  addHoopsParamsCol("value_as_of", `value_as_of TEXT`);
  addHoopsParamsCol("pricing_version", `pricing_version INTEGER`);
  addHoopsParamsCol("features_json", `features_json TEXT`);
  addHoopsParamsCol("constants_json", `constants_json TEXT`);

  // hoops_players: the offence/defence value split, added for /hoops/players.
  // The exporter has shipped these two fields all along — the importer used to
  // drop them on the floor — so a pre-existing DB has the table WITHOUT the
  // columns and CREATE TABLE IF NOT EXISTS above will never add them. Same
  // additive shape as hoops_params. Nullable on purpose: an older bundle
  // carries no split at all, and a no-history player has no value of any kind.
  const hoopsPlayerCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_players)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const col of ["value_off_per36", "value_def_per36"]) {
    if (!hoopsPlayerCols.includes(col)) {
      dbInstance.exec(`ALTER TABLE hoops_players ADD COLUMN ${col} REAL`);
    }
  }

  // stack_net_per36/stack_off_per36/stack_def_per36/expected_minutes/value_pg/
  // evidence: the promoted 7-season "stack" rating and its value/game inputs,
  // added the same way the flagship split was — additive, nullable, optional
  // on the wire. A pre-existing DB has the table without these columns and
  // CREATE TABLE IF NOT EXISTS above never adds them.
  const hoopsPlayerColsRefreshed = (
    dbInstance.prepare(`PRAGMA table_info(hoops_players)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const col of [
    "stack_net_per36 REAL",
    "stack_off_per36 REAL",
    "stack_def_per36 REAL",
    "expected_minutes REAL",
    "value_pg REAL",
    "evidence TEXT",
  ]) {
    const name = col.split(" ")[0];
    if (!hoopsPlayerColsRefreshed.includes(name)) {
      dbInstance.exec(`ALTER TABLE hoops_players ADD COLUMN ${col}`);
    }
  }

  // hoops_teams + hoops_params: NIGHTLY STRENGTH (hub-v2) — a fourth team
  // rating, "who has actually been on the floor, last ten games", plus the
  // provenance the page has to print alongside it. Additive and nullable in
  // exactly the same shape as the two migrations above, for the same reason: a
  // pre-existing prod DB has both tables from before these columns, and
  // CREATE TABLE IF NOT EXISTS never alters an existing table.
  //
  // 🔴 Every column here is NULL for a bundle without the nightly block, and
  // ALL-NULL is the signal that the nightly lens must not be offered at all —
  // never a zero, which would read on screen as "this team is exactly average
  // lately" when the truth is "we have no read".
  const hoopsTeamCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_teams)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const col of [
    "nightly_off REAL",
    "nightly_def REAL",
    "nightly_results_w REAL",
    "nightly_n_basis_games INTEGER",
    "nightly_abstained INTEGER",
  ]) {
    const name = col.split(" ")[0];
    if (!hoopsTeamCols.includes(name)) {
      dbInstance.exec(`ALTER TABLE hoops_teams ADD COLUMN ${col}`);
    }
  }

  const hoopsParamsNightlyCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const col of [
    "nightly_as_of TEXT",
    "nightly_value_source TEXT",
    "nightly_last_n_games INTEGER",
    "nightly_priced INTEGER",
  ]) {
    const name = col.split(" ")[0];
    if (!hoopsParamsNightlyCols.includes(name)) {
      dbInstance.exec(`ALTER TABLE hoops_params ADD COLUMN ${col}`);
    }
  }

  // THE EXPLAIN SIDECAR (the player page's "how we got here"): one JSON blob
  // per player with the ingredients of his stack rating, and one league-level
  // block on hoops_params. Additive and nullable, the same shape as every
  // migration above and for the same reason; the importer's no-op check
  // (hasExplain) forces the one rewrite that backfills an existing volume.
  const hoopsPlayerExplainCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_players)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!hoopsPlayerExplainCols.includes("explain_json")) {
    dbInstance.exec(`ALTER TABLE hoops_players ADD COLUMN explain_json TEXT`);
  }
  const hoopsParamsExplainCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!hoopsParamsExplainCols.includes("explain_model_json")) {
    dbInstance.exec(`ALTER TABLE hoops_params ADD COLUMN explain_model_json TEXT`);
  }

  // WHAT MOVED (the team page's "why is this team's nightly rating down?"):
  // the three biggest movers per team as one JSON blob, plus the four scalars
  // the sentence under them is built from, plus the league-wide level on
  // hoops_params. Additive and nullable, the same shape as every migration
  // above and for the same reason; the importer's no-op check (hasMovers)
  // forces the one rewrite that backfills an existing volume.
  const hoopsTeamMoverCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_teams)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const col of [
    "nightly_movers_json TEXT",
    "nightly_delta_pre_mix REAL",
    "nightly_delta_post_mix REAL",
    "nightly_n_movers_total INTEGER",
    "nightly_movers_delta_sum REAL",
  ]) {
    const name = col.split(" ")[0];
    if (!hoopsTeamMoverCols.includes(name)) {
      dbInstance.exec(`ALTER TABLE hoops_teams ADD COLUMN ${col}`);
    }
  }
  const hoopsParamsMoverCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!hoopsParamsMoverCols.includes("nightly_league_typical_shift")) {
    dbInstance.exec(`ALTER TABLE hoops_params ADD COLUMN nightly_league_typical_shift REAL`);
  }

  // REPLACEMENT-ZERO (issue #70 F5, owner decision 2026-09-03: "I would like
  // 0 to be replacement player"). Two more per-player display fields, same
  // additive/nullable shape as every migration above and for the same
  // reason: a pre-existing DB has hoops_players without these columns and
  // CREATE TABLE IF NOT EXISTS never alters an existing table. Display only —
  // pricing.ts keeps reading the unchanged value_per36/replacement_per36
  // pair; the importer's no-op check (hasAboveReplacement) forces the one
  // rewrite that backfills an existing volume.
  const hoopsPlayerReplacementCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_players)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const col of ["value_per36_above_replacement REAL", "value_per_game_above_replacement REAL"]) {
    const name = col.split(" ")[0];
    if (!hoopsPlayerReplacementCols.includes(name)) {
      dbInstance.exec(`ALTER TABLE hoops_players ADD COLUMN ${col}`);
    }
  }

  // REPLACEMENT-ZERO ROUND 2 (issue #70 F5, owner decision 2026-09-04: "one
  // scale on every player surface" — a replacement-level player must read
  // 0.00 everywhere a player's LEVEL is shown, off/def included, not just the
  // two headline fields above). The bundle-level off/def LEAN of a
  // replacement player, needed to split `replacement_per36` the same way any
  // other player's net splits into off/def (`lib/hoops/playervalue.ts`'s
  // `replacementLevelsOf`). Same additive shape; the importer's no-op check
  // (hasReplacementTilt) forces the one rewrite that backfills an existing
  // volume, separately from hasScalars — an already-settled pre-existing
  // volume (hca_pts already non-null) would otherwise never learn this column
  // exists at all.
  const hoopsParamsTiltCols = (
    dbInstance.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!hoopsParamsTiltCols.includes("replacement_tilt_per36")) {
    dbInstance.exec(`ALTER TABLE hoops_params ADD COLUMN replacement_tilt_per36 REAL`);
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
