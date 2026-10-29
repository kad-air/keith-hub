// The ONLY impure edge of the scores section: fetch ESPN, parse, cache in
// SQLite. Server-side only (better-sqlite3); pages call it directly, the way
// app/page.tsx reads the feed.
//
// Caching, in one place:
//   - a finished thing (a past day whose games are all final, a final box
//     score, a finished game's core read) is stored with final = 1 and never
//     fetched again;
//   - a live game's core read (clock, totals, last play — see live.ts): 2.5s;
//     a live day's scoreboard: 10s; a live box score: 6s; today / tomorrow
//     and unfinished past days: 60s; further-out days: 15 min; a past day
//     with no games: 6h (an off day doesn't change, but an empty response
//     shouldn't be trusted forever); standings: 5 min.
//   - concurrent readers of one key share one upstream request (the
//     in-flight map) — the live endpoint is polled every 3s per open tab and
//     must never fan out into N parallel ESPN fetches of the same resource.
// 🔴 On an upstream failure the last cached copy is served, flagged stale,
// with the error — never a blank page that reads as "no games tonight". With
// no copy at all the page gets the error and says so.

import { getDb } from "@/lib/db";
import { espnDate, todayIn } from "./dates.ts";
import {
  applyLive,
  coreUrls,
  liveCandidates,
  livePolicy,
  parseCorePlay,
  parseCoreScore,
  parseCoreStatus,
  playRef,
} from "./live.ts";
import { findNotable } from "./notable.ts";
import { parseScoreboard, parseStandings, parseSummary } from "./parse.ts";
import { boxPolicy, scoreboardPolicy } from "./policy.ts";
import { boxFromPlays } from "./boxAt.ts";
import { gameAtMoment, momentAt, offsetForMoment, playsAt, veilGame, wirePlay } from "./spoiler.ts";
export { findGame } from "./policy.ts";
import type {
  CoreLive,
  Game,
  GameBox,
  LiveGame,
  LiveResponse,
  NotableLine,
  Scoreboard,
  SourceMeta,
  Standings,
  SyncResolution,
  WirePlay,
} from "./types.ts";

/** Bump when a parser's OUTPUT shape changes: cached rows are parsed objects,
 *  and a final row is otherwise never re-read. */
const CACHE_VERSION = 3; // 2: GameBox gained `plays` (spoiler mode); 3: Play gained `pointsAttempted`

const BASE = "https://site.api.espn.com/apis";
const URLS = {
  scoreboard: (date: string) =>
    `${BASE}/site/v2/sports/basketball/nba/scoreboard?dates=${espnDate(date)}`,
  summary: (id: string) => `${BASE}/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(id)}`,
  standings: () => `${BASE}/v2/sports/basketball/nba/standings`,
};

const SEC = 1000;
const MIN = 60 * SEC;
const TIMEOUT_MS = 8 * SEC;

export interface Fetched<T> {
  data: T | null;
  /** Epoch ms the data was fetched upstream. */
  fetchedAt: number | null;
  /** True when this is an old copy served because the refresh failed. */
  stale: boolean;
  error: string | null;
}

/** What a page footer needs from a Fetched — never the data, which would
 *  otherwise ride into the client bundle a second time as a prop. */
export function sourceMeta(f: Fetched<unknown>): SourceMeta {
  return { fetchedAt: f.fetchedAt, stale: f.stale, error: f.error };
}

interface Row {
  fetched_at: number;
  final: number;
  value: string;
}

async function getJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const inflight = new Map<string, Promise<Fetched<unknown>>>();

/**
 * Read-through cache. `load` produces the parsed value (one request or
 * several); `policy` sees it and says how long it stays fresh and whether it
 * is final. Concurrent callers of one key await the same load.
 */
