// Pure player-value helpers — no fs, no SQLite, no server-only imports.
//
// Separate from queries.ts for exactly the reason rating.ts is: /hoops/players
// re-sorts and re-filters every rostered player (~530) on a phone, and there is
// no reason to ask the server for a re-sort of numbers it already sent.
//
// ───────────────────────────────────────────────────────────────────────────
// 🔴 THE SIGN CONVENTION HERE IS THE OPPOSITE OF rating.ts's. Read this before
// touching a plus or a minus in this file.
//
//   TEAMS   (rating.ts `netOf`):  net = off − def.
//           A positive `def` means points ALLOWED above league average, so a
//           good defence reads NEGATIVE.
//
//   PLAYERS (`netOf` below):      net = off + def.
//           A positive `def` means points PREVENTED, so a good defender reads
//           POSITIVE.
//
// Both come straight from hoops-sim and both are right there. A team rating is
// one strength split symmetrically (`off = +strength/2, def = −strength/2`),
// so recombining it subtracts. A player's value is a genuine split RAPM — two
// separate contributions that ADD to his net value.
//
// This is measured, not assumed. Over the committed bundle, `off + def`
// reconciles to `value_per36` on every player carrying a split, to four
// decimals; `off − def` reconciles on none of them. Rudy Gobert — four-time
// Defensive Player of the Year — reads def +4.08 against off −0.77, and Trae
// Young reads off +4.28 against def −3.00, which is the right way round for
// both men. scripts/check-hoops-players.ts re-measures all of that every build
// AND asserts the minus form still fails, so "fixing" this to match the team
// convention breaks the build instead of silently inverting every defender.
// ───────────────────────────────────────────────────────────────────────────
//
// 🔴 SCOPE. These two numbers are for DISPLAY only. The wire contract this
// bundle arrives under declares `symmetric_off_def`, and the exporter ships its
// own note saying so: "value_off_per36/value_def_per36 are UNUSED while
// contract.features declares symmetric_off_def … Pricing today uses value_per36
// (net) only: off=net/2, def=-net/2." So lib/hoops/pricing.ts and
// lib/hoops/boxscore.ts must keep pricing off the NET, and only a v2
// `split_off_def` feature flip on BOTH sides changes that. The build gate
// asserts neither module has learned these field names.

import type { PlayerRow, RawPlayer, RawPlayersFile } from "./types.ts";

export type PlayerSort = "net" | "off" | "def";

export const PLAYER_SORTS: PlayerSort[] = ["net", "off", "def"];

export function isPlayerSort(v: string | null | undefined): v is PlayerSort {
  return !!v && (PLAYER_SORTS as string[]).includes(v);
}

export const DEFAULT_PLAYER_SORT: PlayerSort = "net";

/** A player's net value per 36 minutes = his offence plus his defence. */
export function netOf(off: number, def: number): number {
  return off + def;
}

export interface RankedPlayer {
  athlete_id: number;
  tri: string;
  name: string;
  minutes: number;
  /** value_per36 — the net. Null for a player with no history to price. */
  net: number | null;
  off: number | null;
  def: number | null;
  ppg: number | null;
  rpg: number | null;
  apg: number | null;
  gp: number | null;
  /**
   * League rank under the active sort, 1-based. 0 means UNRANKED — either no
   * value estimate at all, or (under an off/def sort) no split to sort on.
   *
   * 🔴 This is a LEAGUE rank and it is computed before any filter runs, so
   * narrowing to one team shows that team's players at their real league
   * positions rather than renumbering them 1..15. The page is a league
   * ranking; a filter is a lens on it, not a different ranking.
   */
  rank: number;
  /** Below the bundle's own rotation floor — his rate rests on thin minutes. */
  thinMinutes: boolean;
}

function sortKey(p: RankedPlayer, sort: PlayerSort): number | null {
  if (sort === "off") return p.off;
  if (sort === "def") return p.def;
  return p.net;
}

/**
 * Rank every rostered player under one sort.
 *
 * Returns ALL of them: the rankable ones first, in descending order of the
 * sort key with dense ranks 1..n, then the unrankable ones (rank 0) by
 * minutes. Nobody is dropped — a player the model cannot price is a fact about
 * the model, and hiding him would make the roster counts stop matching
 * /hoops/teams.
 *
 * `rotationFloorMinutes` is the bundle's own `absorption_rotation_floor_minutes`
 * constant, passed in rather than hardcoded (null = the bundle didn't carry it,
 * in which case nobody is flagged).
 */
