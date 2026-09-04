// Read-model queries over the imported hoops-sim export.
//
// Every entry point calls ensureHoopsImport() first, so the tables are always
// populated from the committed bundle before anything reads them.

import { getDb } from "@/lib/db";
import type { BoxPlayer } from "./boxscore";
import { ensureHoopsImport } from "./import";
import type { ImportSource } from "./import";
import { meetingsBetween } from "./matchup";
import type { Meeting } from "./matchup";
import { decodeParams } from "./params";
import type { DecodedParams } from "./params";
import { availableRatingModes as availableModesOf, modeDisagreement, rankTeams } from "./rating";
import type { ModeDisagreement } from "./rating";
import type {
  ExplainModel,
  PlayerRow,
  RankedTeam,
  RatingMode,
  RawNightlyMover,
  RawParamsFile,
  RawPlayerExplain,
  RawPlayerGameRates,
  RawPlayerPer36,
  TeamRow,
} from "./types";
import { ALL_RATING_MODES } from "./types";

export function isRatingMode(v: string | null | undefined): v is RatingMode {
  return !!v && (ALL_RATING_MODES as string[]).includes(v);
}

/** The mode chosen when nothing else says otherwise, for a bundle that has no
 *  nightly read. `resolveRatingMode` upgrades this to `nightly` where one
 *  exists and the sender declared it fit to price with. */
export const DEFAULT_RATING_MODE: RatingMode = "blend";

/** Every team row, straight off the read model. The ranking maths lives in
 *  rating.ts so the client can re-rank without a round trip. */
export function getTeamRows(): TeamRow[] {
  ensureHoopsImport();
  return getDb().prepare(`SELECT * FROM hoops_teams ORDER BY tri`).all() as TeamRow[];
}

/** Which rating lenses this bundle can offer. The decision itself is pure and
 *  lives in rating.ts (so the client and the build check can both reach it);
 *  this is the DB-backed convenience wrapper. */
export function availableRatingModes(rows?: TeamRow[]): RatingMode[] {
  return availableModesOf(rows ?? getTeamRows());
}

/**
 * The mode to price a game with when the caller has not chosen one.
 *
 * Prefers the nightly read — "who has actually been on the floor, last ten
 * games", the one game-level channel hoops-sim has measured a held-out gain
 * for — but ONLY when the bundle carries a complete one AND the sender
 * declared `nightly_strength`, meaning it vouches for it as a pricing input
 * rather than a display. Falls back to the blend, which is what every page did
 * before. Whatever it picks is disclosed on the page; nothing here is silent.
 */
export function resolveRatingMode(rows?: TeamRow[]): RatingMode {
  const teams = rows ?? getTeamRows();
  if (!availableRatingModes(teams).includes("nightly")) return DEFAULT_RATING_MODE;
  return getNightlyMeta().priced ? "nightly" : DEFAULT_RATING_MODE;
}

export function getRankedTeams(mode: RatingMode = DEFAULT_RATING_MODE): RankedTeam[] {
  return rankTeams(getTeamRows(), mode);
}

export function getTeam(tri: string, mode: RatingMode = DEFAULT_RATING_MODE): RankedTeam | null {
  return rankTeams(getTeamRows(), mode).find((t) => t.tri === tri.toUpperCase()) ?? null;
}

export interface NightlyMeta {
  /** Present at all? False for every bundle published before hub-v2. */
  present: boolean;
  /** The sender declared `nightly_strength` — fit to price a game with. */
  priced: boolean;
  /** The as-of date of the player values the read was built from. */
  asOf: string | null;
  /** e.g. "stack_nightly" — which player-rating model priced the minutes. */
  valueSource: string | null;
  /** How many recent games per team the read looks at. */
  lastNGames: number | null;
  /** Teams the read abstained on: too early in their season, or nobody could
   *  be priced. They keep their results rating exactly, and the page says so. */
  abstained: string[];
  /** How far the 30-team AVERAGE moved between the nightly reading and the
   *  season-typical one — a league-wide level (this build, about a point and a
   *  third a game, because injuries and rest accumulate). Published apart from
   *  the movers precisely so it is charged to nobody's name. Null on a bundle
   *  that predates it. */
  leagueTypicalShift: number | null;
}

