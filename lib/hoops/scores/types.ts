// Shapes for the REAL scores section (/hoops/scores, /hoops/standings).
//
// 🔴 Deliberately separate from everything else in lib/hoops/: these come
// from a live upstream (ESPN's public JSON), not from the hoops-sim bundle,
// the read-model tables or the engine. Nothing in this directory imports
// from them, and nothing there imports from here — the only shared piece is
// nba-franchises.ts, for display names and the tri codes.

export type GameState = "pre" | "in" | "post";
export type SeasonKind = "preseason" | "regular" | "postseason" | "other";

export interface TeamLine {
  /** Canonical tri (GSW, NOP, UTA…) — ESPN's own short codes (GS, NO,
   *  UTAH) are mapped onto nba-franchises.ts; an unknown club (a preseason
   *  international opponent) keeps ESPN's abbreviation. */
  tri: string;
  espnId: string;
  name: string;
  /** "Nuggets" — the short label a dense line wants. */
  nickname: string;
  /** null before tip. */
  score: number | null;
  /** Points per period: 4 quarters, then one entry per overtime. */
  linescore: number[];
  /** Overall W-L as of this game ("22-8"), when the source carries it. */
  record: string | null;
  winner: boolean;
}

export interface Broadcasts {
  national: string[];
  home: string[];
  away: string[];
}

export interface Game {
  id: string;
  /** Tip time, ISO 8601 UTC, as the source gives it. */
  startUtc: string;
  state: GameState;
  /** The source's own short status: "Final/OT", "9:08 - 4th", "End of 3rd",
   *  "Postponed". Rendered as-is for anything that isn't pre/post. */
  statusDetail: string;
  period: number;
  clock: string | null;
  postponed: boolean;
  away: TeamLine;
  home: TeamLine;
  tv: Broadcasts;
  seasonKind: SeasonKind;
  /** A competition note: "NBA Finals - Game 4", "NBA Canada Games 2026". */
  note: string | null;
  /** Postseason series state ("NY leads series 3-1"); null in the regular
   *  season, where ESPN's field is the season series and would mislead. */
  series: string | null;
}

export interface Scoreboard {
  /** YYYY-MM-DD — the US date the games are listed under. */
  date: string;
  games: Game[];
}

export interface PlayerBoxLine {
  id: string;
  name: string;
  starter: boolean;
  /** Did not play: no stat line at all. `dnpReason` says why when given. */
  dnp: boolean;
  dnpReason: string | null;
  ejected: boolean;
  min: number;
  pts: number;
  reb: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  to: number;
  pf: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  plusMinus: number | null;
}

export interface TeamTotals {
  pts: number;
  reb: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  to: number;
  pf: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
}

export interface TeamBoxScore {
  tri: string;
  name: string;
  homeAway: "home" | "away";
  /** Starters first (in the source's order), then the bench, then DNPs. */
  players: PlayerBoxLine[];
  totals: TeamTotals;
}

export interface GameBox {
  game: Game;
  /** [away, home]. Empty before tip. */
  teams: TeamBoxScore[];
  /** The play-by-play, in the source's order (spoiler mode reads it; see
   *  `Play`). Absent on rows cached before it was parsed, and stripped from
   *  anything sent to the client. */
  plays?: Play[];
}

export interface StandingRow {
  tri: string;
  name: string;
  seed: number | null;
  wins: number;
  losses: number;
  /** ".667" — the source's own string, so a 0-0 team reads ".000". */
  pct: string;
  /** "-" for the leader, else "1.5". */
  gb: string;
  l10: string;
  streak: string;
  home: string;
  road: string;
}

export interface Standings {
  season: string | null;
  conferences: { name: string; rows: StandingRow[] }[];
}

/** One standout line, as the notable detector emits it. */
export interface NotableLine {
  gameId: string;
  date: string;
  /** "/hoops/scores/2026-10-21/atl-orl" — the box score it came from. */
  href: string;
  tri: string;
  opp: string;
  playerId: string;
  name: string;
  line: PlayerBoxLine;
  /** Why it is here, most impressive first: ["Triple-double", "40+ points"]. */
  reasons: string[];
  /** Sort key — bigger is more notable. */
  score: number;
}

