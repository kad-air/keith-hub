// Pure cache policy + URL resolution for the scores section — split out of
// data.ts so scripts/check-hoops-scores.ts can drive it with plain node (no
// SQLite, no path aliases). See data.ts's header for the TTL table.

import { addDays } from "./dates.ts";
import { gameSlug } from "./parse.ts";
import type { Game, GameBox, Scoreboard } from "./types.ts";

const SEC = 1000;
const MIN = 60 * SEC;

const settled = (g: Game) => g.state === "post" || g.postponed;

/** The cache policy for one day's scoreboard. */
export function scoreboardPolicy(sb: Scoreboard, today: string): { ttlMs: number; final: boolean } {
  const past = sb.date < today;
  // A live day: the scoreboard carries the quarters and records the core
  // overlay (live.ts) doesn't, and its CDN republishes about every 10s.
  if (sb.games.some((g) => g.state === "in")) return { ttlMs: 10 * SEC, final: false };
  if (past && sb.games.length > 0 && sb.games.every(settled)) return { ttlMs: Infinity, final: true };
  if (past && sb.games.length === 0) return { ttlMs: 6 * 60 * MIN, final: false };
  // Today and the next day move (tip times, a live game starting); further
  // out only reschedules.
  const tomorrowish = sb.date <= addDays(today, 1);
  return { ttlMs: past || tomorrowish ? MIN : 15 * MIN, final: false };
}

export function boxPolicy(b: GameBox): { ttlMs: number; final: boolean } {
  if (b.game.state === "post") return { ttlMs: Infinity, final: true };
  // A live box score: ESPN's summary advertises max-age=6, and the game page
  // ticks it in place (LiveProvider) — there is no point reading it faster.
  if (b.game.state === "in") return { ttlMs: 6 * SEC, final: false };
  return { ttlMs: 5 * MIN, final: false };
}

/** The game a box-score URL names: "atl-orl" (away-home) on that date, or a
 *  bare ESPN event id. */
export function findGame(sb: Scoreboard, slug: string): Game | null {
  const s = slug.toLowerCase();
  return sb.games.find((g) => gameSlug(g) === s || g.id === s) ?? null;
}

