// The LIVE overlay — pure: no fetch, no fs, no SQLite. data.ts does the
// reading; this file says WHAT to read, how to parse it, and how it lands on
// a scoreboard Game. scripts/check-hoops-scores.ts drives it over recorded
// core responses in hoops-scores-fixture/ (core-*.json, 2026-10-25, BKN@IND
// in the 2nd quarter).
//
// 🔴 Why a second path at all. ESPN's scoreboard is ONE document for the whole
// day and its CDN serves it about every 10s; its summary (the box score) is
// ~400 KB and trails the scoreboard. The CORE API publishes each game as small
// per-resource documents with their own short cache lifetimes, and measured
// side by side on live games (2026-10-25, Jazz–Lakers and Nets–Pacers, three
// runs) they LEAD:
//
//   resource                         what it carries           lead over scoreboard
//   …/competitions/<id>/status       clock, period, state      3–15 s
//   …/competitors/<teamId>/score     one team's total          3–6 s
//   …/situation → lastPlay.$ref      the last play's text      ≈ the status
//   (summary header)                 clock + totals            TRAILS by 15–20 s
//
// 🔴 The last play's OWN awayScore/homeScore are NOT a score source: they wobble
// (42-40 → 42-42 → 42-41 across consecutive reads, as ESPN re-sequences plays)
// and lag the score resources. Only its text/clock/period are used.
//
// 🔴 It is an OVERLAY. The core resources know nothing about records, quarters,
// TV, series notes or the winner flag — `applyLive` moves exactly the fields
// the fast path owns and leaves every other field as the scoreboard had it.
// A quarter cell can therefore trail the total by a few seconds; that is the
// data, not a derivation (the current quarter's points are never inferred).
//
// Rate: the client ticks every LIVE_POLL_MS while a game is in progress and
// the server caches each game's read for LIVE_TTL_MS, so a full seven-game
// slate costs at most ~5 small requests per game per tick while — and only
// while — a scores page is open on a live game (the cache is read-through;
// nothing polls when nobody is looking).

import { parseStatus } from "./parse.ts";
import type { CoreLive, Game, LivePlay, Scoreboard } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/** Client tick while a game is in progress. */
export const LIVE_POLL_MS = 3_000;
/** Client tick while tonight's slate is still waiting to tip. */
export const PENDING_POLL_MS = 30_000;
/** Server cache for one game's core read (ESPN's own max-age is 2–4s). */
export const LIVE_TTL_MS = 2_500;
/** How long before its listed tip a scheduled game is probed, so the flip
 *  from "7:00 PM MT" to a running clock arrives on the first tick. */
export const TIP_LOOKAHEAD_MS = 5 * 60_000;

const CORE_HOST = "sports.core.api.espn.com";
const CORE = `https://${CORE_HOST}/v2/sports/basketball/leagues/nba/events`;

/** The core resources for one game. ESPN's NBA event id and competition id
 *  are the same number, which is what `Game.id` holds. */
export function coreUrls(game: Pick<Game, "id" | "away" | "home">) {
  const base = `${CORE}/${encodeURIComponent(game.id)}/competitions/${encodeURIComponent(game.id)}`;
  return {
    status: `${base}/status`,
    situation: `${base}/situation`,
    awayScore: `${base}/competitors/${encodeURIComponent(game.away.espnId)}/score`,
    homeScore: `${base}/competitors/${encodeURIComponent(game.home.espnId)}/score`,
  };
}

/** `…/status` → the five status fields. Throws on a payload that isn't one
 *  (no `type`), so an error page can never read as a game with no clock. */
export function parseCoreStatus(raw: J): Pick<CoreLive, "state" | "statusDetail" | "period" | "clock" | "postponed"> {
  if (!raw || typeof raw !== "object" || !raw.type || typeof raw.type !== "object") {
    throw new Error("core status: no type block — not a status response");
  }
  return parseStatus(raw);
}

/** `…/competitors/<id>/score` → the total, or null when unreadable (the
 *  scoreboard's figure then stands). ESPN ships `value` as a float (43.0). */
export function parseCoreScore(raw: J): number | null {
  if (!raw || typeof raw !== "object") return null;
  const v = typeof raw.value === "number" ? raw.value : parseFloat(String(raw.displayValue ?? ""));
  return Number.isFinite(v) ? Math.trunc(v) : null;
}

/** The `$ref` the situation points at for its last play — https, and ONLY
 *  on ESPN's core host (a `$ref` is a URL the upstream hands us; we don't
 *  follow it anywhere else). null when absent. */
export function playRef(situation: J): string | null {
  const ref = situation?.lastPlay?.$ref;
  if (typeof ref !== "string") return null;
  try {
    const u = new URL(ref);
    if (u.hostname !== CORE_HOST) return null;
    u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}

/** `…/plays/<id>` → the play as the card prints it. null when there is no
 *  text. The team id is the last path segment of `team.$ref`. */
export function parseCorePlay(raw: J): LivePlay | null {
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.text ?? raw.shortText ?? "").trim();
  if (!text) return null;
  const teamRef = typeof raw.team?.$ref === "string" ? raw.team.$ref : "";
  const m = /\/teams\/(\d+)(?:\?|$)/.exec(teamRef);
  const period = Number(raw.period?.number);
  return {
    text,
    clock: typeof raw.clock?.displayValue === "string" ? raw.clock.displayValue : null,
    period: Number.isFinite(period) ? period : 0,
    scoring: raw.scoringPlay === true,
    teamId: m ? m[1] : null,
  };
}

/** Lay the core read over the scoreboard's Game. Moves ONLY state /
 *  statusDetail / period / clock / postponed and the two totals (a null total
 *  keeps the scoreboard's); recomputes the winner flags once the game is
 *  over, since the scoreboard's copy may still say "in progress". Everything
 *  else — tri, names, records, quarters, TV, note, series — is untouched. */
export function applyLive(game: Game, live: CoreLive): Game {
  const awayScore = live.awayScore ?? game.away.score;
  const homeScore = live.homeScore ?? game.home.score;
  const over = live.state === "post" && awayScore != null && homeScore != null;
  return {
    ...game,
    state: live.state,
    statusDetail: live.statusDetail,
    period: live.period,
    clock: live.clock,
    postponed: live.postponed,
    away: {
      ...game.away,
      score: live.state === "pre" ? game.away.score : awayScore,
      winner: over ? awayScore > homeScore : game.away.winner,
    },
    home: {
      ...game.home,
      score: live.state === "pre" ? game.home.score : homeScore,
      winner: over ? homeScore > awayScore : game.home.winner,
    },
  };
}

/** Which of a day's games the live endpoint reads: every game in progress,
 *  plus any scheduled game within TIP_LOOKAHEAD_MS of its tip (or past it and
 *  not yet started — a delayed tip). Finals and postponements are left to the
 *  scoreboard. */
export function liveCandidates(sb: Scoreboard, nowMs: number): Game[] {
  return sb.games.filter((g) => {
    if (g.postponed) return false;
    if (g.state === "in") return true;
    if (g.state !== "pre") return false;
    const tip = Date.parse(g.startUtc);
    return Number.isFinite(tip) && tip - nowMs <= TIP_LOOKAHEAD_MS;
  });
}

/** Cache policy for one game's core read: a finished game is final (the
 *  overlay is then static and the scoreboard owns the record); anything else
 *  lives LIVE_TTL_MS. */
export function livePolicy(live: CoreLive): { ttlMs: number; final: boolean } {
  return live.state === "post" ? { ttlMs: Infinity, final: true } : { ttlMs: LIVE_TTL_MS, final: false };
}
