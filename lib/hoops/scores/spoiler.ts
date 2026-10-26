// Spoiler mode for TODAY's scores page — pure: no fetch, no DOM, no storage.
//
// The design (owner, 2026-10-25): today's started games are VEILED by default —
// the card shows the teams, the clock and the quarter and nothing else. A long
// press (the feed's Clear-Above gesture, same bar, same duration) reveals the
// score. A tap opens a sheet that offers the long press OR "I'm at <quarter>
// <time>": the hub finds that moment in the play-by-play, turns it into a
// real-time OFFSET, and the card then shows the score as of now − offset and
// follows the play-by-play from there. Only today; yesterday's games and the
// box-score page are untouched.
//
// 🔴 Why no recorded history is needed: every play ESPN ships carries
// `wallclock`, the real time it happened, plus the cumulative score, so the
// play-by-play IS the history. "7:32 in the 3rd" → the first play in game
// order at or past that clock → its wall-clock → offset = now − that.
//
// 🔴 Everything here errs toward showing LESS, never more:
//   - Wall-clocks are not monotone in game order (ESPN re-sequences plays —
//     measured, 15 of 512 steps go backwards on a real final), so each play's
//     EFFECTIVE time is the running max of wall-clocks up to it in game order.
//     A moment is "the last play whose effective time ≤ target", which can only
//     ever be at or BEFORE the true moment.
//   - Resolving a typed clock picks the first play AT OR PAST it (clock counts
//     down, so clockSec ≤ typed), never the one before it: the view lands a few
//     game-seconds behind the viewer's stream rather than ahead.
//   - A protected card's status strips the result: "Final/OT" → "Final",
//     because overtime is a result.
//   - The displayed clock in a synced view is the play's own clock — it steps
//     play to play. No clock is ever ticked locally (a fabricated running clock
//     is a confident wrong number).

import { statusLabel } from "./format.ts";
import { clockSeconds } from "./parse.ts";
import type { Game, LivePlay, MomentSnapshot, Play, SyncResolution } from "./types.ts";
export { clockSeconds };

/** Same hold as the feed's Clear-Above — the gesture is borrowed outright. */
export const LONG_PRESS_MS = 1000;

/** Game order: period, then clock running DOWN, then the source's sequence. */
export function orderPlays(plays: Play[]): Play[] {
  return [...plays].sort(
    (a, b) =>
      a.period - b.period ||
      (b.clockSec ?? -1) - (a.clockSec ?? -1) ||
      a.sequence - b.sequence,
  );
}

/** Running max of wall-clock in game order — see the header. */
export function effectiveTimes(ordered: Play[]): number[] {
  const out: number[] = [];
  let max = -Infinity;
  for (const p of ordered) {
    max = Math.max(max, p.wallclockMs);
    out.push(max);
  }
  return out;
}

const isGameEnd = (p: Play) => /\bEnd of Game\b/i.test(p.text);

function toLivePlay(p: Play): LivePlay {
  return { text: p.text, clock: p.clock, period: p.period, scoring: p.scoring, teamId: p.teamId };
}

/** Points per period through `upto` (an index into `ordered`), from the
 *  cumulative score at each period's LAST play at or before that index. */
function linescoresThrough(ordered: Play[], upto: number): { away: number[]; home: number[] } {
  const endAway: number[] = [];
  const endHome: number[] = [];
  for (let i = 0; i <= upto; i++) {
    const p = ordered[i];
    endAway[p.period - 1] = p.awayScore;
    endHome[p.period - 1] = p.homeScore;
  }
  const away: number[] = [];
  const home: number[] = [];
  for (let q = 0; q < endAway.length; q++) {
    const prevA = q === 0 ? 0 : (endAway[q - 1] ?? 0);
    const prevH = q === 0 ? 0 : (endHome[q - 1] ?? 0);
    away.push((endAway[q] ?? prevA) - prevA);
    home.push((endHome[q] ?? prevH) - prevH);
  }
  return { away, home };
}

/** The game as of `targetMs`, or null when the target precedes the first
 *  play (the viewer is behind the tip itself). */
