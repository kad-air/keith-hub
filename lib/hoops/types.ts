// Types for the committed hoops-sim export (hoops-data/*.json) and for the
// SQLite read-model rows built from it.
//
// The producer is `uv run hoops export-hub <dest>` in ~/Code/hoops-sim (issue
// #21 there). These types describe that file format exactly — if the exporter
// changes shape, this file and lib/hoops/blob-contract.json change with it.

export type RatingMode = "results" | "roster" | "blend" | "nightly";

/** The three modes every bundle has always carried. */
export const RATING_MODES: RatingMode[] = ["results", "roster", "blend"];

/**
 * `nightly` — "who has actually been on the floor, last ten games". A fourth
 * mode, and OPTIONAL: it is present only in a bundle carrying the nightly
 * block, so nothing may assume it exists. `availableRatingModes()` in
 * queries.ts is the one place that decides whether to offer it.
 */
export const NIGHTLY_MODE: RatingMode = "nightly";
export const ALL_RATING_MODES: RatingMode[] = [...RATING_MODES, NIGHTLY_MODE];

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

/**
 * One team's nightly read — "who has actually been on the floor, last ten
 * games". Same team convention as the three above (`off - def` is the margin
 * rating, a positive `def` means points allowed).
 *
 * 🔴 `abstained` is not decoration. A team too early in its season, or one
 * nobody could be priced for, keeps its RESULTS rating exactly, and the site
 * must say so rather than present a computed-looking number nobody computed.
 */
export interface RawNightlyRating extends RawTeamRatings {
  net: number;
  /** How much of this number is still the season-long results rating. */
  results_w: number;
  n_basis_games: number;
  games_played: number;
  abstained: boolean;
  /**
   * WHAT MOVED — the six display fields that name the men behind the gap
   * between the nightly read and the same roster priced off its season-typical
   * minutes (hoops-sim `docs/milestones/nightly-movers.md`). All optional and
   * travelling together: no wire token, absent on an abstained team (nothing
   * was re-priced, so there is nothing to explain) and on any bundle published
   * before the sender learned them.
   *
   * 🔴 Three quantities that are NOT interchangeable:
   *   `delta_pre_mix`  — the team's WHOLE gap, points a game. The full
   *                      decomposition (all `n_movers_total` men) sums to it
   *                      exactly; the three shipped movers do not.
   *   `movers_delta_sum` — the sum over the three SHOWN only.
   *   `delta_post_mix` — `delta_pre_mix × (1 − results_w)`, the share of that
   *                      gap that actually survives the mix into the nightly
   *                      number.
   * And `nightly_vs_results` is a fourth, different quantity (this team's
   * Nightly column minus its Results column) that the movers do NOT decompose
   * — it ships because the page wants it, labelled so nobody adds the three
   * mover numbers and expects to land on it.
   */
  delta_pre_mix?: number | null;
  delta_post_mix?: number | null;
  nightly_vs_results?: number | null;
  n_movers_total?: number | null;
  movers_delta_sum?: number | null;
  movers?: RawNightlyMover[] | null;
}

/**
 * One man behind a team's nightly gap: what he is worth per 36, how many of
 * the last ten he played, the minutes a night the team got out of him over
 * that window against the whole season, and the points a game his change of
 * usage moved the team by (BEFORE the mix — multiply by `1 − results_w` for
 * the share that reaches the nightly rating itself).
 *
 * 🔴 `minutes_typical` averages across ALL of a team's games, counting a night
 * off as zero, and so does `minutes_last_n`. Giannis Antetokounmpo reads 12.9
 * typical minutes because he played 36 of Milwaukee's 82 — it is not a claim
 * that he is a 13-minute player. Both halves use the same convention, so it
 * cancels in the difference.
 *
 * 🔴 `athlete_id` −1 is the `absorbed` slot: the replacement-level "next man
 * up" a declared absence's minutes were diverted to. It is NEVER a person and
 * must never be rendered as one or linked to a player page.
 */
export interface RawNightlyMover {
  athlete_id: number;
  name: string;
  games_played_of_last_n: number;
  minutes_last_n: number;
  minutes_typical: number;
  value_per36: number;
  delta_pts: number;
  /**
   * `out`      — did not play one of the last ten, and was a real part of the season
   * `back`     — playing lately after missing most of it (appearance rate at
   *              least twice his season rate). Says his AVAILABILITY is up, not
   *              his minutes — and the delta can still be negative if he is a
   *              below-replacement man taking a bigger share.
   * `up`/`down`— around either way, at more or fewer minutes than his average
   * `absorbed` — the next-man-up slot, never a person
   */
  direction: "out" | "back" | "up" | "down" | "absorbed";
}

