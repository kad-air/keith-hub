// The box score as of a moment — pure: no fetch, no DOM, no storage.
//
// Spoiler mode holds the game page's box score to the viewer's synced moment
// (owner, 2026-10-28). ESPN serves only the live box, so the held one is
// REBUILT from the play-by-play up to the moment (spoiler.ts `playsAt`): every
// counting stat is a sentence in a play ("Keyonte George makes 13-foot two
// point shot (Ace Bailey assists)"), and the actor is found by matching the
// line's leading words against the box's own roster names.
//
// 🔴 Only what the plays settle exactly is rebuilt. The gate
// (check:hoops:scores §12) rebuilds two recorded games from ALL their plays
// and requires every player's rebuilt line to equal ESPN's own box score,
// column by column. Minutes and plus-minus are NOT in that set — the feed
// carries no lineups at a quarter's start, so who was on the floor between
// substitutions is an inference — and so a held box prints neither (the
// columns are blank, never a live figure). The roster itself (who started,
// who is listed) comes from the live box; who has PLAYED by the moment comes
// from the plays, so a bench player's first entrance doesn't show early.
//
// 🔴 Errs toward showing less: a play whose actor can't be matched to the
// roster credits no player (the team row still counts its points, off the
// play's own cumulative score at the moment, never off the live total).

import type { Play, PlayerBoxLine, TeamBoxScore, TeamTotals } from "./types.ts";

const ZERO: TeamTotals = {
  pts: 0, reb: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0,
  fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
};

/** Columns a held box can print: every counting stat. MIN and +/- can't be
 *  rebuilt exactly from the plays (see the header). */
export const HELD_BLANK = ["MIN", "+/-"] as const;

interface Roster {
  /** Longest name first, so "Jaren Jackson Jr." wins over a shorter prefix. */
  names: { name: string; key: string }[];
}

function rosterOf(teams: TeamBoxScore[]): Roster {
  const names = teams
    .flatMap((t) => t.players.map((p) => ({ name: p.name, key: `${t.tri}|${p.id || p.name}` })))
    .sort((a, b) => b.name.length - a.name.length);
  return { names };
}

