// The ONLY impure edge of the scores section: fetch ESPN, parse, cache in
// SQLite. Server-side only (better-sqlite3); pages call it directly, the way
// app/page.tsx reads the feed.
//
// Caching, in one place:
//   - a finished thing (a past day whose games are all final, a final box
//     score) is stored with final = 1 and never fetched again;
//   - a live game: 30s; today / tomorrow and unfinished past days: 60s;
//     further-out days: 15 min; a past day with no games: 6h (an off day
//     doesn't change, but an empty response shouldn't be trusted forever);
//     standings: 5 min.
// 🔴 On an upstream failure the last cached copy is served, flagged stale,
// with the error — never a blank page that reads as "no games tonight". With
// no copy at all the page gets the error and says so.

import { getDb } from "@/lib/db";
import { espnDate, todayIn } from "./dates.ts";
import { findNotable } from "./notable.ts";
import { parseScoreboard, parseStandings, parseSummary } from "./parse.ts";
import { boxPolicy, scoreboardPolicy } from "./policy.ts";
export { findGame } from "./policy.ts";
import type { GameBox, NotableLine, Scoreboard, Standings } from "./types.ts";

/** Bump when a parser's OUTPUT shape changes: cached rows are parsed objects,
 *  and a final row is otherwise never re-read. */
const CACHE_VERSION = 1;

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

/**
 * Read-through cache. `policy` sees the freshly parsed value and says how
 * long it stays fresh and whether it is final.
 */
async function cached<T>(
  key: string,
  url: string,
  parse: (raw: unknown) => T,
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
        return { data: prev, fetchedAt: row.fetched_at, stale: false, error: null };
      }
    }
  }

  try {
    const value = parse(await getJson(url));
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
  }
}

export function getScoreboard(date: string, now = new Date()): Promise<Fetched<Scoreboard>> {
  const today = todayIn(now);
  return cached(
    `scoreboard:${date}`,
    URLS.scoreboard(date),
    (raw) => parseScoreboard(raw, date),
    (sb) => scoreboardPolicy(sb, today),
    now.getTime(),
  );
}

export function getBox(gameId: string): Promise<Fetched<GameBox>> {
  return cached(`summary:${gameId}`, URLS.summary(gameId), parseSummary, boxPolicy);
}

export function getStandings(): Promise<Fetched<Standings>> {
  return cached("standings", URLS.standings(), parseStandings, () => ({ ttlMs: 5 * MIN, final: false }));
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