export interface RawTeam {
  conference: Conference;
  division: string;
  results: RawTeamRatings;
  roster: RawTeamRatings;
  blend: RawTeamRatings;
  /** Optional — present only in a bundle carrying the nightly block. */
  nightly?: RawNightlyRating;
}

export interface RawTeamsFile {
  generated_at: string;
  hca_pts: number;
  avg_poss_per_team_game: number;
  /** Nightly-block provenance, all optional and travelling together. */
  nightly_as_of?: string | null;
  nightly_value_source?: string | null;
  nightly_last_n_games?: number | null;
  nightly_season_start_year?: number | null;
  /** True when the sender declared `nightly_strength`, i.e. this read is fit
   *  to PRICE a game with and not merely to display. */
  nightly_priced?: boolean | null;
  nightly_note?: string | null;
  /**
   * How much the 30-team AVERAGE moved between the two readings — this build,
   * −1.34 points a game, because injuries and rest accumulate over a season so
   * the league as a whole prices lower off its last ten games than off its
   * full one. 🔴 It is a league-wide level, deliberately NOT charged to any
   * player: a mover's number is his team's own change, both halves recentred
   * by the same constant so the drift cancels out of it. Report the level
   * apart from the spread.
   */
  nightly_league_typical_shift?: number | null;
  nightly_movers_note?: string | null;
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
  /**
   * REPLACEMENT-LEVEL versions of `stack_net_per36`/`value_pg` (issue #70 F5,
   * owner decision 2026-09-03: "I would like 0 to be replacement player").
   * `value_per36_above_replacement = stack_net_per36 - replacement_per36`;
   * `value_per_game_above_replacement` is that times expected minutes / 36.
   * Shipped pre-computed, never derived here — same discipline as `value_pg`.
   * Display fields only: `pricing.ts`'s roster-strength math keeps reading
   * the UNCHANGED `value_per36`/`replacement_per36` pair exactly as before.
   * Optional and travel together with the stack fields above: null on a
   * player with no stack rating, and both null together on a bundle that
   * predates this addition — everything that reads them falls back to
   * `value_pg`/`stack_net_per36` (average-zero) with the old label.
   */
  value_per36_above_replacement?: number | null;
  value_per_game_above_replacement?: number | null;
  /**
   * HOW the stack rating was assembled — the explain sidecar (hoops-sim
   * `playervalue.build_tape_stack_explain`, exported per-36). Optional and a
   * display field like the six above it: no wire token, an older bundle simply
   * lacks it. `mu + tape.move == final` by construction; the blend and the
   * wage-sheet items are real reconstructions and `check:hoops:explain`
   * re-adds them on every build.
   */
  explain?: RawPlayerExplain | null;
}

/** One side of the ball, in points per 36 minutes. */
export interface OffDef {
  off: number;
  def: number;
}

export interface ExplainItem {
  /** wage-sheet feature: pts, load, tov, ast, oreb, load_x_eff, stl, blk, dreb, mpg,
   *  ast_potential_extra — the last two arrived with the group-interacted wage sheet. */
  stat: string;
  side: "off" | "def";
  /** the player's minutes-shrunk per-36 rate the sheet priced */
  rate: number;
  /** the league rate it is read against (0 for the interaction term) */
  league: number;
  /** points per 36 above/below what a league-average rate earns */
  contrib: number;
  /**
   * The coefficient THIS ITEM was actually priced at — `contrib == coef *
   * (rate − league)` (wing-defence.md §9e). On a group-interacted wage sheet
   * (`explain_model.positional_arm` beyond the pooled arm) this differs from
   * `explain_model.coefficients[side][stat]`, which is the LEAGUE-WIDE
   * reference sheet, not what any one player was priced at. Reconcile and
   * display against THIS field; fall back to the pooled model coefficient
   * only for an older bundle that doesn't carry it.
   */
  coef?: number | null;
}

export type PriorKind = "box+history" | "box only" | "history only" | "rookie" | "resume" | "none";

