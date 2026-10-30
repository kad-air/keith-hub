/**
 * WHAT MOVED — the pure half of the team page's "What moved" card.
 *
 * Owns two things, so the build gate (`scripts/check-hoops-movers.ts`) can
 * drive the REAL code rather than a copy of it:
 *
 *   1. `moversFromRow` — turning a `hoops_teams` row into a `TeamMovers` view
 *      (the read half of `getTeamMovers` in queries.ts, which plain node
 *      cannot import because of the `@/` alias);
 *   2. `whatMovedCopy` — every line of text the card says, as data. The page
 *      renders exactly what comes back and carries no copy or branch logic of
 *      its own.
 *
 * 🔴 EARLY SEASON (2026-10-30, owner: "this should be early movement versus
 * last year until we have the appropriate sample size"). With 4–5 games played
 * the "last ten" and "season-typical" halves of the decomposition read the SAME
 * games, so every card shipped all zeros — "0 men moved it; these are the
 * biggest", Doncic "playing less — 28.4 min a night against 28.4 on the
 * season". The sender now says which BASELINE it compared against, and the copy
 * follows it:
 *
 *   `season_typical` — the team has played ≥ 10 games; the card as it was.
 *   `last_season`    — fewer than 10: this season's games so far against each
 *                      man's minutes a night across LAST season's schedule, on
 *                      any team. A rookie or a man who sat out last year has
 *                      no such minutes and arrives as direction `new`.
 *
 * and whether anything moved at all (`movers_state`): `nothing_moved` is ONE
 * plain line, never an empty list with a sentence about "these 0".
 *
 * Backward compatible by construction: a row written from a bundle that
 * predates the fields reads as `season_typical` / `moved`, which is what every
 * such bundle was.
 *
 * Imports NOTHING but types — keep it that way (the `pages.ts` lesson).
 */

import type { RawNightlyMover } from "./types.ts";

export type MoversBaseline = "season_typical" | "last_season";
export type MoversState = "moved" | "nothing_moved";

/** One team's "what moved": the whole gap between its nightly read and the
 *  same men priced off the baseline minutes, and the men most responsible. */
export interface TeamMovers {
  /** Which minutes the nightly read was compared against (see the header). */
  baseline: MoversBaseline;
  /** Whether anything moved at all. `nothing_moved` ⇒ `movers` is empty. */
  state: MoversState;
  /** Games this team has played this season — the "first N games" of the
   *  early-season sentence. Null on a row from before it was stored. */
  gamesPlayed: number | null;
  /** The team's WHOLE gap, points a game, before the mix with the season-long
   *  rating. The FULL decomposition sums to this; the shown movers do not. */
  deltaPreMix: number;
  /** deltaPreMix × (1 − results_w): the share of it inside the nightly number. */
  deltaPostMix: number;
  /** How many men moved the team by at least a hundredth of a point a game. */
  nMoversTotal: number;
  /** The sum over the SHOWN movers only — so the page can say "these three
   *  account for X of the Y" without implying the three are the whole story. */
  moversDeltaSum: number;
  movers: RawNightlyMover[];
}

/** The `hoops_teams` columns the view is built from — getTeamMovers' SELECT. */
export interface MoverRow {
  nightly_movers_json: string | null;
  nightly_delta_pre_mix: number | null;
  nightly_delta_post_mix: number | null;
  nightly_n_movers_total: number | null;
  nightly_movers_delta_sum: number | null;
  nightly_movers_baseline?: string | null;
  nightly_movers_state?: string | null;
  nightly_games_played?: number | null;
}

const BASELINES: ReadonlySet<string> = new Set<MoversBaseline>(["season_typical", "last_season"]);
const STATES: ReadonlySet<string> = new Set<MoversState>(["moved", "nothing_moved"]);

/**
 * The view for one team, or null when this bundle has none for it — an older
 * bundle, or (the case that matters) a team the nightly read abstained on,
 * where nothing was re-priced and so nothing moved. Null, never an empty list:
 * "nobody moved" and "we never looked" are different sentences — and a stored
 * `nothing_moved` is the FIRST of those, so it renders even when the sender
 * left the list out rather than shipping it empty.
 *
 * An unknown baseline or state string (a sender ahead of this receiver) falls
 * back to the old reading rather than refusing to render the card.
 */
