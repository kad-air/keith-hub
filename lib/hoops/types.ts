// Types for the committed hoops-sim export (hoops-data/*.json) and for the
// SQLite read-model rows built from it.
//
// The producer is `uv run hoops export-hub <dest>` in ~/Code/hoops-sim (issue
// #21 there). These types describe that file format exactly — if the exporter
// changes shape, this file and lib/hoops/blob-contract.json change with it.

export type RatingMode = "results" | "roster" | "blend";

export const RATING_MODES: RatingMode[] = ["results", "roster", "blend"];

export type Conference = "East" | "West";

// ---------------------------------------------------------------------------
// hoops_params.json
// ---------------------------------------------------------------------------

/** The fitted possession-model parameter set, as JSON (rounded floats). */
export interface RawParameterSet {
  param_version: string;
  fitted_at: string;
  data_as_of: string;
  source: string;

  // Shape constants, carried in the blob so the consumer can verify rather
  // than assume. Cross-checked against blob-contract.json on decode.
  n_tables: number;
  n_start_types: number;
  n_duration_rows: number;
  n_outcome_classes: number;
  n_regulation_periods: number;
  n_margin_buckets: number;
  n_game_margin_buckets: number;
  n_time_buckets: number;
  n_possessions_fit: number;
  n_games_team_rating_fit: number;

  // Scalars
  avg_poss_per_team_game: number;
  regulation_period_seconds: number;
  ot_period_seconds: number;
  endgame_window_seconds: number;
  pace_sigma: number;
  efficiency_sigma: number;
  duration_level_scale: number;
  duration_dispersion_scale: number;

  // Arrays
  theta_grid: number[][]; // n_tables × gridSize
  grid_ppp: number[]; // gridSize
  base_probs: number[][]; // n_tables × K
  base_mean_ppp: number[]; // n_tables
  categories: [string, number][]; // K — (outcome_class, points)
  points: number[]; // K
  outcome_class_of_category: number[]; // K
  table_labels: string[]; // n_tables
  duration_bin_edges: number[]; // durationBinEdges
  duration_cumprobs: number[][]; // n_duration_rows × durationBinEdges
  duration_table_mean: number[]; // n_duration_rows
  transition_cumprobs: number[][]; // n_outcome_classes × n_start_types
  margin_feedback_ppp: number[]; // n_margin_buckets
  margin_feedback_n: number[]; // n_margin_buckets
}

/** Non-fitted constants the ratings/roster-edit layer needs. */
export interface HoopsConstants {
  absorption_phi: number;
  absorption_rotation_floor_minutes: number;
  bench_default_minutes: number;
  blend_weight: number;
  ghost_athlete_id: number;
  playoff_alpha: number;
  replacement_percentile: number;
  total_team_minutes: number;
}

export interface RawParamsFile {
  generated_at: string;
  parameter_set: RawParameterSet;
  constants: HoopsConstants;
}

// ---------------------------------------------------------------------------
// hoops_teams.json
// ---------------------------------------------------------------------------

export interface RawTeamRatings {
  off: number;
  def: number;
}

export interface RawTeam {
  conference: Conference;
  division: string;
  results: RawTeamRatings;
  roster: RawTeamRatings;
  blend: RawTeamRatings;
}

export interface RawTeamsFile {
  generated_at: string;
  hca_pts: number;
  avg_poss_per_team_game: number;
  teams: Record<string, RawTeam>;
}

// ---------------------------------------------------------------------------
// hoops_players.json
// ---------------------------------------------------------------------------