export interface RawPlayerExplain {
  prior_kind: PriorKind;
  /** The box sample was under the model's floor, so the prior was IGNORED
   *  (shrunk toward league average instead). `mu` reads 0/0 when true. */
  prior_floored: boolean;
  /** The scouting report the tape solve shrank toward. */
  mu: OffDef;
  /** The wage sheet's read of his box line, itemised. Null: no box half. */
  box:
    | (OffDef & {
        minutes: number | null;
        baseline_off: number;
        baseline_def: number;
        items: ExplainItem[];
      })
    | null;
  /** His plus-minus history before the tape window. Null: no history half. */
  history: (OffDef & { ref_season: number }) | null;
  /** The reliability weights ON THE HISTORY half (box gets 1 − w). */
  weights: OffDef | null;
  /** The aging offset added after the blend. */
  aging: OffDef;
  tape: {
    n_off_poss: number;
    n_def_poss: number;
    /** final − mu, per side: what seven seasons of tape moved him by. */
    move_off: number;
    move_def: number;
  };
  /** Equals stack_off_per36 / stack_def_per36 on the same row. */
  final: OffDef;
  /**
   * The SAME bundle-level replacement level (`RawPlayersFile.replacement_per36`)
   * riding on each carrier's own explain block, so a page reconstructing "how
   * this number was built" can also show what gets subtracted from
   * `final.off + final.def` to reach `value_per36_above_replacement`. A single
   * NET number, not an off/def split — real basketball has no offence/defence
   * halves of "the last man a team could find". Null on a bundle that
   * predates issue #70 F5.
   */
  replacement_per36?: number | null;
}

/** League-level facts the player page prints once. */
export interface ExplainModel {
  seasons: { first: number; last: number };
  decay: number;
  lam: number;
  luck_adjusted: boolean;
  playoffs_included: boolean;
  weights: OffDef;
  aging_scale: number | null;
  box_pool_seasons: number;
  prior_min_box_minutes: number | null;
  side_pace: number;
  /** points per raw event for a full-season starter: made_2, made_3, missed_fg,
   *  turnover, assist, oreb, steal, block, dreb */
  wage_sheet: Record<string, number | null>;
  wage_reference_minutes: number | null;
  /** per-36 coefficients — the POOLED, league-wide reference sheet. On a
   *  group-interacted arm (see `positional_arm` below) this is NOT what any
   *  one player was priced at; read `ExplainItem.coef` for that instead and
   *  use this only as the reference "what the league pays" reading. */
  coefficients: { off: Record<string, number>; def: Record<string, number> };
  as_of: string | null;
  /** The wage-sheet arm this bundle priced players with — e.g. "arm1" (one
   *  set of wages for the whole league, so `ExplainItem.coef` always equals
   *  `coefficients[side][stat]`) or "arm2"/"arm3" (each position group gets
   *  its own wages, so items can differ from the pooled sheet). Null on a
   *  bundle that predates the group-interacted wage sheet (issue #70). */
  positional_arm?: string | null;
}

export interface RawPlayersFile {
  generated_at: string;
  season_start_year: number;
  value_as_of: string;
  n_players: number;
  replacement_per36: number;
  bench_default_minutes: number;
  players: RawPlayer[];
  /** Present only when the sender's explain sidecar existed at export time. */
  explain_model?: ExplainModel | null;
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
  /** Nightly, all nullable together — a bundle without the block leaves every
   *  one of these NULL and the nightly lens is simply not offered. */
  nightly_off?: number | null;
  nightly_def?: number | null;
  nightly_results_w?: number | null;
  nightly_n_basis_games?: number | null;
  nightly_abstained?: number | null;
  /** WHAT MOVED — see RawNightlyRating. Null for a team the read abstained on,
   *  and for every bundle published before the sender shipped the block. The
   *  JSON column may ride along on a `SELECT *`; only getTeamMovers parses it. */
  nightly_movers_json?: string | null;
  nightly_delta_pre_mix?: number | null;
  nightly_delta_post_mix?: number | null;
  nightly_n_movers_total?: number | null;
  nightly_movers_delta_sum?: number | null;
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
  /** See RawPlayer — 0 = REPLACEMENT LEVEL, not average (issue #70 F5). Null
   *  together on a player with no stack rating, or on a bundle that predates
   *  this addition; everything that reads them falls back to
   *  value_pg/stack_net_per36 with the old "vs average" label. */
  value_per36_above_replacement: number | null;
  value_per_game_above_replacement: number | null;
  /** See RawPlayer.explain. Null on a bundle without the sidecar — and null on
   *  every LIST read (getAllPlayers/getRoster), which never hydrate it; only
   *  getPlayer does, because ~530 itemised blocks would triple the payload of a
   *  page that shows none of them. */
  explain: RawPlayerExplain | null;
}
