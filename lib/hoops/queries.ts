// Read-model queries over the imported hoops-sim export.
//
// Every entry point calls ensureHoopsImport() first, so the tables are always
// populated from the committed bundle before anything reads them.

import { getDb } from "@/lib/db";
import type { BoxPlayer } from "./boxscore";
import { ensureHoopsImport } from "./import";
import type { ImportSource } from "./import";
import { decodeParams } from "./params";
import type { DecodedParams } from "./params";
import { modeDisagreement, rankTeams } from "./rating";
import type { ModeDisagreement } from "./rating";
import type {
  PlayerRow,
  RankedTeam,
  RatingMode,
  RawParamsFile,
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
  value_off_per36: number | null;
  value_def_per36: number | null;
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
    // 🔴 net = off + def, and a positive def is GOOD defence — the opposite of
    // the team convention two functions up. See lib/hoops/playervalue.ts.
    // `?? null` because a DB row written before this column existed reads
    // undefined rather than null once the migration adds it.
    value_off_per36: r.value_off_per36 ?? null,
    value_def_per36: r.value_def_per36 ?? null,
    game_rates: r.game_rates ? (JSON.parse(r.game_rates) as RawPlayerGameRates) : null,
    per36: r.per36 ? (JSON.parse(r.per36) as RawPlayerPer36) : null,
  };
}

/**
 * Every rostered player in the league, for /hoops/players.
 *
 * Deliberately unordered-by-value: the ranking is done by the pure
 * lib/hoops/playervalue.ts so the client can re-sort net/off/def without a
 * round trip, exactly as TeamsClient re-ranks the three rating modes. The
 * `name` order here just makes the payload deterministic.
 */
export function getAllPlayers(): PlayerRow[] {
  ensureHoopsImport();
  const rows = getDb()
    .prepare(`SELECT * FROM hoops_players ORDER BY name ASC`)
    .all() as PlayerDbRow[];
  return rows.map(hydratePlayer);
}

/** One team's roster, heaviest minutes first. */
export function getRoster(tri: string): PlayerRow[] {
  ensureHoopsImport();
  const rows = getDb()
    .prepare(`SELECT * FROM hoops_players WHERE tri = ? ORDER BY minutes DESC, name ASC`)
    .all(tri.toUpperCase()) as PlayerDbRow[];
  return rows.map(hydratePlayer);
}

/**
 * One team's roster in the shape the box-score simulator wants.
 *
 * 🔴 This is the PARTICIPANT LIST, and it is everyone on the exported roster —
 * hoops-sim's own list is narrower (last-game actives, or the season-typical
 * rotation when that is stale). The bundle carries no game-by-game actives to
 * narrow it with; see lib/hoops/boxscore.ts's header for what that changes.
 */
export function getBoxRoster(tri: string): BoxPlayer[] {
  return getRoster(tri).map((p) => ({
    athlete_id: p.athlete_id,
    name: p.name,
    minutes: p.minutes,
    per36: p.per36,
    game_rates: p.game_rates,
  }));
}

/**
 * The decoded parameter blob, memoised per process and keyed on the row's
 * content hash.
 *
 * Decoding parses a ~290KB JSON and flattens it into typed arrays; doing that
 * per request would dominate a sim that otherwise takes a few hundred
 * milliseconds. Keying on content_hash (rather than caching forever) is what
 * makes a Mac Mini push take effect without a restart — importPushedBundle
 * rewrites the row, the hash moves, and the next read re-decodes.
 */
let paramsCache: { hash: string; params: DecodedParams } | null = null;

export function getDecodedParams(): DecodedParams {
  ensureHoopsImport();
  const row = getDb()
    .prepare(`SELECT blob, content_hash FROM hoops_params WHERE id = 1`)
    .get() as { blob: string; content_hash: string } | undefined;
  if (!row) throw new Error("hoops_params is empty — the import did not run");
  if (paramsCache && paramsCache.hash === row.content_hash) return paramsCache.params;
  const params = decodeParams(JSON.parse(row.blob) as RawParamsFile);
  paramsCache = { hash: row.content_hash, params };
  return params;
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
  /**
   * hoops-sim's own `absorption_rotation_floor_minutes` — the minutes at which
   * that project stops treating a player as a rotation piece. Read by name off
   * the blob's constants block, never hardcoded (lib/hoops/pricing.ts's rule),
   * and null if a bundle somehow doesn't carry it — in which case
   * /hoops/players simply doesn't offer the rotation lens rather than inventing
   * a threshold of its own.
   */
  rotationFloorMinutes: number | null;
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
    constants?: { absorption_rotation_floor_minutes?: number };
  };
  const rotationFloor = blob.constants?.absorption_rotation_floor_minutes;

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
    rotationFloorMinutes: typeof rotationFloor === "number" && Number.isFinite(rotationFloor)
      ? rotationFloor
      : null,
    importSource: row.import_source,
    teams: count("hoops_teams"),
    players: count("hoops_players"),
    scheduledGames: count("hoops_schedule"),
    results: count("hoops_results"),
    lines: count("hoops_lines"),
  };
}
