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
import type { RawProjectionsFile, RawProjectionTeam } from "./types";

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