// ── Live overlay (the fast path) ────────────────────────────────────────────
//
// 🔴 ESPN's per-game CORE resources (sports.core.api.espn.com …/competitions/
// <id>/status, …/competitors/<teamId>/score, …/situation → lastPlay) lead its
// scoreboard by 3–15s and its summary header by 15–20s — measured side by
// side on live games, 2026-10-25 (see lib/hoops/scores/live.ts). They carry
// only the clock, the period, the state, the two totals and the last play,
// so they are an OVERLAY on a scoreboard Game, never a replacement for it.

export interface LivePlay {
  text: string;
  clock: string | null;
  period: number;
  scoring: boolean;
  /** ESPN team id of the team the play is credited to; null for neutral
   *  plays (end of period, timeouts the source doesn't attribute). */
  teamId: string | null;
}

/** What the core resources say about one game, as cached server-side. */
export interface CoreLive {
  id: string;
  state: GameState;
  statusDetail: string;
  period: number;
  clock: string | null;
  postponed: boolean;
  /** null when the score resource was unreadable — the scoreboard's stands. */
  awayScore: number | null;
  homeScore: number | null;
  lastPlay: LivePlay | null;
  /** Epoch ms the core resources were read. */
  fetchedAt: number;
}

/** One game as the live endpoint ships it: the scoreboard Game with the core
 *  overlay applied (`applyLive`), plus the last play. */
export interface LiveGame {
  game: Game;
  lastPlay: LivePlay | null;
  /** Spoiler mode: the game is veiled (today's page, not revealed, not
   *  synced) — `game` carries no scores, quarters, records or winner. */
  veiled?: boolean;
  /** Spoiler mode: the game as of now − the viewer's offset, off the
   *  play-by-play. null when the offset reaches before the first play. */
  moment?: MomentSnapshot | null;
}

/** `GET /api/hoops/scores/live?date=&game=` */
export interface LiveResponse {
  date: string;
  games: LiveGame[];
  /** Only when a single game was asked for and it has tipped. */
  box: GameBox | null;
  fetchedAt: number;
  /** Only when `?at=P:SS` was asked. */
  resolution?: SyncResolution | null;
}

/** The part of a Fetched<T> a page footer needs — never the data. */
export interface SourceMeta {
  fetchedAt: number | null;
  stale: boolean;
  error: string | null;
}

// ── Spoiler mode (today's page) ────────────────────────────────────────────
//
// One play of ESPN's play-by-play, as the summary ships it. 🔴 `wallclockMs`
// is what makes "I'm at 7:32 in the 3rd" resolvable: every play carries the
// real time it happened, so a game moment maps to a real-time offset and the
// card can follow the play-by-play from there — no recorded history needed.
export interface Play {
  id: string;
  sequence: number;
  period: number;
  /** "7:32", "24.7" — the source's text. */
  clock: string | null;
  /** Seconds left in the period, parsed from `clock`; null when unparseable. */
  clockSec: number | null;
  wallclockMs: number;
  awayScore: number;
  homeScore: number;
  text: string;
  scoring: boolean;
  teamId: string | null;
}

/** The game as of one real-time instant, read off the play-by-play. */
export interface MomentSnapshot {
  period: number;
  clock: string | null;
  awayScore: number;
  homeScore: number;
  /** Points per period up to and including `period`, derived from the
   *  cumulative score at each period's last play — never inferred. */
  awayLinescore: number[];
  homeLinescore: number[];
  lastPlay: LivePlay | null;
  /** The moment is the end of the game. */
  final: boolean;
  /** Effective real time of the play this snapshot stands on. */
  atMs: number;
}

/** What `?at=P:SS` resolved to. */
export type SyncResolution =
  | { ok: true; offsetMs: number; period: number; clock: string | null }
  | { ok: false; reason: "ahead" | "no-plays" };

/** The per-device choice for one protected game (localStorage). */
export type SpoilerEntry = { mode: "revealed" } | { mode: "synced"; offsetMs: number };