export function rankPlayers(
  rows: PlayerRow[],
  sort: PlayerSort,
  rotationFloorMinutes: number | null,
): RankedPlayer[] {
  const all: RankedPlayer[] = rows.map((r) => ({
    athlete_id: r.athlete_id,
    tri: r.tri,
    name: r.name,
    minutes: r.minutes,
    net: r.value_per36,
    off: r.value_off_per36,
    def: r.value_def_per36,
    ppg: r.game_rates?.pts ?? null,
    rpg: r.game_rates?.reb ?? null,
    apg: r.game_rates?.ast ?? null,
    gp: r.game_rates?.gp ?? null,
    rank: 0,
    thinMinutes: rotationFloorMinutes != null && r.minutes < rotationFloorMinutes,
  }));

  const rankable = all.filter((p) => sortKey(p, sort) != null);
  const unrankable = all.filter((p) => sortKey(p, sort) == null);

  rankable.sort((a, b) => {
    const d = (sortKey(b, sort) as number) - (sortKey(a, sort) as number);
    // Ties broken by minutes then name so the order is total and stable —
    // two players on the same rounded value must not swap between renders.
    if (d !== 0) return d;
    if (b.minutes !== a.minutes) return b.minutes - a.minutes;
    return a.name.localeCompare(b.name);
  });
  rankable.forEach((p, i) => {
    p.rank = i + 1;
  });

  unrankable.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));

  return [...rankable, ...unrankable];
}

export interface PlayerFilter {
  /** A tri code, or null for the whole league. */
  team?: string | null;
  /** Drop anyone below the bundle's rotation floor. */
  rotationOnly?: boolean;
}

/** Narrow a ranked list. Never re-ranks — see RankedPlayer.rank. */
export function filterPlayers(ranked: RankedPlayer[], filter: PlayerFilter): RankedPlayer[] {
  const team = filter.team ? filter.team.toUpperCase() : null;
  return ranked.filter((p) => {
    if (team && p.tri !== team) return false;
    if (filter.rotationOnly && p.thinMinutes) return false;
    return true;
  });
}

/**
 * Project the exporter's players file into read-model rows.
 *
 * Lives here, in the pure module, rather than inline in import.ts's insert
 * loop, so the build gate can drive the REAL projection over the REAL bundle
 * instead of asserting against a copy of it. This is the function that decides
 * whether the off/def split survives the trip from JSON into SQLite — which is
 * precisely the thing that was silently NOT happening before this milestone.
 */
export function playerRowsFromBundle(file: RawPlayersFile): PlayerRow[] {
  return file.players.map(playerRowOf);
}

export function playerRowOf(p: RawPlayer): PlayerRow {
  return {
    athlete_id: p.athlete_id,
    nba_player_id: p.nba_player_id ?? null,
    tri: p.team,
    name: p.name,
    minutes: p.minutes,
    value_per36: p.value_per36 ?? null,
    value_off_per36: p.value_off_per36 ?? null,
    value_def_per36: p.value_def_per36 ?? null,
    game_rates: p.game_rates ?? null,
    per36: p.per36 ?? null,
  };
}

/** How much of the league the model could actually price, for the honesty line. */
export interface ValueCoverage {
  total: number;
  valued: number;
  split: number;
  thin: number;
}

export function valueCoverage(ranked: RankedPlayer[]): ValueCoverage {
  return {
    total: ranked.length,
    valued: ranked.filter((p) => p.net != null).length,
    split: ranked.filter((p) => p.off != null && p.def != null).length,
    thin: ranked.filter((p) => p.thinMinutes).length,
  };
}

/** The sort control's labels and their on-screen explanations. */
export const SORT_COPY: Record<PlayerSort, { label: string; blurb: string }> = {
  net: {
    label: "Net",
    blurb:
      "Everything a player is worth per 36 minutes, offence and defence added together, against an average player.",
  },
  off: {
    label: "Offence",
    blurb:
      "The offensive half only — points per 36 minutes his offence is worth above an average player's.",
  },
  def: {
    label: "Defence",
    blurb:
      "The defensive half only. Higher is better here: it is points per 36 minutes he stops, so a rim protector reads big and positive.",
  },
};