/** The roster key of the player whose name `s` starts with, and the rest. */
function lead(r: Roster, s: string): { key: string; rest: string } | null {
  for (const n of r.names) {
    if (s.startsWith(n.name) && (s.length === n.name.length || /[\s']/.test(s[n.name.length]))) {
      return { key: n.key, rest: s.slice(n.name.length) };
    }
  }
  return null;
}

/** The player named inside "(… assists)" / "(… steals)". */
function inParens(r: Roster, s: string, word: "assists" | "steals"): string | null {
  const m = new RegExp(`\\(([^()]+) ${word}\\)`).exec(s);
  return m ? (lead(r, m[1].trim())?.key ?? null) : null;
}

/** A three: the play's own attempt value when the source gives it, else the
 *  text — "three point" is on most threes, but not on every one. */
function isThree(p: Play, text: string): boolean {
  if (p.pointsAttempted === 3) return true;
  if (p.pointsAttempted === 2) return false;
  return /three point|three pointer/i.test(text);
}

/** `first`: the index of the play a player first appears in (−1: not yet). */
type Line = TeamTotals & { appeared: boolean; first: number };

/**
 * Rebuild every player's counting stats from `plays` (game order, already cut
 * at the moment). Returns the same teams in the same order with min and
 * plusMinus blanked (0 / null — see HELD_BLANK), and anyone who hasn't yet
 * appeared in a play (and didn't start) marked `dnp` — "not in yet".
 */
export function boxFromPlays(teams: TeamBoxScore[], plays: Play[]): TeamBoxScore[] {
  const r = rosterOf(teams);
  const lines = new Map<string, Line>();
  const at = (key: string): Line => {
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { ...ZERO, appeared: false, first: -1 }));
    return l;
  };
  let i = -1;
  const seen = (l: Line) => {
    if (!l.appeared) l.first = i;
    l.appeared = true;
  };
  const touch = (key: string | null) => {
    if (key) seen(at(key));
  };

  for (const p of plays) {
    i++;
    const text = p.text.replace(/\s+/g, " ").trim();
    const actor = lead(r, text);

    // "B blocks A 's 7-foot driving layup" — A's missed attempt, B's block.
    const blk = actor && /^ blocks /.exec(actor.rest);
    if (actor && blk) {
      at(actor.key).blk++;
      touch(actor.key);
      const shooter = lead(r, actor.rest.slice(" blocks ".length));
      if (shooter) {
        const s = at(shooter.key);
        seen(s);
        s.fga++;
        if (isThree(p, shooter.rest)) s.tpa++;
      }
      continue;
    }
    if (!actor) continue;
    const a = at(actor.key);
    seen(a);
    const rest = actor.rest;

    const shot = /^ (makes|misses) /.exec(rest);
    if (shot) {
      const made = shot[1] === "makes";
      if (/free throw/i.test(rest)) {
        a.fta++;
        if (made) {
          a.ftm++;
          a.pts++;
        }
      } else {
        // A missed end-of-period heave is not a field-goal attempt (ESPN's
        // box leaves it out, matching the league's rule); a made one counts.
        if (!made && /\bheave\b/i.test(rest)) continue;
        const three = isThree(p, rest);
        a.fga++;
        if (three) a.tpa++;
        if (made) {
          a.fgm++;
          if (three) a.tpm++;
          a.pts += three ? 3 : 2;
          const ast = inParens(r, rest, "assists");
          if (ast) {
            at(ast).ast++;
            touch(ast);
          }
        }
      }
      continue;
    }
    if (/^ offensive rebound\b/i.test(rest)) {
      a.oreb++;
      a.reb++;
      continue;
    }
    if (/^ defensive rebound\b/i.test(rest)) {
      a.dreb++;
      a.reb++;
      continue;
    }
    if (/\bturnover\b/i.test(rest)) {
      a.to++;
      const stl = inParens(r, rest, "steals");
      if (stl) {
        at(stl).stl++;
        touch(stl);
      }
      continue;
    }
    // A personal foul in all its forms. Technicals and defensive three
    // seconds are team/technical fouls and not in PF.
    if (/\b(foul|offensive charge)\b/i.test(rest) && !/technical|defensive 3[- ]seconds/i.test(rest)) {
      a.pf++;
      continue;
    }
    // "X enters the game for Y" — both have now been on the floor.
    const sub = /^ enters the game for (.+)$/.exec(rest);
    if (sub) touch(lead(r, sub[1])?.key ?? null);
  }

  return teams.map((t) => {
    const line = (p: PlayerBoxLine) => lines.get(`${t.tri}|${p.id || p.name}`);
    const held: PlayerBoxLine[] = t.players.map((p) => {
      const l = line(p);
      const played = p.starter || !!l?.appeared;
      const { appeared: _a, first: _f, ...stats } = l ?? { ...ZERO, appeared: false, first: -1 };
      return {
        ...p,
        ...stats,
        // Not yet in the game by the moment: listed under "not in yet",
        // never with the live box's reason or an ejection that came later.
        dnp: !played,
        dnpReason: null,
        ejected: false,
        min: 0,
        plusMinus: null,
      };
    });
    // Starters in the source's order; the bench in the order they first
    // appear in the plays (the live box's bench order can reflect minutes
    // played later); then whoever hasn't been in yet, by name.
    const firstOf = (p: PlayerBoxLine) => line(p)?.first ?? Infinity;
    const players = [
      ...held.filter((p) => p.starter),
      ...held.filter((p) => !p.starter && !p.dnp).sort((a, b) => firstOf(a) - firstOf(b)),
      ...held.filter((p) => !p.starter && p.dnp).sort((a, b) => a.name.localeCompare(b.name)),
    ];
    const totals = { ...ZERO };
    for (const p of players) for (const k of Object.keys(ZERO) as (keyof TeamTotals)[]) totals[k] += p[k];
    return { ...t, players, totals };
  });
}