export function moversFromRow(row: MoverRow | null | undefined): TeamMovers | null {
  if (!row) return null;
  const state: MoversState =
    row.nightly_movers_state != null && STATES.has(row.nightly_movers_state)
      ? (row.nightly_movers_state as MoversState)
      : "moved";
  const baseline: MoversBaseline =
    row.nightly_movers_baseline != null && BASELINES.has(row.nightly_movers_baseline)
      ? (row.nightly_movers_baseline as MoversBaseline)
      : "season_typical";
  const nothing = state === "nothing_moved";
  if (!row.nightly_movers_json && !nothing) return null;
  if ((row.nightly_delta_pre_mix == null || row.nightly_delta_post_mix == null) && !nothing) {
    return null;
  }
  const movers = row.nightly_movers_json
    ? (JSON.parse(row.nightly_movers_json) as RawNightlyMover[])
    : [];
  return {
    baseline,
    state,
    gamesPlayed: row.nightly_games_played ?? null,
    deltaPreMix: row.nightly_delta_pre_mix ?? 0,
    deltaPostMix: row.nightly_delta_post_mix ?? 0,
    nMoversTotal: row.nightly_n_movers_total ?? 0,
    moversDeltaSum: row.nightly_movers_delta_sum ?? 0,
    // 🔴 Nothing moved ⇒ nothing to list, whatever the sender put in the blob.
    movers: nothing ? [] : movers,
  };
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

/** A run of text, or a number the page sets in the mono face. `tone: "dim"`
 *  is the gap read against the team (worse), as the card has always drawn it. */
export type Segment = string | { mono: string; tone?: "bright" | "dim" };

/** Plain text of a segment list — what the card says, for the gate and for
 *  anyone reading it without the styling. */
export function flat(segments: readonly Segment[]): string {
  return segments.map((s) => (typeof s === "string" ? s : s.mono)).join("");
}

export interface WhatMovedContext {
  tri: string;
  /** The nightly window, `nightly_last_n_games` — 10. */
  lastNGames: number;
  /** `nightly_league_typical_shift`, or null on a bundle that predates it. */
  leagueShift: number | null;
}

/**
 * Everything the card says. The page renders each non-null field and nothing
 * else — so `nothing_moved` is exactly `nothing`, with `lead`, `rows`,
 * `accounts` and `drift` all empty, and no sentence can mention "these 0".
 */
export interface WhatMovedCopy {
  /** The one plain line when nothing has moved. Every other field is empty. */
  nothing: string | null;
  lead: Segment[] | null;
  rows: Array<{ mover: RawNightlyMover; phrase: string }>;
  accounts: Segment[] | null;
  drift: Segment[] | null;
}

export const NOTHING_MOVED_LINE = "Nothing has moved this team’s number yet.";

export function whatMovedCopy(view: TeamMovers, ctx: WhatMovedContext): WhatMovedCopy {
  if (view.state === "nothing_moved") {
    return { nothing: NOTHING_MOVED_LINE, lead: null, rows: [], accounts: null, drift: null };
  }
  return {
    nothing: null,
    lead: leadSentence(view, ctx),
    rows: view.movers.map((mover) => ({ mover, phrase: moverPhrase(mover, view.baseline, ctx.lastNGames) })),
    accounts: accountsSentence(view),
    drift: ctx.leagueShift == null ? null : driftSentence(ctx.leagueShift, view.baseline, ctx.lastNGames),
  };
}

function signed(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

function men(n: number): string {
  return n === 1 ? "1 man" : `${n} men`;
}

function games(n: number): string {
  return n === 1 ? "first game" : `first ${n} games`;
}

function leadSentence(view: TeamMovers, ctx: WhatMovedContext): Segment[] {
  const gap = view.deltaPreMix;
  const worse = gap < 0;
  const gapSeg: Segment = { mono: Math.abs(gap).toFixed(1), tone: worse ? "dim" : "bright" };
  const better = worse ? "worse" : "better";
  const biggest = `${men(view.nMoversTotal)} moved it; these are the biggest.`;
  if (view.baseline === "last_season") {
    // 🔴 Early season. Not "last 10 games" — the team has played fewer than
    // that, and the comparison is against LAST season, not its own average.
    const played =
      view.gamesPlayed != null && view.gamesPlayed > 0 ? games(view.gamesPlayed) : "games so far";
    return [
      `Early season: priced off the men who have played ${ctx.tri}’s ${played}, this team reads `,
      gapSeg,
      ` points a game ${better} than the same men at their minutes last season. ${biggest}`,
    ];
  }
  return [
    `Priced off the men who have actually played ${ctx.tri}’s last ${ctx.lastNGames} games, this team reads `,
    gapSeg,
    ` points a game ${better} than the same roster at its season-typical minutes. ${biggest}`,
  ];
}

function accountsSentence(view: TeamMovers): Segment[] {
  const n = view.movers.length;
  return [
    `${n === 1 ? "That man accounts" : `Those ${n} account`} for `,
    { mono: signed(view.moversDeltaSum, 1) },
    " of the ",
    { mono: signed(view.deltaPreMix, 1) },
    ". Blending with the season-long results rating keeps ",
    { mono: signed(view.deltaPostMix, 1) },
    " of it inside the Nightly number.",
  ];
}

function driftSentence(shift: number, baseline: MoversBaseline, lastNGames: number): Segment[] {
  const than =
    baseline === "last_season"
      ? "off this season’s games so far than off last season"
      : `off its last ${lastNGames} games than off the full season`;
  return [
    "Every team drifts a little: the league as a whole reads ",
    { mono: Math.abs(shift).toFixed(1) },
    ` points a game ${shift < 0 ? "lower" : "higher"} ${than}, because injuries and rest pile up. ` +
      "That drift sits under all thirty teams and is charged to nobody here.",
  ];
}

/**
 * The direction as a sentence a broadcast could say out loud.
 *
 * 🔴 `back` is an AVAILABILITY word, not a minutes word: his minutes may be up
 * or down; what is up is that he is playing at all. 🔴 `out` is "did not
 * play", never a minutes dip. 🔴 Equal minutes are never "playing less" — the
 * sender ships those as `same` now (and never ships a 0.00 row), and an older
 * bundle's up/down at equal rounded minutes reads the same way here.
 */
export function moverPhrase(m: RawNightlyMover, baseline: MoversBaseline, lastNGames: number): string {
  const now = m.minutes_last_n.toFixed(1);
  const usual = m.minutes_typical.toFixed(1);
  const equal = now === usual;
  const last = baseline === "last_season";
  // What the typical half IS: his own season on the old card, last season on
  // the early one.
  const against = last ? `against ${usual} last season` : `against ${usual} on the season`;
  switch (m.direction) {
    case "out": {
      if (last) return `hasn’t played yet — ${usual} min a night last season`;
      // Not "0 minutes lately" — the sentence people say is that he is out.
      const played =
        m.games_played_of_last_n === 0
          ? `none of the last ${lastNGames}`
          : `${m.games_played_of_last_n} of the last ${lastNGames}`;
      return `out — played ${played}, after ${usual} min a night on the season`;
    }
    case "back": {
      if (last) return `back — ${now} min a night ${against}`;
      const played =
        m.games_played_of_last_n === 0 ? "none" : `${m.games_played_of_last_n} of the last ${lastNGames}`;
      return `back — played ${played}, ${now} min a night ${against}`;
    }
    case "up":
      if (equal) return `same minutes — ${now} a night`;
      return `playing more — ${now} min a night ${against}`;
    case "down":
      if (equal) return `same minutes — ${now} a night`;
      return `playing less — ${now} min a night ${against}`;
    case "same":
      return `same minutes — ${now} a night`;
    case "new":
      // No last-season minutes to compare: a rookie, or a man who sat the year.
      return `new this year — ${now} min a night`;
    case "absorbed":
      return `the minutes an absence left behind — ${now} a night ${against}`;
  }
}