export function getNightlyMeta(): NightlyMeta {
  ensureHoopsImport();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT nightly_as_of, nightly_value_source, nightly_last_n_games, nightly_priced,
              nightly_league_typical_shift
       FROM hoops_params WHERE id = 1`,
    )
    .get() as
    | {
        nightly_as_of: string | null;
        nightly_value_source: string | null;
        nightly_last_n_games: number | null;
        nightly_priced: number | null;
        nightly_league_typical_shift: number | null;
      }
    | undefined;
  const abstained = (
    db
      .prepare(`SELECT tri FROM hoops_teams WHERE nightly_abstained = 1 ORDER BY tri`)
      .all() as Array<{ tri: string }>
  ).map((r) => r.tri);
  const present = (
    db.prepare(`SELECT COUNT(*) AS n FROM hoops_teams WHERE nightly_off IS NOT NULL`).get() as {
      n: number;
    }
  ).n > 0;
  return {
    present,
    priced: present && row?.nightly_priced === 1,
    asOf: row?.nightly_as_of ?? null,
    valueSource: row?.nightly_value_source ?? null,
    lastNGames: row?.nightly_last_n_games ?? null,
    abstained,
    leagueTypicalShift: row?.nightly_league_typical_shift ?? null,
  };
}

/** One team's "what moved": the whole gap between its nightly read and the
 *  same roster priced off its season-typical minutes, and the three men most
 *  responsible for it. */
export interface TeamMovers {
  /** The team's WHOLE gap, points a game, before the mix with the season-long
   *  rating. The FULL decomposition sums to this; the three below do not. */
  deltaPreMix: number;
  /** deltaPreMix × (1 − results_w): the share of it inside the nightly number. */
  deltaPostMix: number;
  /** How many men moved the team by at least a hundredth of a point a game. */
  nMoversTotal: number;
  /** The sum over the SHOWN movers only — so the page can say "these three
   *  account for X of the Y" without implying the three are the whole story. */
  moversDeltaSum: number;
  movers: RawNightlyMover[];
}

/**
 * The movers for one team, or null when this bundle has none for it — an older
 * bundle, or (the case that matters) a team the nightly read abstained on,
 * where nothing was re-priced and so nothing moved. Null, never an empty list:
 * "nobody moved" and "we never looked" are different sentences.
 */
export function getTeamMovers(tri: string): TeamMovers | null {
  ensureHoopsImport();
  const row = getDb()
    .prepare(
      `SELECT nightly_movers_json, nightly_delta_pre_mix, nightly_delta_post_mix,
              nightly_n_movers_total, nightly_movers_delta_sum
       FROM hoops_teams WHERE tri = ?`,
    )
    .get(tri.toUpperCase()) as
    | {
        nightly_movers_json: string | null;
        nightly_delta_pre_mix: number | null;
        nightly_delta_post_mix: number | null;
        nightly_n_movers_total: number | null;
        nightly_movers_delta_sum: number | null;
      }
    | undefined;
  if (!row?.nightly_movers_json) return null;
  if (row.nightly_delta_pre_mix == null || row.nightly_delta_post_mix == null) return null;
  return {
    deltaPreMix: row.nightly_delta_pre_mix,
    deltaPostMix: row.nightly_delta_post_mix,
    nMoversTotal: row.nightly_n_movers_total ?? 0,
    moversDeltaSum: row.nightly_movers_delta_sum ?? 0,
    movers: JSON.parse(row.nightly_movers_json) as RawNightlyMover[],
  };
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
  stack_net_per36: number | null;
  stack_off_per36: number | null;
  stack_def_per36: number | null;
  expected_minutes: number | null;
  value_pg: number | null;
  evidence: string | null;
  value_per36_above_replacement?: number | null;
  value_per_game_above_replacement?: number | null;
  explain_json?: string | null;
}

/** `withExplain` is opt-in: the list reads leave it null on purpose (see
 *  PlayerRow.explain) and only getPlayer parses the blob. */
function hydratePlayer(r: PlayerDbRow, withExplain = false): PlayerRow {
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
    // Same `?? null` reasoning: a DB row written before the stack-rating
    // migration reads undefined for all six until the ALTER TABLE lands.
    stack_net_per36: r.stack_net_per36 ?? null,
    stack_off_per36: r.stack_off_per36 ?? null,
    stack_def_per36: r.stack_def_per36 ?? null,
    expected_minutes: r.expected_minutes ?? null,
    value_pg: r.value_pg ?? null,
    evidence: r.evidence ?? null,
    // Same `?? null` reasoning again: a DB row written before this migration
    // (issue #70 F5) reads undefined for both until the ALTER TABLE lands.
    value_per36_above_replacement: r.value_per36_above_replacement ?? null,
    value_per_game_above_replacement: r.value_per_game_above_replacement ?? null,
    explain:
      withExplain && r.explain_json ? (JSON.parse(r.explain_json) as RawPlayerExplain) : null,
  };
}

/** One player, WITH his explain block — the player page's read. Null for an
 *  unknown athlete id (the page 404s). */
export function getPlayer(athleteId: number): PlayerRow | null {
  ensureHoopsImport();
  const row = getDb()
    .prepare(`SELECT * FROM hoops_players WHERE athlete_id = ?`)
    .get(athleteId) as PlayerDbRow | undefined;
  return row ? hydratePlayer(row, true) : null;
}

/** The explain sidecar's league-level facts, or null on a bundle without it. */
export function getExplainModel(): ExplainModel | null {
  ensureHoopsImport();
  const row = getDb()
    .prepare(`SELECT explain_model_json FROM hoops_params WHERE id = 1`)
    .get() as { explain_model_json?: string | null } | undefined;
  return row?.explain_model_json ? (JSON.parse(row.explain_model_json) as ExplainModel) : null;
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
  return rows.map((r) => hydratePlayer(r));
}

/** One team's roster, heaviest minutes first. */
export function getRoster(tri: string): PlayerRow[] {
  ensureHoopsImport();
  const rows = getDb()
    .prepare(`SELECT * FROM hoops_players WHERE tri = ? ORDER BY minutes DESC, name ASC`)
    .all(tri.toUpperCase()) as PlayerDbRow[];
  return rows.map((r) => hydratePlayer(r));
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

// ---------------------------------------------------------------------------
// Recent results + closing lines
//
// 🔴 hoops_results is a WINDOW, not a season: the exporter ships the most
// recent 200 completed regular-season games league-wide (~13 per team), so
// nothing derived from it may be labelled a "record" — it is recent FORM, and
// the UI says which dates the window covers. hoops_lines DOES cover the whole
// season (closing market lines keyed by game_id), so a game inside the window
// can be joined to its line; a null just means no line survived for that game.
// ---------------------------------------------------------------------------

interface ResultDbRow {
  game_id: string;
  date: string;
  home: string;
  away: string;
  home_score: number;
  away_score: number;
  neutral_site: number;
  home_spread: number | null;
}

/** One completed game from THIS team's point of view. */
export interface TeamFormGame {
  gameId: string;
  date: string;
  opp: string;
  /** True when the team was at home (a neutral-site game reads as neither —
   *  see `neutral`). */
  home: boolean;
  neutral: boolean;
  teamScore: number;
  oppScore: number;
  won: boolean;
  /** teamScore − oppScore, so a win is positive. */
  margin: number;
  /** Closing spread from THIS team's side (negative = this team favoured).
   *  Null when no line is stored for the game. */
  closingSpread: number | null;
  /** Against that line: did the team cover it? Null when there is no line. */
  ats: "covered" | "missed" | "push" | null;
}

export interface TeamForm {
  /** Newest first. */
  games: TeamFormGame[];
  wins: number;
  losses: number;
  /** The results window's own date span — the honesty label for "recent". */
  windowFrom: string | null;
  windowTo: string | null;
}

function toFormGame(r: ResultDbRow, tri: string): TeamFormGame {
  const home = r.home === tri;
  const teamScore = home ? r.home_score : r.away_score;
  const oppScore = home ? r.away_score : r.home_score;
  const margin = teamScore - oppScore;
  const closingSpread =
    r.home_spread == null ? null : home ? r.home_spread : -r.home_spread;
  let ats: TeamFormGame["ats"] = null;
  if (closingSpread != null) {
    const vsLine = margin + closingSpread;
    ats = vsLine > 0 ? "covered" : vsLine < 0 ? "missed" : "push";
  }
  return {
    gameId: r.game_id,
    date: r.date,
    opp: home ? r.away : r.home,
    home,
    neutral: r.neutral_site === 1,
    teamScore,
    oppScore,
    won: margin > 0,
    margin,
    closingSpread,
    ats,
  };
}

/** Every game in the results window involving one team, with its closing line. */
export function getTeamForm(tri: string): TeamForm {
  ensureHoopsImport();
  const t = tri.toUpperCase();
  const rows = getDb()
    .prepare(
      `SELECT r.game_id, r.date, r.home, r.away, r.home_score, r.away_score,
              r.neutral_site, l.home_spread
       FROM hoops_results r
       LEFT JOIN hoops_lines l ON l.game_id = r.game_id
       WHERE r.home = ? OR r.away = ?
       ORDER BY r.date DESC, r.game_id DESC`,
    )
    .all(t, t) as ResultDbRow[];
  const games = rows.map((r) => toFormGame(r, t));
  const window = getResultsWindow();
  return {
    games,
    wins: games.filter((g) => g.won).length,
    losses: games.filter((g) => !g.won).length,
    windowFrom: window?.from ?? null,
    windowTo: window?.to ?? null,
  };
}

/** Head to head this season: every scheduled game between two teams with its
 *  closing line and, inside the results window, the real final. The join is
 *  the pure `meetingsBetween`; this only fetches the rows. */
export function getMeetings(a: string, b: string): Meeting[] {
  ensureHoopsImport();
  const db = getDb();
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  const sched = db
    .prepare(
      `SELECT game_id, date, home, away, neutral_site FROM hoops_schedule
       WHERE (home = ? AND away = ?) OR (home = ? AND away = ?)`,
    )
    .all(A, B, B, A) as Array<{
    game_id: string;
    date: string;
    home: string;
    away: string;
    neutral_site: number;
  }>;
  if (sched.length === 0) return [];
  const ids = sched.map((g) => g.game_id);
  const marks = ids.map(() => "?").join(", ");
  const lines = db
    .prepare(`SELECT game_id, home_spread, total FROM hoops_lines WHERE game_id IN (${marks})`)
    .all(...ids) as Array<{ game_id: string; home_spread: number | null; total: number | null }>;
  const results = db
    .prepare(`SELECT game_id, home_score, away_score FROM hoops_results WHERE game_id IN (${marks})`)
    .all(...ids) as Array<{ game_id: string; home_score: number; away_score: number }>;
  return meetingsBetween(sched, lines, results, A, B);
}

/** The results window's date span — the label that keeps "recent form"
 *  honest wherever it renders. */
export function getResultsWindow(): { from: string; to: string } | null {
  ensureHoopsImport();
  const row = getDb()
    .prepare(`SELECT MIN(date) AS lo, MAX(date) AS hi FROM hoops_results`)
    .get() as { lo: string | null; hi: string | null };
  return row.lo && row.hi ? { from: row.lo, to: row.hi } : null;
}

/** Wins–losses over each team's most recent games in the window (up to `lastN`).
 *  A plain Record so it serialises cleanly into client-component props. */
export interface FormSummary {
  wins: number;
  losses: number;
  /** How many games the summary actually covers — the window can hold fewer
   *  than `lastN` for a team, and the label must not pretend otherwise. */
  n: number;
}

export function getLeagueFormSummaries(lastN = 10): Record<string, FormSummary> {
  ensureHoopsImport();
  const rows = getDb()
    .prepare(
      `SELECT game_id, date, home, away, home_score, away_score, neutral_site,
              NULL AS home_spread
       FROM hoops_results ORDER BY date DESC, game_id DESC`,
    )
    .all() as ResultDbRow[];
  const out: Record<string, FormSummary> = {};
  for (const r of rows) {
    for (const tri of [r.home, r.away]) {
      const s = (out[tri] ??= { wins: 0, losses: 0, n: 0 });
      if (s.n >= lastN) continue;
      s.n += 1;
      if (toFormGame(r, tri).won) s.wins += 1;
      else s.losses += 1;
    }
  }
  return out;
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