function cached<T>(
  key: string,
  load: () => Promise<T>,
  policy: (v: T) => { ttlMs: number; final: boolean },
  now = Date.now(),
): Promise<Fetched<T>> {
  const db = getDb();
  const fullKey = `v${CACHE_VERSION}:${key}`;
  const row = db
    .prepare("SELECT fetched_at, final, value FROM hoops_scores_cache WHERE key = ?")
    .get(fullKey) as Row | undefined;

  let prev: T | null = null;
  if (row) {
    try {
      prev = JSON.parse(row.value) as T;
    } catch {
      prev = null;
    }
    if (prev !== null) {
      const { ttlMs } = policy(prev);
      if (row.final === 1 || now - row.fetched_at < ttlMs) {
        return Promise.resolve({ data: prev, fetchedAt: row.fetched_at, stale: false, error: null });
      }
    }
  }

  const pending = inflight.get(fullKey) as Promise<Fetched<T>> | undefined;
  if (pending) return pending;

  const run = (async (): Promise<Fetched<T>> => {
    try {
      const value = await load();
      const { final } = policy(value);
      db.prepare(
        `INSERT INTO hoops_scores_cache (key, fetched_at, final, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at,
           final = excluded.final, value = excluded.value`,
      ).run(fullKey, now, final ? 1 : 0, JSON.stringify(value));
      return { data: value, fetchedAt: now, stale: false, error: null };
    } catch (err) {
      const msg = err instanceof Error ? (err.name === "AbortError" ? "upstream timed out" : err.message) : String(err);
      console.error(`[hoops/scores] ${key}: ${msg}`);
      return prev !== null && row
        ? { data: prev, fetchedAt: row.fetched_at, stale: true, error: msg }
        : { data: null, fetchedAt: null, stale: false, error: msg };
    } finally {
      inflight.delete(fullKey);
    }
  })();
  inflight.set(fullKey, run as Promise<Fetched<unknown>>);
  return run;
}

export function getScoreboard(date: string, now = new Date()): Promise<Fetched<Scoreboard>> {
  const today = todayIn(now);
  return cached(
    `scoreboard:${date}`,
    async () => parseScoreboard(await getJson(URLS.scoreboard(date)), date),
    (sb) => scoreboardPolicy(sb, today),
    now.getTime(),
  );
}

export function getBox(gameId: string): Promise<Fetched<GameBox>> {
  return cached(`summary:${gameId}`, async () => parseSummary(await getJson(URLS.summary(gameId))), boxPolicy);
}

export function getStandings(): Promise<Fetched<Standings>> {
  return cached(
    "standings",
    async () => parseStandings(await getJson(URLS.standings())),
    () => ({ ttlMs: 5 * MIN, final: false }),
  );
}

/**
 * One game's core read: status, both totals, and the last play (two hops:
 * situation → the play it points at). The status is the one read that MUST
 * succeed — a game with no clock is not a live read; a missing total or play
 * degrades to null and the scoreboard's figure stands.
 */
export function getLiveGame(game: Game): Promise<Fetched<CoreLive>> {
  const urls = coreUrls(game);
  const soft = async <T,>(f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return fallback;
    }
  };
  return cached(
    `live:${game.id}`,
    async () => {
      const [status, awayScore, homeScore, situation] = await Promise.all([
        getJson(urls.status).then(parseCoreStatus),
        soft(() => getJson(urls.awayScore).then(parseCoreScore), null),
        soft(() => getJson(urls.homeScore).then(parseCoreScore), null),
        soft(() => getJson(urls.situation), null),
      ]);
      const ref = playRef(situation);
      const lastPlay = ref ? await soft(() => getJson(ref).then(parseCorePlay), null) : null;
      return { id: game.id, ...status, awayScore, homeScore, lastPlay, fetchedAt: Date.now() };
    },
    livePolicy,
  );
}

/** Spoiler mode, as the client states it on each tick (lib/hoops/scores/
 *  spoiler.ts). `protect` is on for a guarded day (today, and yesterday
 *  until 3 AM — dates.ts isGuardedDate): every started game not named in
 *  `reveal` and not in `sync` is veiled server-side, so no score for it ever
 *  reaches the wire; a synced game ships only its moment. */
export interface SpoilerRequest {
  protect: boolean;
  reveal: ReadonlySet<string>;
  /** game id → real-time offset in ms. */
  sync: ReadonlyMap<string, number>;
}

const NO_SPOILER: SpoilerRequest = { protect: false, reveal: new Set(), sync: new Map() };

/** The box score without its play-by-play — the plays never go to the client
 *  inside the box; the play-by-play tab gets its own cut (`plays` below). */
const boxForWire = (b: GameBox | null): GameBox | null => (b ? { game: b.game, teams: b.teams } : null);

/**
 * What `/api/hoops/scores/live` returns: the day's live candidates (or the one
 * game asked for) with the core overlay applied, and — for a single game that
 * has tipped — its box score (and, with `withPlays`, its play-by-play). A game
 * whose core read failed outright keeps its scoreboard copy, so the page
 * degrades to the slow path, never to a hole. Under `protect` the day's finals
 * join the list too, since a revealed final needs its score and a veiled one
 * needs its veil.
 *
 * 🔴 The single game's box and plays follow the same three cases as its card:
 * open (unprotected or revealed) → the live box and every play; synced → the
 * box REBUILT from the plays up to now − offset (`boxFromPlays`, `held`) and
 * only those plays; veiled → neither. All three are cut from ONE read of the
 * summary, so the card, the box and the plays always stand on the same play.
 */
