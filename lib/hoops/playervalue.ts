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

// ───────────────────────────────────────────────────────────────────────────
// REPLACEMENT-ZERO, round 2 (issue #70 F5, owner decision 2026-09-04: "one
// scale on every player surface" — a replacement-level player must read
// 0.00 everywhere a player's LEVEL is shown, not just the two headline
// fields the first round added). ONE helper does the shift; every surface
// that shows a player's level calls it, never a second implementation.
//
// A replacement-level player has his OWN off/def split, exactly like any
// other player's: `hoops-sim`'s own `off = (net + tilt) / 2, def = (net -
// tilt) / 2` (rosterratings.py, the SPLIT team-pricing section — the same
// formula that reconstructs any unknown player's off/def from his net and
// his lean). `replacement_tilt_per36` is that lean for a replacement-level
// player specifically. off_repl + def_repl == replacement_per36 EXACTLY
// (proven by the formula, asserted live in check-hoops-explain.ts).
// ───────────────────────────────────────────────────────────────────────────

export interface ReplacementLevels {
  net: number;
  off: number;
  def: number;
}

/**
 * The three replacement levels this bundle implies, or null when the bundle
 * predates `replacement_tilt_per36` — callers MUST treat null as "cannot
 * shift, render the old way," never guess a tilt of 0 (a real basketball
 * claim: 0 would say a replacement player has no offence/defence lean at
 * all, which is not measured, just unavailable here).
 */
export function replacementLevelsOf(
  replacementPer36: number,
  replacementTiltPer36: number | null,
): ReplacementLevels | null {
  if (replacementTiltPer36 == null) return null;
  return {
    net: replacementPer36,
    off: (replacementPer36 + replacementTiltPer36) / 2,
    def: (replacementPer36 - replacementTiltPer36) / 2,
  };
}

/**
 * Shift a per-36 LEVEL onto the "0 = replacement player" scale. `side`
 * selects which of the three replacement levels to subtract.
 *
 * 🔴 LEVELS ONLY, NEVER DELTAS. A level is a player's standing rate (his box
 * score's worth, his plus-minus history, his rating) — subtracting a
 * constant from it is the whole point. A delta is a DIFFERENCE that already
 * has no reference point (aging's year-older offset, what the tape moved him
 * by, a wage-sheet item's contrib) — passing one through this function would
 * subtract a level from a difference, a unit error. See
 * `lib/hoops/compare.ts`'s `shiftExplainToReplacement` for which of the
 * explain ledger's rows are which.
 */
export function toReplacementScale(
  side: "off" | "def" | "net",
  value: number,
  levels: ReplacementLevels,
): number {
  return value - levels[side];
}

export interface StackDisplay {
  net: number | null;
  off: number | null;
  def: number | null;
  valuePg: number | null;
}

/**
 * The stack rating's headline (Rate/36, off/def, Value/game) for ONE player
 * row, on whichever scale is live — used by the player detail page AND the
 * side-by-side comparison, so the two can never quote different numbers for
 * the same man. `levels` null (an older bundle) reproduces the exact
 * pre-issue-#70-F5 numbers, including the exact shipped `value_pg` rather
 * than a re-derived one.
 */