/** Current-season per-game counting rates. Null for a true no-history rookie. */
export interface RawPlayerGameRates {
  gp: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

/** Most-recent-season per-36 rates — what the box-score simulator allocates. */
export interface RawPlayerPer36 {
  fg2m: number;
  fg3m: number;
  ftm: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

export interface RawPlayer {
  athlete_id: number;
  nba_player_id: number | null;
  name: string;
  team: string;
  /** Raw expected minutes (pre-normalization). Never null — gate-enforced. */
  minutes: number;
  game_rates: RawPlayerGameRates | null;
  per36: RawPlayerPer36 | null;
  /** production_net_value_per36 (the B4c flagship). Null for no-history. */
  value_per36: number | null;
  /**
   * The genuine offence/defence split of `value_per36`, from hoops-sim's
   * split-RAPM `production_value_snapshot`.
   *
   * 🔴 `value_off_per36 + value_def_per36 === value_per36` — an ADDITION, and
   * a positive `value_def_per36` is GOOD defence. That is the opposite of the
   * TEAM convention on `RawTeam` (`off - def`, positive def = points allowed).
   * See lib/hoops/playervalue.ts for the measurement and the reasoning; it is
   * asserted every build by scripts/check-hoops-players.ts.
   *
   * Optional because they arrived after the first exporter version: an older
   * bundle simply has neither, and everything that reads them handles null.
   */
  value_off_per36?: number | null;
  value_def_per36?: number | null;
  /**
   * The promoted 7-season "stack" rating (Seven Seasons of Tape), per-36 —
   * a SEPARATE model from `value_per36`/`value_off_per36`/`value_def_per36`
   * above, not a replacement for them. Same PLAYER sign convention as the
   * flagship split: `stack_off_per36 + stack_def_per36 === stack_net_per36`,
   * positive defence is GOOD defence.
   *
   * All six fields on this line are optional and travel together: the
   * currently-committed bundle carries none of them, and everything that
   * reads them must behave exactly as before when they're absent.
   */
  stack_net_per36?: number | null;
  stack_off_per36?: number | null;
  stack_def_per36?: number | null;
  /** Expected minutes per game — the sender's own input to `value_pg`. */
  expected_minutes?: number | null;
  /** `stack_net_per36 * expected_minutes / 36` — points of team margin per
   *  game vs. an average player. Shipped pre-computed, never derived here. */
  value_pg?: number | null;
  /** e.g. "27719 poss (7yr)" or "prior only" — what the stack rating rests on. */
  evidence?: string | null;
}

export interface RawPlayersFile {
  generated_at: string;
  season_start_year: number;
  value_as_of: string;
  n_players: number;
  replacement_per36: number;
  bench_default_minutes: number;
  players: RawPlayer[];
}

// ---------------------------------------------------------------------------
// hoops_schedule.json / hoops_results.json / hoops_lines.json
// ---------------------------------------------------------------------------

export interface RawScheduleGame {
  game_id: string;
  date: string;
  home: string;
  away: string;
  neutral_site: boolean;
}

export interface RawScheduleFile {
  generated_at: string;
  season_start_year: number;
  n_games: number;
  games: RawScheduleGame[];
}

export interface RawResultGame extends RawScheduleGame {
  home_score: number;
  away_score: number;
}

export interface RawResultsFile {
  generated_at: string;
  window: string;
  n: number;
  games: RawResultGame[];
}

/**
 * Closing market line. NOTE: no score fields — deliberately. The line provider
 * (SBR) disagrees with the truth on 3/1315 games, so real scores live only in
 * hoops_results.json. Don't add score columns here.
 */
export interface RawLine {
  game_id: string;
  date: string;
  home: string;
  away: string;
  home_spread: number | null;
  total: number | null;
  home_odds: number | null;
  away_odds: number | null;
  n_books_spread: number | null;
  n_books_total: number | null;
}

export interface RawLinesFile {
  generated_at: string;
  season_start_year: number;
  n: number;
  lines: RawLine[];
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

export interface HoopsBundle {
  params: RawParamsFile;
  teams: RawTeamsFile;
  players: RawPlayersFile;
  schedule: RawScheduleFile;
  results: RawResultsFile;
  lines: RawLinesFile;
}

// ---------------------------------------------------------------------------
// Read-model rows (SQLite)
// ---------------------------------------------------------------------------

export interface TeamRow {
  tri: string;
  conference: Conference;
  division: string;
  results_off: number;
  results_def: number;
  roster_off: number;
  roster_def: number;
  blend_off: number;
  blend_def: number;
}

/** A team with one rating mode resolved, plus derived net/rank. */
export interface RankedTeam {
  tri: string;
  conference: Conference;
  division: string;
  mode: RatingMode;
  off: number;
  def: number;
  net: number;
  rank: number;
  /**
   * |results net − roster net| for this team, in points. The honest,
   * *measured* stand-in for the plan's roster-churn caveat: a big number
   * means the two ratings disagree about this team right now. League typical
   * disagreement is ~3.1–3.3 pts (hoops-sim, post-B4b).
   */
  modeDisagreement: number;
}

export interface PlayerRow {
  athlete_id: number;
  nba_player_id: number | null;
  tri: string;
  name: string;
  minutes: number;
  value_per36: number | null;
  /** See RawPlayer — additive split, positive def is GOOD defence. */
  value_off_per36: number | null;
  value_def_per36: number | null;
  game_rates: RawPlayerGameRates | null;
  per36: RawPlayerPer36 | null;
  /** See RawPlayer — the promoted 7-season "stack" rating and its inputs.
   *  All six null on a bundle that predates this milestone. */
  stack_net_per36: number | null;
  stack_off_per36: number | null;
  stack_def_per36: number | null;
  expected_minutes: number | null;
  value_pg: number | null;
  evidence: string | null;
}
