// The projection's SQLite edge: one writer, one reader, both taking the DB
// handle as a parameter so the build gate can drive the REAL pair over a
// throwaway database (the nightly gate's pattern) — a check that re-states
// the INSERT would only ever verify itself.
//
// 🔴 `writeProjection` is called from INSIDE `writeBundle`'s transaction
// (lib/hoops/import.ts), never on its own in production, so a projection
// can't land without the bundle it came with. It does not open a transaction
// of its own for that reason; the gate wraps it in one.

import type Database from "better-sqlite3";
import type {
  ProjectionSource,
  RawProjectionHistoryFile,
  RawProjectionsFile,
  RawProjectionTeam,
} from "./types";
import type { TrendPoint } from "./projectionHistory.ts";

export interface ProjectionMeta {
  seasonStartYear: number;
  asOfDate: string;
  generatedAt: string;
  receivedAt: string;
  replicates: number;
  method: string;
}

export interface Projection {
  meta: ProjectionMeta;
  teams: RawProjectionTeam[];
}

const TEAM_COLS = [
  "tri",
  "conference",
  "wins",
  "losses",
  "proj_wins",
  "proj_losses",
  "wins_p10",
  "wins_p90",
  "playoff_pct",
  "playin_pct",
  "top6_pct",
  "conf_finals_pct",
  "finals_pct",
  "title_pct",
] as const;

