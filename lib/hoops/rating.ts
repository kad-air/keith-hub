// Pure rating helpers — no fs, no SQLite, no server-only imports.
//
// Deliberately separate from queries.ts so the teams client can re-rank every
// mode in the browser without a round trip (30 teams × up to 4 lenses is 240
// numbers; there is no reason to ask the server), and so a plain-node build
// check can drive these without a bundler to resolve the "@/" alias.

import { FRANCHISES } from "./nba-franchises.ts";
import type { RankedTeam, RatingMode, TeamRow } from "./types";
import { RATING_MODES } from "./types.ts";

export const FRANCHISE = FRANCHISES;

export function teamName(tri: string): string {
  return FRANCHISE[tri]?.name ?? tri;
}

/**
 * Team strength in points per 100 possessions.
 *
 * 🔴 `off - def`, not `off + def`. This is hoops-sim's own convention —
 * rosterratings.py: "off = +strength/2, def = -strength/2, so off - def =
 * strength" — and sim.py consumes the two halves separately as
 * `home_off + away_def`. A positive `def` means points ALLOWED above average.
 * Don't "fix" the minus sign.
 */
export function netOf(row: TeamRow, mode: RatingMode): number {
  const { off, def } = offDefOf(row, mode);
  return off - def;
}

/**
 * 🔴 `nightly` FALLS BACK TO THE BLEND when this bundle carries no nightly
 * read, rather than returning zeros. Every bundle published before hub-v2 has
 * none, and a team read as exactly 0/0 would rank mid-table and look like a
 * claim we made. The UI does not offer the lens in that case
 * (`availableRatingModes`), so this is belt and braces — but a shared link
 * carrying `?mode=nightly` can still reach it and must show something honest.
 */
export function offDefOf(row: TeamRow, mode: RatingMode): { off: number; def: number } {
  if (mode === "results") return { off: row.results_off, def: row.results_def };
  if (mode === "roster") return { off: row.roster_off, def: row.roster_def };
  if (mode === "nightly") {
    if (row.nightly_off == null || row.nightly_def == null) {
      return { off: row.blend_off, def: row.blend_def };
    }
    return { off: row.nightly_off, def: row.nightly_def };
  }
  return { off: row.blend_off, def: row.blend_def };
}

/**
 * Which rating lenses a given set of team rows can actually offer.
 *
 * 🔴 `nightly` is offered only when EVERY team has a read. A league table where
 * some teams are rated on the last ten games and others are not is not a
 * ranking of anything — it is two different questions in one column, and the
 * comparison a visitor makes between two rows would be meaningless.
 *
 * Pure, and here rather than in queries.ts, so the client can decide which
 * buttons to draw without a round trip and the build check can drive it
 * without a bundler.
 */
export function availableRatingModes(rows: TeamRow[]): RatingMode[] {
  const complete =
    rows.length > 0 && rows.every((t) => t.nightly_off != null && t.nightly_def != null);
  return complete ? [...RATING_MODES, "nightly"] : [...RATING_MODES];
}

/** Rank 30 teams by net strength under one rating mode. */
export function rankTeams(rows: TeamRow[], mode: RatingMode): RankedTeam[] {
  return rows
    .map((r) => {
      const { off, def } = offDefOf(r, mode);
      return {
        tri: r.tri,
        conference: r.conference,
        division: r.division,
        mode,
        off,
        def,
        net: netOf(r, mode),
        rank: 0,
        modeDisagreement: Math.abs(netOf(r, "results") - netOf(r, "roster")),
      };
    })
    .sort((a, b) => b.net - a.net)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

export interface ModeDisagreement {
  median: number;
  max: number;
  maxTeam: string;
}

/**
 * How far apart the two ratings are across the league right now, in points:
 * median and max of |results net − roster net|.
 *
 * The honest, *measured* stand-in for the plan's roster-churn caveat. The
 * export doesn't carry per-team churn, so rather than transcribe hoops-sim's
 * league figure (~3.1–3.3 pts post-B4b) as if it had been computed here, this
 * reads what today's bundle actually says.
 */
export function modeDisagreement(rows: TeamRow[]): ModeDisagreement {
  const deltas = rows
    .map((r) => ({ tri: r.tri, d: Math.abs(netOf(r, "results") - netOf(r, "roster")) }))
    .sort((a, b) => a.d - b.d);
  const mid = Math.floor(deltas.length / 2);
  const median =
    deltas.length % 2 === 0 ? (deltas[mid - 1].d + deltas[mid].d) / 2 : deltas[mid].d;
  const worst = deltas[deltas.length - 1];
  return { median, max: worst.d, maxTeam: worst.tri };
}

/** The ratings-mode caveat. Rendered on screen, never as a tooltip. */
export const MODE_COPY: Record<RatingMode, { label: string; blurb: string }> = {
  results: {
    label: "Results",
    blurb:
      "Prices a roster correctly once that roster has played. Its blindness is a latency, not a bias: a few games in-season, the entire summer in the offseason. Roster-blind — a trade that hasn't played a game doesn't move it.",
  },
  roster: {
    label: "Roster",
    blurb:
      "Bottom-up from today's roster, so it sees trades and signings immediately — at the cost of being noisier than the results rating.",
  },
  blend: {
    label: "Blend",
    blurb: "The fitted combination of the two, and the sane default.",
  },
  nightly: {
    label: "Nightly",
    blurb:
      "Who has actually been on the floor. Re-prices each team from the men who played its last ten games — so a star who has been out, or a rotation that has changed shape, shows up here before it shows up anywhere else — then mixes that with the season-long results rating at the weight five earlier seasons say works best. It is the only one of these four that has been measured to predict real game margins better than the rating it is built from.",
  },
};

export function fmtSigned(n: number, digits = 1): string {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}
