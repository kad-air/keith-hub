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

export type PlayerSort = "net" | "off" | "def" | "value";

export const PLAYER_SORTS: PlayerSort[] = ["value", "net", "off", "def"];

export function isPlayerSort(v: string | null | undefined): v is PlayerSort {
  return !!v && (PLAYER_SORTS as string[]).includes(v);
}

/** The ultimate fallback when a bundle carries no `value_pg` at all. See
 *  `defaultSortFor` for the coverage-aware default the page actually uses. */
export const DEFAULT_PLAYER_SORT: PlayerSort = "net";

/**
 * The sort the page should open on, absent an explicit `?sort=`.
 *
 * `value` (points of team margin per game — the stack rating times expected
 * minutes) is the more useful ranking whenever the bundle carries it, because
 * it is what a roster decision actually turns on; `net` (a rate) stays the
 * fallback for a bundle that predates the stack rating. Coverage-gated the
 * same way `hasSplit` gates the off/def sorts in PlayersClient — an explicit
 * `?sort=` from the URL always wins over this, this only fills in when none
 * was given.
 */
export function defaultSortFor(rows: PlayerRow[]): PlayerSort {
  return rows.some((r) => r.value_pg != null) ? "value" : DEFAULT_PLAYER_SORT;
}

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
   * `value_pg` — points of team margin per game vs. an average player
   * (`stack_net_per36 * expected_minutes / 36`, shipped pre-computed). Null
   * for a bundle that predates the stack rating, or a player it has no read
   * on.
   */
  valuePg: number | null;
  /**
   * `value_per_game_above_replacement` — the SAME quantity as `valuePg`, but
   * zeroed at a REPLACEMENT-level player (the last man a team could find)
   * instead of an average one (issue #70 F5). Null together with `valuePg`
   * being present is possible on an older bundle; the "value" sort and its
   * display fall back to `valuePg` with the old label whenever this is null.
   */
  valuePgAboveReplacement: number | null;
  /** hoops-sim's own expected-minutes-per-game input to `valuePg`. */
  expectedMinutes: number | null;
  /** e.g. "27719 poss (7yr)" or "prior only" — what the stack rating rests on. */
  evidence: string | null;
  /** The promoted 7-season stack rating, per-36 — same additive PLAYER sign
   *  convention as `off`/`def`/`net`, but a SEPARATE model. */
  stackNet: number | null;
  stackOff: number | null;
  stackDef: number | null;
  /** `value_per36_above_replacement` — `stackNet` above a replacement-level
   *  player instead of an average one (issue #70 F5). `stackOff`/`stackDef`
   *  stay average-referenced on purpose — a split of the rating, same
   *  convention real VORP/BPM use. Null on an older bundle or a player with
   *  no stack rating; readers fall back to `stackNet` with the old label. */
  stackNetAboveReplacement: number | null;
  /**
   * League rank under the active sort, 1-based. 0 means UNRANKED — either no
   * value estimate at all, or (under an off/def/value sort) no read to sort
   * on.
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

/**
 * The "value" sort's number, and the one the page displays for it: above
 * replacement when the bundle carries it, `valuePg` (average-zero) otherwise.
 * A plain `?? ` fallback rather than two separate sorts — issue #70 F5 is a
 * LEVEL SHIFT (every player's rate moves by the same constant), so ordering
 * is unaffected for the near-universal case where both are present.
 */
export function displayValuePg(p: Pick<RankedPlayer, "valuePg" | "valuePgAboveReplacement">): number | null {
  return p.valuePgAboveReplacement ?? p.valuePg;
}

/** Same idea, for the stack rating's per-36 headline (a team page's "Rate"
 *  column) — above replacement when the bundle carries it, `stackNet`
 *  (average-zero) otherwise. */
export function displayStackNet(
  p: Pick<RankedPlayer, "stackNet" | "stackNetAboveReplacement">,
): number | null {
  return p.stackNetAboveReplacement ?? p.stackNet;
}