/** Replace whatever projection is stored with this one. Caller holds the transaction. */
export function writeProjection(db: Database.Database, file: RawProjectionsFile, receivedAt: string): void {
  db.exec(`DELETE FROM hoops_projections; DELETE FROM hoops_projection_meta;`);
  db.prepare(
    `INSERT INTO hoops_projection_meta
       (id, season_start_year, as_of_date, generated_at, received_at, replicates, method)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
  ).run(file.season_start_year, file.as_of_date, file.generated_at, receivedAt, file.replicates, file.method);
  const ins = db.prepare(
    `INSERT INTO hoops_projections (${TEAM_COLS.join(", ")})
     VALUES (${TEAM_COLS.map(() => "?").join(", ")})`,
  );
  for (const t of file.teams) {
    ins.run(
      t.team,
      t.conference,
      t.wins,
      t.losses,
      t.proj_wins,
      t.proj_losses,
      t.wins_p10,
      t.wins_p90,
      t.playoff_pct,
      t.playin_pct,
      t.top6_pct,
      t.conf_finals_pct,
      t.finals_pct,
      t.title_pct,
    );
  }
}

/** The stored projection, or null when none has ever been received. */
export function readProjection(db: Database.Database): Projection | null {
  const m = db
    .prepare(
      `SELECT season_start_year, as_of_date, generated_at, received_at, replicates, method
         FROM hoops_projection_meta WHERE id = 1`,
    )
    .get() as
    | {
        season_start_year: number;
        as_of_date: string;
        generated_at: string;
        received_at: string;
        replicates: number;
        method: string;
      }
    | undefined;
  if (!m) return null;
  const rows = db.prepare(`SELECT ${TEAM_COLS.join(", ")} FROM hoops_projections ORDER BY tri`).all() as Array<
    Omit<RawProjectionTeam, "team"> & { tri: string }
  >;
  return {
    meta: {
      seasonStartYear: m.season_start_year,
      asOfDate: m.as_of_date,
      generatedAt: m.generated_at,
      receivedAt: m.received_at,
      replicates: m.replicates,
      method: m.method,
    },
    teams: rows.map(({ tri, ...rest }) => ({ team: tri, ...rest })),
  };
}

/** The stored projection's generated_at, for the importer's "unchanged" rule. */
export function storedProjectionGeneratedAt(db: Database.Database): string | null {
  const m = db.prepare(`SELECT generated_at FROM hoops_projection_meta WHERE id = 1`).get() as
    | { generated_at: string }
    | undefined;
  return m?.generated_at ?? null;
}

// ---------------------------------------------------------------------------
// The projection's season (hoops_projection_history). Same rule as above:
// the caller holds the transaction (writeBundle's, in production).
// ---------------------------------------------------------------------------

const HISTORY_TEAM_COLS = TEAM_COLS.filter((c) => c !== "tri");

function insertSnapshotRows(
  db: Database.Database,
  season: number,
  date: string,
  source: ProjectionSource,
  replicates: number,
  generatedAt: string,
  receivedAt: string,
  teams: readonly RawProjectionTeam[],
): void {
  const cols = ["season_start_year", "as_of_date", "tri", "source", "replicates", "generated_at", "received_at", ...HISTORY_TEAM_COLS];
  const ins = db.prepare(
    `INSERT OR REPLACE INTO hoops_projection_history (${cols.join(", ")})
     VALUES (${cols.map(() => "?").join(", ")})`,
  );
  for (const t of teams) {
    ins.run(
      season,
      date,
      t.team,
      source,
      replicates,
      generatedAt,
      receivedAt,
      ...HISTORY_TEAM_COLS.map((c) => t[c as keyof RawProjectionTeam]),
    );
  }
}

/** Record one pushed projections.json as that night's point (source 'nightly'),
 *  replacing whatever that night held. */
export function recordProjectionNight(db: Database.Database, file: RawProjectionsFile, receivedAt: string): void {
  db.prepare(`DELETE FROM hoops_projection_history WHERE season_start_year = ? AND as_of_date = ?`).run(
    file.season_start_year,
    file.as_of_date,
  );
  insertSnapshotRows(db, file.season_start_year, file.as_of_date, "nightly", file.replicates, file.generated_at, receivedAt, file.teams);
}

/** Replace the season's whole history with the sender's archive. */
export function replaceProjectionHistory(db: Database.Database, file: RawProjectionHistoryFile, receivedAt: string): void {
  db.prepare(`DELETE FROM hoops_projection_history WHERE season_start_year = ?`).run(file.season_start_year);
  for (const s of file.snapshots) {
    insertSnapshotRows(db, file.season_start_year, s.as_of_date, s.source, s.replicates, file.generated_at, receivedAt, s.teams);
  }
  db.prepare(
    `INSERT OR REPLACE INTO hoops_projection_history_meta (id, season_start_year, generated_at, received_at, n_snapshots)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(file.season_start_year, file.generated_at, receivedAt, file.snapshots.length);
}

/** The stored history file's generated_at, for the route's "unchanged" rule. */
export function storedProjectionHistoryGeneratedAt(db: Database.Database): string | null {
  const m = db.prepare(`SELECT generated_at FROM hoops_projection_history_meta WHERE id = 1`).get() as
    | { generated_at: string }
    | undefined;
  return m?.generated_at ?? null;
}

/** One team's nights for a season, oldest first. */
export function readTeamTrend(db: Database.Database, seasonStartYear: number, tri: string): TrendPoint[] {
  const rows = db
    .prepare(
      `SELECT as_of_date, source, wins, losses, proj_wins, wins_p10, wins_p90, playoff_pct, title_pct
         FROM hoops_projection_history
        WHERE season_start_year = ? AND tri = ?
        ORDER BY as_of_date`,
    )
    .all(seasonStartYear, tri) as Array<{
    as_of_date: string;
    source: ProjectionSource;
    wins: number;
    losses: number;
    proj_wins: number;
    wins_p10: number;
    wins_p90: number;
    playoff_pct: number;
    title_pct: number;
  }>;
  return rows.map((r) => ({
    date: r.as_of_date,
    source: r.source,
    wins: r.wins,
    losses: r.losses,
    projWins: r.proj_wins,
    p10: r.wins_p10,
    p90: r.wins_p90,
    playoffPct: r.playoff_pct,
    titlePct: r.title_pct,
  }));
}

/** Every team's nights for a season, oldest first per team, keyed by tri —
 *  the all-teams trend on /hoops/sim/projections. One query, not thirty. */
export function readLeagueTrend(db: Database.Database, seasonStartYear: number): Record<string, TrendPoint[]> {
  const rows = db
    .prepare(
      `SELECT tri, as_of_date, source, wins, losses, proj_wins, wins_p10, wins_p90, playoff_pct, title_pct
         FROM hoops_projection_history
        WHERE season_start_year = ?
        ORDER BY tri, as_of_date`,
    )
    .all(seasonStartYear) as Array<{
    tri: string;
    as_of_date: string;
    source: ProjectionSource;
    wins: number;
    losses: number;
    proj_wins: number;
    wins_p10: number;
    wins_p90: number;
    playoff_pct: number;
    title_pct: number;
  }>;
  const out: Record<string, TrendPoint[]> = {};
  for (const r of rows) {
    (out[r.tri] ??= []).push({
      date: r.as_of_date,
      source: r.source,
      wins: r.wins,
      losses: r.losses,
      projWins: r.proj_wins,
      p10: r.wins_p10,
      p90: r.wins_p90,
      playoffPct: r.playoff_pct,
      titlePct: r.title_pct,
    });
  }
  return out;
}