export function momentAt(plays: Play[], targetMs: number): MomentSnapshot | null {
  const ordered = orderPlays(plays);
  const eff = effectiveTimes(ordered);
  let idx = -1;
  for (let i = 0; i < ordered.length; i++) if (eff[i] <= targetMs) idx = i;
  if (idx < 0) return null;
  const p = ordered[idx];
  const lines = linescoresThrough(ordered, idx);
  return {
    period: p.period,
    clock: p.clock,
    awayScore: p.awayScore,
    homeScore: p.homeScore,
    awayLinescore: lines.away,
    homeLinescore: lines.home,
    lastPlay: toLivePlay(p),
    final: isGameEnd(p) || (idx === ordered.length - 1 && ordered.some(isGameEnd)),
    atMs: eff[idx],
  };
}

/** "I'm at `clockSec` left in `period`" → the real-time offset to view at.
 *  Picks the first play in game order in that period with clock ≤ typed (at
 *  or past the moment — behind the viewer, never ahead). `ahead` when the
 *  live feed hasn't reached that moment yet. */
export function offsetForMoment(
  plays: Play[],
  period: number,
  clockSec: number,
  nowMs: number,
): SyncResolution {
  const ordered = orderPlays(plays);
  if (ordered.length === 0) return { ok: false, reason: "no-plays" };
  const eff = effectiveTimes(ordered);
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    if (p.period < period) continue;
    if (p.period > period) return { ok: true, offsetMs: Math.max(0, nowMs - eff[i]), period: p.period, clock: p.clock };
    if (p.clockSec !== null && p.clockSec <= clockSec) {
      return { ok: true, offsetMs: Math.max(0, nowMs - eff[i]), period: p.period, clock: p.clock };
    }
  }
  return { ok: false, reason: "ahead" };
}

/** What a veiled card may say about where the game is: the clock and the
 *  quarter, never the result. */
export function protectedStatus(g: Game): string {
  if (g.state === "post") return "Final";
  return statusLabel(g);
}

/** A Game with everything that could spoil removed: scores, quarters,
 *  records, winners, the OT suffix. Teams, tip, TV and notes stay. */
export function veilGame(g: Game): Game {
  const strip = (t: Game["away"]) => ({ ...t, score: null, linescore: [], record: null, winner: false });
  return { ...g, statusDetail: protectedStatus(g), away: strip(g.away), home: strip(g.home) };
}

/** A synced card's Game: the scoreboard's teams carrying the moment's score
 *  and quarters, with the moment's clock and period in the status line. */
export function gameAtMoment(g: Game, m: MomentSnapshot): Game {
  const over = m.final;
  const label = over ? "Final" : `${m.clock ?? ""} - ${periodWord(m.period)}`.trim();
  return {
    ...g,
    state: over ? "post" : "in",
    statusDetail: label,
    period: m.period,
    clock: over ? null : m.clock,
    away: { ...g.away, score: m.awayScore, linescore: m.awayLinescore, winner: over && m.awayScore > m.homeScore },
    home: { ...g.home, score: m.homeScore, linescore: m.homeLinescore, winner: over && m.homeScore > m.awayScore },
  };
}

/** "1st" … "4th", "OT", "2OT". */
export function periodWord(n: number): string {
  if (n <= 4) return ["1st", "2nd", "3rd", "4th"][n - 1] ?? `${n}th`;
  return n === 5 ? "OT" : `${n - 4}OT`;
}

/** The sheet's period choices for a game: the four quarters plus any
 *  overtime the play-by-play has reached (so a 2OT game offers 2OT). */
export function periodChoices(maxPeriod: number): { value: number; label: string }[] {
  const out = [];
  for (let n = 1; n <= Math.max(4, maxPeriod); n++) out.push({ value: n, label: periodWord(n) });
  return out;
}

/** "0:42 behind", "12:07 behind", "1h 05m behind" — how far a synced view
 *  trails live, from its real-time offset. */
export function behindLabel(offsetMs: number): string {
  const s = Math.max(0, Math.round(offsetMs / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} behind`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m behind`;
}
