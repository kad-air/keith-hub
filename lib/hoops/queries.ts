// Read-model queries over the imported hoops-sim export.
//
// Every entry point calls ensureHoopsImport() first, so the tables are always
// populated from the committed bundle before anything reads them.

import { getDb } from "@/lib/db";
import { ensureHoopsImport } from "./import";
import type { ImportSource } from "./import";
import { modeDisagreement, rankTeams } from "./rating";
import type { ModeDisagreement } from "./rating";
import type {
  PlayerRow,
  RankedTeam,
  RatingMode,
  RawPlayerGameRates,
  RawPlayerPer36,
  TeamRow,
} from "./types";
import { RATING_MODES } from "./types";

export function isRatingMode(v: string | null | undefined): v is RatingMode {
  return !!v && (RATING_MODES as string[]).includes(v);
}

export const DEFAULT_RATING_MODE: RatingMode = "blend";

/** Every team row, straight off the read model. The ranking maths lives in
 *  rating.ts so the client can re-rank without a round trip. */
export function getTeamRows(): TeamRow[] {
  ensureHoopsImport();
  return getDb().prepare(`SELECT * FROM hoops_teams ORDER BY tri`).all() as TeamRow[];
}

export function getRankedTeams(mode: RatingMode = DEFAULT_RATING_MODE): RankedTeam[] {
  return rankTeams(getTeamRows(), mode);
}

export function getTeam(tri: string, mode: RatingMode = DEFAULT_RATING_MODE): RankedTeam | null {
  return rankTeams(getTeamRows(), mode).find((t) => t.tri === tri.toUpperCase()) ?? null;
}

export function getModeDisagreement(): ModeDisagreement {
  return modeDisagreement(getTeamRows());
}

interface PlayerDbRow {
  athlete_id: number;
  nba_player_id: number | null;
  tri: string;
  name: string;
  minutes: number;
  value_per36: number | null;
  game_rates: string | null;
  per36: string | null;
}

function hydratePlayer(r: PlayerDbRow): PlayerRow {
  return {
    athlete_id: r.athlete_id,
    nba_player_id: r.nba_player_id,
    tri: r.tri,
    name: r.name,
    minutes: r.minutes,
    value_per36: r.value_per36,
    game_rates: r.game_rates ? (JSON.parse(r.game_rates) as RawPlayerGameRates) : null,
    per36: r.per36 ? (JSON.parse(r.per36) as RawPlayerPer36) : null,
  };
}

/** One team's roster, heaviest minutes first. */
export function getRoster(tri: string): PlayerRow[] {
  ensureHoopsImport();
  const rows = getDb()
    .prepare(`SELECT * FROM hoops_players WHERE tri = ? ORDER BY minutes DESC, name ASC`)
    .all(tri.toUpperCase()) as PlayerDbRow[];
  return rows.map(hydratePlayer);
}

export function getRosterSizes(): Map<string, number> {
  ensureHoopsImport();
  const rows = getDb()
    .prepare(`SELECT tri, COUNT(*) AS n FROM hoops_players GROUP BY tri`)
    .all() as Array<{ tri: string; n: number }>;
  return new Map(rows.map((r) => [r.tri, r.n]));
}

export interface HoopsMeta {
  paramVersion: string;
  generatedAt: string;
  importedAt: string;
  dataAsOf: string;
  fittedAt: string;
  hcaPts: number;
  avgPossPerTeamGame: number;
  /** Value per 36 of a replacement-level player — the zero line for value. */
  replacementPer36: number;
  valueAsOf: string;
  /** 'seed' = the committed hoops-data/*.json fallback; 'push' = a real Mac
   *  Mini push (kad-air/keith-hub#73). See lib/hoops/import.ts. */
  importSource: ImportSource;
  teams: number;
  players: number;
  scheduledGames: number;
  results: number;
  lines: number;
}

/**
 * Provenance for the UI footer — what fit this is, and when it was taken.
 *
 * 🔴 Reads EXCLUSIVELY off the SQLite read model, never `loadBundle()` (disk).
 * Before kad-air/keith-hub#73, hca_pts/replacementPer36/valueAsOf were read
 * straight off the committed hoops-data/*.json bundle on every call — fine
 * when disk was the only byte source, but silently wrong once a push can
 * update the DB without ever touching those files. `writeBundle`
 * (lib/hoops/import.ts) now persists all three into hoops_params at import
 * time, from EITHER source, so this function reflects whichever one is
 * actually live.
 */
export function getHoopsMeta(): HoopsMeta {
  ensureHoopsImport();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT param_version, blob, generated_at, imported_at, import_source,
              hca_pts, replacement_per36, value_as_of
       FROM hoops_params WHERE id = 1`,
    )
    .get() as
    | {
        param_version: string;
        blob: string;
        generated_at: string;
        imported_at: string;
        import_source: ImportSource;
        hca_pts: number;
        replacement_per36: number;
        value_as_of: string;
      }
    | undefined;
  if (!row) throw new Error("hoops_params is empty — the import did not run");

  const blob = JSON.parse(row.blob) as {
    parameter_set: { data_as_of: string; fitted_at: string; avg_poss_per_team_game: number };
  };

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  return {
    paramVersion: row.param_version,
    generatedAt: row.generated_at,
    importedAt: row.imported_at,
    dataAsOf: blob.parameter_set.data_as_of,
    fittedAt: blob.parameter_set.fitted_at,
    hcaPts: row.hca_pts,
    avgPossPerTeamGame: blob.parameter_set.avg_poss_per_team_game,
    replacementPer36: row.replacement_per36,
    valueAsOf: row.value_as_of,
    importSource: row.import_source,
    teams: count("hoops_teams"),
    players: count("hoops_players"),
    scheduledGames: count("hoops_schedule"),
    results: count("hoops_results"),
    lines: count("hoops_lines"),
  };
}
