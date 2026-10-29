// Spoiler mode for the team, player and schedule pages — pure.
//
// The rule is the scores pages' own (dates.ts isGuardedDate): a game that has
// STARTED and is listed under a guarded date (today, and yesterday until 3 AM
// Mountain) is hidden unless the viewer revealed or synced it on this device.
// The server can't read that choice (it lives in localStorage), so it ships
// every guarded game VEILED — no score, winner, record or quarter, the same
// `veilGame` the scores list uses — and the page's LiveProvider asks the live
// endpoint for the viewer's view of it, exactly as the scores list does.
//
// Everything else a result could leak through is computed here from the
// games that are NOT guarded, never read off the source's own summary:
//   - a team's record, home/road split, streak and last-five strip;
//   - a player's per-game averages and game-log lines (a guarded line
//     ships as a bare row: date and opponent, no result, no stats);
//   - a roster injury stamped at or after the tip of the team's guarded game
//     (a player hurt tonight is a thing that happened tonight).
// Errs toward showing LESS: a game on a guarded date with no state (a game
// log line) is treated as started.

import { isGuardedDate } from "./dates.ts";
import { gameDate, sideOf } from "./teams.ts";
import { veilGame } from "./spoiler.ts";
import type { Game, PlayerGameLine, Roster } from "./types.ts";

/** A game the server must not show the result of at `now`. */
export function isGuardedGame(g: Pick<Game, "startUtc" | "state">, now: Date): boolean {
  if (g.state === "pre") return false;
  const d = gameDate(g.startUtc);
  return d !== "" && isGuardedDate(d, now);
}

export interface GuardedGames {
  /** Every game, the guarded ones veiled. */
  games: Game[];
  /** Ids of the veiled games. */
  guarded: Set<string>;
  /** The guarded dates these games fall on (at most two: today, last night). */
  dates: string[];
}

export function guardGames(games: Game[], now: Date): GuardedGames {
  const guarded = new Set<string>();
  const dates = new Set<string>();
  const out = games.map((g) => {
    if (!isGuardedGame(g, now)) return g;
    guarded.add(g.id);
    dates.add(gameDate(g.startUtc));
    return veilGame(g);
  });
  return { games: out, guarded, dates: [...dates].sort() };
}

export interface TeamRecord {
  wins: number;
  losses: number;
  home: [number, number];
  road: [number, number];
  /** "W3", "L1"; null before the first result. */
  streak: string | null;
  /** The last results, oldest first ("W" / "L"). */
  recent: ("W" | "L")[];
  /** Started games on a guarded date left out of every figure above. */
  held: number;
}

/**
 * A team's record from its own finished games of one season type, leaving out
 * every guarded game. `games` is the UNVEILED list (the veil strips the
 * winner flag this needs); guarded games are skipped here by the same rule.
 */
export function teamRecord(
  games: Game[],
  tri: string,
  now: Date,
  kind: Game["seasonKind"] = "regular",
  recentN = 5,
): TeamRecord {
  const rec: TeamRecord = { wins: 0, losses: 0, home: [0, 0], road: [0, 0], streak: null, recent: [], held: 0 };
  const results: ("W" | "L")[] = [];
  for (const g of [...games].sort((a, b) => a.startUtc.localeCompare(b.startUtc))) {
    if (g.seasonKind !== kind) continue;
    const side = sideOf(g, tri);
    if (!side) continue;
    if (isGuardedGame(g, now)) {
      rec.held++;
      continue;
    }
    if (g.state !== "post" || g.postponed) continue;
    const us = g[side];
    const them = g[side === "home" ? "away" : "home"];
    // The winner flag, else the score; a final with neither is skipped
    // rather than guessed.
    const won = us.winner ? true : them.winner ? false : us.score !== null && them.score !== null ? us.score > them.score : null;
    if (won === null) continue;
    results.push(won ? "W" : "L");
    if (won) rec.wins++;
    else rec.losses++;
    const split = side === "home" ? rec.home : rec.road;
    split[won ? 0 : 1]++;
  }
  if (results.length) {
    const last = results[results.length - 1];
    let n = 0;
    for (let i = results.length - 1; i >= 0 && results[i] === last; i--) n++;
    rec.streak = `${last}${n}`;
  }
  rec.recent = results.slice(-recentN);
  return rec;
}

/** A game-log line as it may ship: the whole line, or — guarded — only what
 *  the schedule already says (when, where, who). */
export type ShownLine =
  | { hidden: false; line: PlayerGameLine }
  | { hidden: true; line: Pick<PlayerGameLine, "gameId" | "startUtc" | "date" | "seasonKind" | "tri" | "home" | "opp"> };

export function guardLog(lines: PlayerGameLine[], now: Date): ShownLine[] {
  return lines.map((l) =>
    l.date !== "" && !isGuardedDate(l.date, now)
      ? { hidden: false, line: l }
      : {
          hidden: true,
          line: {
            gameId: l.gameId,
            startUtc: l.startUtc,
            date: l.date,
            seasonKind: l.seasonKind,
            tri: l.tri,
            home: l.home,
            opp: l.opp,
          },
        },
  );
}

export interface Averages {
  gp: number;
  min: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  to: number;
  /** Shooting splits from the made/attempted SUMS (not an average of
   *  per-game percentages); null with no attempts. */
  fgPct: number | null;
  tpPct: number | null;
  ftPct: number | null;
}

/** Per-game averages over the lines that are shown, of one season type. */
export function averages(shown: ShownLine[], kind: PlayerGameLine["seasonKind"] = "regular"): Averages | null {
  const lines = shown.filter((s): s is Extract<ShownLine, { hidden: false }> => !s.hidden).map((s) => s.line);
  const ls = lines.filter((l) => l.seasonKind === kind);
  if (ls.length === 0) return null;
  const sum = (k: keyof PlayerGameLine) => ls.reduce((a, l) => a + (l[k] as number), 0);
  const pct = (m: number, a: number) => (a > 0 ? m / a : null);
  const gp = ls.length;
  return {
    gp,
    min: sum("min") / gp,
    pts: sum("pts") / gp,
    reb: sum("reb") / gp,
    ast: sum("ast") / gp,
    stl: sum("stl") / gp,
    blk: sum("blk") / gp,
    to: sum("to") / gp,
    fgPct: pct(sum("fgm"), sum("fga")),
    tpPct: pct(sum("tpm"), sum("tpa")),
    ftPct: pct(sum("ftm"), sum("fta")),
  };
}

/** The roster with any injury stamped at or after the tip of one of the
 *  team's guarded games taken off (and counted). */
export function guardRoster(roster: Roster, games: Game[], now: Date): { roster: Roster; heldInjuries: number } {
  const tips = games
    .filter((g) => sideOf(g, roster.tri) && isGuardedGame(g, now))
    .map((g) => Date.parse(g.startUtc))
    .filter(Number.isFinite);
  if (tips.length === 0) return { roster, heldInjuries: 0 };
  const from = Math.min(...tips);
  let held = 0;
  const players = roster.players.map((p) => {
    if (!p.injury) return p;
    const at = p.injury.dateUtc ? Date.parse(p.injury.dateUtc) : NaN;
    // An injury with no date can't be placed before the tip — hold it.
    if (Number.isFinite(at) && at < from) return p;
    held++;
    return { ...p, injury: null };
  });
  return { roster: { ...roster, players }, heldInjuries: held };
}