function sortKey(p: RankedPlayer, sort: PlayerSort): number | null {
  if (sort === "off") return p.off;
  if (sort === "def") return p.def;
  if (sort === "value") return displayValuePg(p);
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
    valuePg: r.value_pg,
    valuePgAboveReplacement: r.value_per_game_above_replacement,
    expectedMinutes: r.expected_minutes,
    evidence: r.evidence,
    stackNet: r.stack_net_per36,
    stackOff: r.stack_off_per36,
    stackDef: r.stack_def_per36,
    stackNetAboveReplacement: r.value_per36_above_replacement,
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
    stack_net_per36: p.stack_net_per36 ?? null,
    stack_off_per36: p.stack_off_per36 ?? null,
    stack_def_per36: p.stack_def_per36 ?? null,
    expected_minutes: p.expected_minutes ?? null,
    value_pg: p.value_pg ?? null,
    evidence: p.evidence ?? null,
    value_per36_above_replacement: p.value_per36_above_replacement ?? null,
    value_per_game_above_replacement: p.value_per_game_above_replacement ?? null,
    explain: p.explain ?? null,
  };
}

/** How much of the league the model could actually price, for the honesty line. */
export interface ValueCoverage {
  total: number;
  valued: number;
  split: number;
  thin: number;
  /** Players carrying a `value_pg` read — the stack rating's own coverage,
   *  independent of `valued`/`split` (the pre-existing flagship model). */
  valuePg: number;
}

export function valueCoverage(ranked: RankedPlayer[]): ValueCoverage {
  return {
    total: ranked.length,
    valued: ranked.filter((p) => p.net != null).length,
    split: ranked.filter((p) => p.off != null && p.def != null).length,
    thin: ranked.filter((p) => p.thinMinutes).length,
    valuePg: ranked.filter((p) => p.valuePg != null).length,
  };
}

/** The sort control's labels and their on-screen explanations. */
/**
 * The button copy for each sort. `short` is the phone-width label — four
 * buttons of "Value/G / Net / Offence / Defence" run off a 375px screen, and
 * "Off"/"Def" are what a coach would write on a whiteboard anyway. Copy only:
 * the keys, the blurbs and every number behind them are untouched.
 */
export const SORT_COPY: Record<PlayerSort, { label: string; short: string; blurb: string }> = {
  value: {
    label: "Value/G",
    short: "Val/G",
    blurb:
      "Points of team margin per game vs. an average player — the stack rating times how many minutes he's expected to play, divided by 36. This is what a roster decision actually turns on.",
  },
  // Nothing above rewritten: this is the OLD, average-zero wording, and it
  // stays live as the fallback for a bundle without value_per_game_above_
  // replacement — see valueSortBlurb below, which is what the page actually
  // prints.
  net: {
    label: "Net",
    short: "Net",
    blurb:
      "Everything a player is worth per 36 minutes, offence and defence added together, against an average player.",
  },
  off: {
    label: "Offence",
    short: "Off",
    blurb:
      "The offensive half only — points per 36 minutes his offence is worth above an average player's.",
  },
  def: {
    label: "Defence",
    short: "Def",
    blurb:
      "The defensive half only. Higher is better here: it is points per 36 minutes he stops, so a rim protector reads big and positive.",
  },
};

/**
 * The blurb the page actually prints under the "value" sort button — the
 * OWNER'S 2026-09-03 decision that 0 should mean a replacement-level player,
 * not an average one (issue #70 F5, hoops-sim's `replacement-zero.md`). Off/
 * def stay average-referenced on purpose — a split of the rating, the same
 * convention real VORP/BPM use, and untouched here. Falls back to
 * `SORT_COPY.value.blurb` (the OLD, average-zero wording) whenever the bundle
 * carries no `value_per_game_above_replacement` reads at all, so an older
 * bundle never shows a promise this page cannot keep.
 */
export function valueSortBlurb(hasAboveReplacement: boolean): string {
  if (!hasAboveReplacement) return SORT_COPY.value.blurb;
  return (
    "Points of team margin per game above a REPLACEMENT-level player — the last man a team " +
    "could realistically find, not an average NBA player — the stack rating above replacement " +
    "times how many minutes he's expected to play, divided by 36. Zero means replacement level. " +
    "This is what a roster decision actually turns on."
  );
}