export function stackDisplay(
  r: Pick<
    PlayerRow,
    "stack_net_per36" | "stack_off_per36" | "stack_def_per36" | "value_per36" | "value_pg" | "expected_minutes" | "minutes"
  >,
  levels: ReplacementLevels | null,
): StackDisplay {
  const netRaw = r.stack_net_per36 ?? r.value_per36;
  const net = netRaw != null && levels != null ? toReplacementScale("net", netRaw, levels) : netRaw;
  const off =
    r.stack_off_per36 != null && levels != null
      ? toReplacementScale("off", r.stack_off_per36, levels)
      : r.stack_off_per36;
  const def =
    r.stack_def_per36 != null && levels != null
      ? toReplacementScale("def", r.stack_def_per36, levels)
      : r.stack_def_per36;
  const minutesBasis = r.expected_minutes ?? r.minutes;
  const valuePg = levels == null ? r.value_pg : net != null ? (net * minutesBasis) / 36 : null;
  return { net, off, def, valuePg };
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
   * `value_pg` — points of team margin per game (`stack_net_per36 *
   * expected_minutes / 36`). Null for a bundle that predates the stack
   * rating, or a player it has no read on.
   *
   * 🔴 The SCALE depends on whether `rankPlayers` was given `levels`: with
   * levels, this (and `net`/`off`/`def`/`stackNet`/`stackOff`/`stackDef`
   * below) already read ABOVE REPLACEMENT — a replacement-level player's own
   * numbers come back exactly 0.00 — because `rankPlayers` shifts them once,
   * at construction, via the SAME `toReplacementScale` every other surface
   * uses.
   *
   * 🔴 UNLIKE the per-36 rates, the "value" (per-game) ORDER genuinely
   * changes under the shift, and that is correct, not a bug: `value_pg =
   * (net − replacement) × minutes / 36`, so subtracting the (negative)
   * replacement level hands every player a bonus proportional to HIS OWN
   * minutes — a heavy-minutes average starter gains far more than a
   * lightly-used bench man with a hot rate. Measured on the real bundle:
   * 440 of ~500 rankable players change rank once "value" is priced above
   * replacement. This is exactly why real VORP re-ranks a per-minute rate
   * stat substantially, and it is the whole point of pricing by MINUTES
   * PLAYED, not a defect to guard against.
   */
  valuePg: number | null;
  /** hoops-sim's own expected-minutes-per-game input to `valuePg`. */
  expectedMinutes: number | null;
  /** e.g. "27719 poss (7yr)" or "prior only" — what the stack rating rests on. */
  evidence: string | null;
  /** The promoted 7-season stack rating, per-36 — same additive PLAYER sign
   *  convention as `off`/`def`/`net`, but a SEPARATE model. See the note on
   *  `valuePg` above for which scale this reads on. */
  stackNet: number | null;
  stackOff: number | null;
  stackDef: number | null;
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

function sortKey(p: RankedPlayer, sort: PlayerSort): number | null {
  if (sort === "off") return p.off;
  if (sort === "def") return p.def;
  if (sort === "value") return p.valuePg;
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
 *
 * `levels` (default null = the pre-issue-#70-F5 behaviour, bit-identical):
 * when supplied, every LEVEL field on the returned `RankedPlayer`s
 * (`net`/`off`/`def`/`stackNet`/`stackOff`/`stackDef`/`valuePg`) is shifted
 * onto the replacement scale ONCE, here, via `toReplacementScale` — so every
 * caller downstream (a sort, a display, a league rank) reads ONE consistent
 * number instead of each re-deriving its own.
 *
 * 🔴 Ordering is unaffected ONLY for the three per-36 RATE sorts
 * (`net`/`off`/`def`): subtracting the same constant from every player's
 * rate can never swap who is ahead of whom. The "value" (per-game) sort is
 * NOT invariant — see `RankedPlayer.valuePg`'s own doc comment for why that
 * is correct, not a bug (minutes-weighted, so a shift changes who benefits
 * most). Either way, `rankPlayers` re-ranks fresh under whichever `sort` is
 * passed, so this never produces a stale order for "value".
 */
export function rankPlayers(
  rows: PlayerRow[],
  sort: PlayerSort,
  rotationFloorMinutes: number | null,
  levels: ReplacementLevels | null = null,
): RankedPlayer[] {
  const shift = (side: "off" | "def" | "net", v: number | null): number | null =>
    v == null || levels == null ? v : toReplacementScale(side, v, levels);

  const all: RankedPlayer[] = rows.map((r) => {
    const stackNet = shift("net", r.stack_net_per36);
    return {
      athlete_id: r.athlete_id,
      tri: r.tri,
      name: r.name,
      minutes: r.minutes,
      net: shift("net", r.value_per36),
      off: shift("off", r.value_off_per36),
      def: shift("def", r.value_def_per36),
      ppg: r.game_rates?.pts ?? null,
      rpg: r.game_rates?.reb ?? null,
      apg: r.game_rates?.ast ?? null,
      gp: r.game_rates?.gp ?? null,
      // 🔴 Bit-identical to before when `levels` is null: the exact SHIPPED
      // `r.value_pg`, never re-derived. Only when actually shifting do we
      // recompute — from the (just-shifted) stackNet and the same minutes/36
      // arithmetic value_pg has always used — because there is no shipped
      // "value_pg above replacement, on this exact scale" field to read for
      // an arbitrary shift; this keeps it GUARANTEED consistent with
      // stackNet above rather than inventing a second source for one fact.
      valuePg:
        levels == null
          ? r.value_pg
          : stackNet != null && r.expected_minutes != null
            ? (stackNet * r.expected_minutes) / 36
            : null,
      expectedMinutes: r.expected_minutes,
      evidence: r.evidence,
      stackNet,
      stackOff: shift("off", r.stack_off_per36),
      stackDef: shift("def", r.stack_def_per36),
      rank: 0,
      thinMinutes: rotationFloorMinutes != null && r.minutes < rotationFloorMinutes,
    };
  });

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

/** The sort control's labels — unaffected by which scale is active. `short`
 *  is the phone-width label — four buttons of "Value/G / Net / Offence /
 *  Defence" run off a 375px screen, and "Off"/"Def" are what a coach would
 *  write on a whiteboard anyway. */
export const SORT_LABELS: Record<PlayerSort, { label: string; short: string }> = {
  value: { label: "Value/G", short: "Val/G" },
  net: { label: "Net", short: "Net" },
  off: { label: "Offence", short: "Off" },
  def: { label: "Defence", short: "Def" },
};

/**
 * `SORT_COPY[sort].blurb` — kept for backward compatibility (a bundle with no
 * replacement scale at all renders exactly this, unchanged). Superseded by
 * `sortBlurb` below wherever a page knows whether the replacement scale is
 * live; new code should call that, not this, directly.
 */
export const SORT_COPY: Record<PlayerSort, { label: string; short: string; blurb: string }> = {
  value: {
    ...SORT_LABELS.value,
    blurb:
      "Points of team margin per game vs. an average player — the stack rating times how many minutes he's expected to play, divided by 36. This is what a roster decision actually turns on.",
  },
  net: {
    ...SORT_LABELS.net,
    blurb:
      "Everything a player is worth per 36 minutes, offence and defence added together, against an average player.",
  },
  off: {
    ...SORT_LABELS.off,
    blurb:
      "The offensive half only — points per 36 minutes his offence is worth above an average player's.",
  },
  def: {
    ...SORT_LABELS.def,
    blurb:
      "The defensive half only. Higher is better here: it is points per 36 minutes he stops, so a rim protector reads big and positive.",
  },
};

/**
 * The blurb a page actually prints under a sort button — the OWNER'S
 * 2026-09-04 decision that 0 should mean a REPLACEMENT-level player
 * everywhere a player's level is shown, not just the "value" headline round 1
 * shipped (issue #70 F5 round 2: "he saw the ledger... and, correctly, read
 * the page as still average-zero with a conversion bolted on" — one scale,
 * not two). Falls back to `SORT_COPY[sort].blurb` (the OLD, average-zero
 * wording) whenever `hasReplacementScale` is false, so a bundle without
 * `replacement_tilt_per36` never shows a promise the page cannot keep.
 */
export function sortBlurb(sort: PlayerSort, hasReplacementScale: boolean): string {
  if (!hasReplacementScale) return SORT_COPY[sort].blurb;
  switch (sort) {
    case "value":
      return (
        "Points of team margin per game above a REPLACEMENT-level player — the last man a team " +
        "could realistically find — the stack rating times how many minutes he's expected to " +
        "play, divided by 36. This is what a roster decision actually turns on."
      );
    case "net":
      return (
        "Everything a player is worth per 36 minutes, offence and defence added together, above " +
        "a REPLACEMENT-level player — the last man a team could realistically find."
      );
    case "off":
      return (
        "The offensive half only — points per 36 minutes his offence is worth above a " +
        "replacement-level player's."
      );
    case "def":
      return (
        "The defensive half only, above a replacement-level player. Higher is better here: it is " +
        "points per 36 minutes he stops beyond what the last man a team could find would."
      );
  }
}