export async function getLive(
  date: string,
  gameId: string | null,
  now = new Date(),
  spoiler: SpoilerRequest = NO_SPOILER,
  withPlays = false,
): Promise<Fetched<LiveResponse>> {
  const sb = await getScoreboard(date, now);
  if (!sb.data) return { data: null, fetchedAt: null, stale: false, error: sb.error ?? "scoreboard unavailable" };
  const nowMs = now.getTime();
  const wanted = gameId
    ? sb.data.games.filter((g) => g.id === gameId)
    : spoiler.protect
      ? sb.data.games.filter((g) => g.state !== "pre" || liveCandidates({ ...sb.data!, games: [g] }, nowMs).length > 0)
      : liveCandidates(sb.data, nowMs);
  // One summary read per game per request, shared by the card, box and plays.
  const boxes = new Map<string, Promise<GameBox | null>>();
  const boxOf = (id: string) => {
    let b = boxes.get(id);
    if (!b) boxes.set(id, (b = getBox(id).then((r) => r.data)));
    return b;
  };
  // The core read only for games still going; a final's scoreboard copy is final.
  const reads = await Promise.all(wanted.map((g) => (g.state === "post" ? null : getLiveGame(g))));
  const games: LiveGame[] = await Promise.all(
    wanted.map(async (g, i) => {
      const live = reads[i]?.data ?? null;
      const current: LiveGame = live
        ? { game: applyLive(g, live), lastPlay: live.lastPlay }
        : { game: g, lastPlay: null };
      if (!spoiler.protect || g.state === "pre") return current;
      if (spoiler.reveal.has(g.id)) return current;
      const offset = spoiler.sync.get(g.id);
      if (offset !== undefined) {
        const box = await boxOf(g.id);
        const moment = box?.plays?.length ? momentAt(box.plays, nowMs - offset) : null;
        return moment
          ? { game: gameAtMoment(g, moment), lastPlay: moment.lastPlay, moment }
          : { game: veilGame(g), lastPlay: null, veiled: true, moment: null };
      }
      return { game: veilGame(g), lastPlay: null, veiled: true };
    }),
  );
  const single = gameId ? games[0] : undefined;
  let box: GameBox | null = null;
  let held = false;
  let plays: WirePlay[] | null = null;
  if (single && single.game.state !== "pre" && !single.veiled) {
    const full = await boxOf(single.game.id);
    if (single.moment) {
      // Synced: everything stops at the moment's own play.
      const upTo = full?.plays?.length ? playsAt(full.plays, single.moment.atMs) : [];
      box = full && upTo.length ? { game: single.game, teams: boxFromPlays(full.teams, upTo) } : null;
      held = true;
      if (withPlays) plays = upTo.map(wirePlay);
    } else {
      box = boxForWire(full);
      if (withPlays) plays = full?.plays ? playsAt(full.plays, Infinity).map(wirePlay) : [];
    }
  }
  const failed = reads.find((r) => r?.error);
  return {
    data: { date, games, box, held, plays, fetchedAt: nowMs },
    fetchedAt: nowMs,
    stale: false,
    error: failed?.error ?? null,
  };
}

/** "I'm at `clockSec` left in `period`" for one game → the offset to view
 *  at, off the play-by-play (the box score's cache, 6s while live). */
export async function resolveSync(
  gameId: string,
  period: number,
  clockSec: number,
  now = new Date(),
): Promise<SyncResolution> {
  const box = (await getBox(gameId)).data;
  if (!box?.plays?.length) return { ok: false, reason: "no-plays" };
  return offsetForMoment(box.plays, period, clockSec, now.getTime());
}

/** Notable lines for a day: every FINISHED game's box score (each cached
 *  forever after its first fetch), run through the detector. A box score
 *  that fails to load drops out and is counted, so the page can say so. */
export async function getNotable(
  sb: Scoreboard,
): Promise<{ lines: NotableLine[]; missing: number }> {
  const finals = sb.games.filter((g) => g.state === "post");
  const results = await Promise.all(finals.map((g) => getBox(g.id)));
  const boxes = results.map((r) => r.data).filter((b): b is GameBox => b !== null);
  return { lines: findNotable(boxes, sb.date), missing: finals.length - boxes.length };
}
