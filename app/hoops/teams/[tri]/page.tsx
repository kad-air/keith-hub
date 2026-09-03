import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import {
  availableRatingModes,
  getHoopsMeta,
  getNightlyMeta,
  getResultsWindow,
  getRoster,
  getTeamForm,
  getTeamMovers,
  getTeamRows,
  isRatingMode,
  resolveRatingMode,
} from "@/lib/hoops/queries";
import type { TeamFormGame, TeamMovers } from "@/lib/hoops/queries";
import { rankPlayers } from "@/lib/hoops/playervalue";
import { MODE_COPY, fmtSigned, rankTeams, teamName } from "@/lib/hoops/rating";
import type { RawNightlyMover } from "@/lib/hoops/types";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { tri: string } }): Metadata {
  const tri = params.tri.toUpperCase();
  return { title: `${teamName(tri)} — Hoops` };
}

export default function HoopsTeamPage({
  params,
  searchParams,
}: {
  params: { tri: string };
  searchParams: { mode?: string };
}) {
  const tri = params.tri.toUpperCase();
  const rows = getTeamRows();
  if (!rows.some((r) => r.tri === tri)) notFound();

  // The same lenses and default as /hoops/teams and /hoops — four cards when
  // the bundle carries a nightly read, and the default is the one the sim
  // prices with.
  const modes = availableRatingModes(rows);
  const asked = isRatingMode(searchParams.mode) ? searchParams.mode : null;
  const mode = asked && modes.includes(asked) ? asked : resolveRatingMode(rows);
  const byMode = Object.fromEntries(
    modes.map((m) => [m, rankTeams(rows, m).find((t) => t.tri === tri)!]),
  );
  const team = byMode[mode];
  const roster = getRoster(tri);
  const form = getTeamForm(tri);
  const meta = getHoopsMeta();
  // WHAT MOVED. Null for a bundle that carries no movers, and for a team the
  // nightly read abstained on — nothing was re-priced there, so there is
  // nothing to explain and the block simply does not appear.
  const movers = getTeamMovers(tri);
  const nightly = getNightlyMeta();

  // The roster is ordered and priced by the SAME model the league ranking and
  // the player page use — the promoted stack rating (value_pg = rating ×
  // expected minutes, stack_net_per36 = the rate). It used to show the older
  // flagship `value_per36`, which meant a name could read one way here and
  // another way one tap along. `rankPlayers` already does the fallback this
  // wants: anyone the stack has no read on sorts to the bottom by minutes.
  const ranked = rankPlayers(roster, "value", null);
  const totalMinutes = roster.reduce((s, p) => s + (p.expected_minutes ?? p.minutes), 0);

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="teams" through={getResultsWindow()?.to ?? null} />

      <Link
        href={`/hoops/teams?mode=${mode}`}
        className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dimmer transition-colors hover:text-cream-dim"
      >
        ← All teams
      </Link>

      <header className="mt-3">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-hoops">{tri}</p>
        <h2 className="mt-1 font-display text-3xl text-cream">{teamName(tri)}</h2>
        <p className="mt-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          {team.conference} · {team.division} · #{team.rank} by {MODE_COPY[mode].label.toLowerCase()}{" "}
          rating
        </p>
      </header>

      {/* Every rating side by side — the mode is a choice, not a default to
          be hidden. */}
      <div className={`mt-5 grid gap-2 ${modes.length === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
        {modes.map((m) => {
          const t = byMode[m];
          const active = m === mode;
          return (
            <Link
              key={m}
              href={`/hoops/teams/${tri}?mode=${m}`}
              className={`border px-3 py-2 transition-colors ${
                active
                  ? "border-cat-hoops/70 bg-cat-hoops/10"
                  : "border-rule/60 hover:border-cat-hoops/40"
              }`}
            >
              <p className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
                {MODE_COPY[m].label}
              </p>
              <p
                className={`mt-1 font-display text-xl ${active ? "text-cat-hoops" : "text-cream"}`}
              >
                {fmtSigned(t.net)}
              </p>
              <p className="font-mono text-[0.62rem] text-cream-dimmer">
                #{t.rank} · {fmtSigned(t.off)} / {fmtSigned(t.def)}
              </p>
            </Link>
          );
        })}
      </div>

      <p className="mt-3 border-l-2 border-cat-hoops/50 pl-3 text-sm text-cream-dim">
        {MODE_COPY[mode].blurb}
      </p>
      {team.modeDisagreement >= 5 && (
        <p className="mt-2 border-l-2 border-cat-hoops pl-3 text-sm text-cream-dim">
          Results and roster disagree by{" "}
          <span className="font-mono">{team.modeDisagreement.toFixed(1)}</span> points on this team
          — well above the league median. The two ratings are seeing different things here; neither
          one is the correction.
        </p>
      )}

      {movers && (
        <WhatMoved
          tri={tri}
          movers={movers}
          lastNGames={nightly.lastNGames ?? 10}
          leagueShift={nightly.leagueTypicalShift}
        />
      )}

      {/* ── Recent games ── the results window, previously imported and never
          rendered anywhere. Form, finals, and the closing market line each
          game actually closed at. */}
      {form.games.length > 0 && (
        <section className="mt-8">
          <h3 className="font-display text-lg text-cream">Recent games</h3>
          <p className="mt-1 text-xs text-cream-dimmer">
            <span className="font-mono text-cream-dim">
              {form.wins}–{form.losses}
            </span>{" "}
            over the bundle&rsquo;s results window ({form.windowFrom} to {form.windowTo} — the last
            200 completed games league-wide, not the full season) · scoring{" "}
            <span className="font-mono text-cream-dim">
              {avg(form.games.map((g) => g.teamScore))}
            </span>{" "}
            and allowing{" "}
            <span className="font-mono text-cream-dim">
              {avg(form.games.map((g) => g.oppScore))}
            </span>{" "}
            a game.
          </p>

          {/* Oldest → newest, so the strip reads left-to-right like a season.
              The letter carries the outcome; color only reinforces it. */}
          <div className="mt-3 flex flex-wrap gap-1" aria-label="Recent form, oldest to newest">
            {[...form.games].reverse().map((g) => (
              <span
                key={g.gameId}
                title={`${fmtDate(g.date)} ${g.home ? "vs" : "at"} ${g.opp} ${g.teamScore}–${g.oppScore}`}
                className={`flex h-6 w-6 items-center justify-center border font-mono text-[0.65rem] ${
                  g.won
                    ? "border-cat-hoops/70 bg-cat-hoops/10 text-cat-hoops"
                    : "border-rule/60 text-cream-dimmer"
                }`}
              >
                {g.won ? "W" : "L"}
              </span>
            ))}
          </div>

          <ol className="mt-4">
            {form.games.map((g) => (
              <GameRow key={g.gameId} g={g} />
            ))}
          </ol>

          <p className="mt-3 text-xs text-cream-dimmer">
            <em>Line</em> is the closing market spread from {tri}&rsquo;s side — negative means the
            market had {tri} favoured. <em>Covered</em> / <em>missed</em> is the final margin
            against that number, which is a check on the market, not on this model.
          </p>
        </section>
      )}

      <div className="mt-6 grid grid-cols-2 gap-2">
        <Link
          href={`/hoops?home=${tri}&mode=${mode}`}
          className="block border border-cat-hoops/60 px-4 py-3 text-center font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops transition-colors hover:bg-cat-hoops/10"
        >
          Sim a game at {tri} →
        </Link>
        <Link
          href={`/hoops/players?team=${tri}`}
          className="block border border-rule/60 px-4 py-3 text-center font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-hoops/40 hover:text-cream"
        >
          {tri} in the league ranking →
        </Link>
      </div>

      <h3 className="mt-8 font-display text-lg text-cream">Roster</h3>
      <p className="mt-1 text-xs text-cream-dimmer">
        {roster.length} players, best first by what each one is worth to {tri} on a night he plays.{" "}
        <em>Val/G</em> is that: his rating times the minutes we expect him to get. <em>Rate</em> is
        the same rating stated per 36 minutes on the floor, so a bench man who plays well in short
        bursts reads high there and small on Val/G. Both are the same model that ranks the league on{" "}
        <Link href="/hoops/players" className="underline hover:text-cream-dim">
          Players
        </Link>
        , as of {meta.valueAsOf.slice(0, 10)} — what we expect of him, not a measurement of this
        season. A dash means we have no read on him at all.
      </p>

      <ol className="mt-4">
        <li className="flex items-baseline gap-2 border-b border-rule/60 pb-1 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          <span className="flex-1">Player</span>
          <span className="w-10 text-right">Min</span>
          <span className="w-14 text-right">Val/G</span>
          <span className="w-12 text-right">Rate</span>
          <span className="w-24 text-right max-sm:hidden">Pts/Reb/Ast</span>
        </li>
        {ranked.map((p) => (
          <li key={p.athlete_id} className="border-b border-rule/40 py-2">
            <span className="flex items-baseline gap-2">
              <Link
                href={`/hoops/players/${p.athlete_id}`}
                className="min-w-0 flex-1 truncate font-display text-cream hover:text-cat-hoops"
              >
                {p.name}
              </Link>
              <span className="w-10 shrink-0 text-right font-mono text-[0.72rem] text-cream-dim">
                {(p.expectedMinutes ?? p.minutes).toFixed(1)}
              </span>
              <span
                className={`w-14 shrink-0 text-right font-mono text-sm ${
                  p.valuePg == null
                    ? "text-cream-dimmer"
                    : p.valuePg >= 0
                      ? "text-cream"
                      : "text-cream-dim"
                }`}
              >
                {p.valuePg == null ? "—" : fmtSigned(p.valuePg, 2)}
              </span>
              <span
                className={`w-12 shrink-0 text-right font-mono text-[0.72rem] ${
                  p.stackNet == null ? "text-cream-dimmer" : "text-cream-dim"
                }`}
              >
                {p.stackNet == null ? "—" : fmtSigned(p.stackNet, 2)}
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-[0.68rem] text-cream-dimmer max-sm:hidden">
                {p.ppg != null && p.rpg != null && p.apg != null
                  ? `${p.ppg.toFixed(1)}/${p.rpg.toFixed(1)}/${p.apg.toFixed(1)}`
                  : "no games"}
              </span>
            </span>
            {/* Same counting line, folded under the name on a phone rather
                than dropped — nothing renders on desktop that a phone hides. */}
            <span className="mt-0.5 block truncate font-mono text-[0.62rem] text-cream-dimmer sm:hidden">
              {p.ppg != null && p.rpg != null && p.apg != null
                ? `${p.ppg.toFixed(1)}/${p.rpg.toFixed(1)}/${p.apg.toFixed(1)} in ${p.gp ?? 0} gp`
                : "no games this season"}
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs text-cream-dimmer">
        Min is the minutes we expect each man to play on a night he plays — they add to{" "}
        <span className="font-mono">{totalMinutes.toFixed(0)}</span> here, more than the 240 a game
        has to give out, because not everybody is available every night. The simulator shares out
        the real 240 when it plays the game.
      </p>
    </article>
  );
}

/**
 * WHAT MOVED — the men behind this team's nightly rating.
 *
 * Two readings of the SAME roster through the SAME pricing: every man weighted
 * by the minutes he has actually played over the last ten games, against every
 * man weighted by the minutes he has averaged all season. The gap between them
 * splits one piece per player, and these are the biggest three.
 *
 * 🔴 Three numbers that are NOT the same thing, and the copy has to keep them
 * apart: the team's WHOLE gap (`deltaPreMix`, which the full decomposition sums
 * to), the part these three account for (`moversDeltaSum`), and the share that
 * survives the mix with the season-long rating (`deltaPostMix`). The team's
 * Nightly-minus-Results number is a fourth quantity again, and these men do not
 * decompose it, so it is deliberately not quoted here.
 */
function WhatMoved({
  tri,
  movers,
  lastNGames,
  leagueShift,
}: {
  tri: string;
  movers: TeamMovers;
  lastNGames: number;
  leagueShift: number | null;
}) {
  const gap = movers.deltaPreMix;
  const worse = gap < 0;
  return (
    <section className="mt-6 border-l-2 border-cat-hoops/50 pl-3">
      <h3 className="font-display text-lg text-cream">What moved</h3>
      <p className="mt-1 text-sm text-cream-dim">
        Priced off the men who have actually played {tri}&rsquo;s last {lastNGames} games, this team
        reads{" "}
        <span className={`font-mono ${worse ? "text-cream-dim" : "text-cream"}`}>
          {Math.abs(gap).toFixed(1)}
        </span>{" "}
        points a game {worse ? "worse" : "better"} than the same roster at its season-typical
        minutes. {movers.nMoversTotal} men moved it; these are the biggest.
      </p>

      <ol className="mt-3">
        {movers.movers.map((m, i) => (
          <MoverRow key={`${m.athlete_id}-${i}`} m={m} lastNGames={lastNGames} />
        ))}
      </ol>

      <p className="mt-3 text-xs text-cream-dimmer">
        {movers.movers.length === 1 ? "That man accounts" : `Those ${movers.movers.length} account`}{" "}
        for{" "}
        <span className="font-mono">{fmtSigned(movers.moversDeltaSum, 1)}</span> of the{" "}
        <span className="font-mono">{fmtSigned(gap, 1)}</span>. Blending with the season-long
        results rating keeps{" "}
        <span className="font-mono">{fmtSigned(movers.deltaPostMix, 1)}</span> of it inside the
        Nightly number.
      </p>
      {leagueShift != null && (
        <p className="mt-1.5 text-xs text-cream-dimmer">
          Every team drifts a little: the league as a whole reads{" "}
          <span className="font-mono">{Math.abs(leagueShift).toFixed(1)}</span> points a game{" "}
          {leagueShift < 0 ? "lower" : "higher"} off its last {lastNGames} games than off the full
          season, because injuries and rest pile up. That drift sits under all thirty teams and is
          charged to nobody here.
        </p>
      )}
    </section>
  );
}

/** One mover: who, what changed about his nights, and what it was worth. */
function MoverRow({ m, lastNGames }: { m: RawNightlyMover; lastNGames: number }) {
  // 🔴 athlete_id −1 is the "next man up" slot the minutes of a declared
  // absence were handed to. It is not a person and must never link to one.
  const isSlot = m.athlete_id === -1;
  return (
    <li className="border-b border-rule/40 py-2">
      <span className="flex items-baseline gap-2">
        {isSlot ? (
          <span className="min-w-0 flex-1 font-display text-cream-dimmer">next man up</span>
        ) : (
          <Link
            href={`/hoops/players/${m.athlete_id}`}
            className="min-w-0 flex-1 truncate font-display text-cream hover:text-cat-hoops"
          >
            {m.name}
          </Link>
        )}
        <span
          className={`w-14 shrink-0 text-right font-mono text-sm ${
            m.delta_pts >= 0 ? "text-cream" : "text-cream-dim"
          }`}
        >
          {fmtSigned(m.delta_pts, 2)}
        </span>
      </span>
      {/* Wraps rather than truncates: the phrase is the whole point of the row,
          and a clipped one on a phone would say less than nothing. */}
      <span className="mt-0.5 block font-mono text-[0.62rem] leading-relaxed text-cream-dimmer">
        {moverPhrase(m, lastNGames)}
      </span>
    </li>
  );
}

/** The direction as a sentence a broadcast could say out loud. */
function moverPhrase(m: RawNightlyMover, lastNGames: number): string {
  const played =
    m.games_played_of_last_n === 0 ? "none" : `${m.games_played_of_last_n} of the last ${lastNGames}`;
  const now = m.minutes_last_n.toFixed(1);
  const usual = m.minutes_typical.toFixed(1);
  switch (m.direction) {
    case "out":
      // Not "0 minutes lately" — the sentence people say is that he is out.
      return `out — played ${played === "none" ? `none of the last ${lastNGames}` : played}, after ${usual} min a night on the season`;
    case "back":
      // His minutes may be up or down; what is up is his AVAILABILITY, and
      // those are different sentences.
      return `back — played ${played}, ${now} min a night against ${usual} on the season`;
    case "up":
      return `playing more — ${now} min a night against ${usual} on the season`;
    case "down":
      return `playing less — ${now} min a night against ${usual} on the season`;
    case "absorbed":
      return `the minutes an absence left behind — ${now} a night against ${usual} on the season`;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-04-12" → "Apr 12". String maths on purpose — a Date round-trip
 *  through the server's timezone can shift the calendar day. */
function fmtDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

function avg(xs: number[]): string {
  return (xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)).toFixed(1);
}

/** One completed game: result on the left, the market's number on the right. */
function GameRow({ g }: { g: TeamFormGame }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-rule/40 py-1.5">
      <span className="w-12 shrink-0 font-mono text-[0.65rem] text-cream-dimmer">
        {fmtDate(g.date)}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          {g.neutral ? "n" : g.home ? "vs" : "at"}
        </span>{" "}
        <span className="font-mono text-[0.72rem] text-cat-hoops">{g.opp}</span>{" "}
        <span className={`font-mono text-[0.72rem] ${g.won ? "text-cream" : "text-cream-dim"}`}>
          {g.won ? "W" : "L"} {g.teamScore}–{g.oppScore}
        </span>
      </span>
      <span className="shrink-0 text-right font-mono text-[0.65rem] text-cream-dimmer">
        {fmtSigned(g.margin, 0)}
      </span>
      {/* The market's number gets its own line on a phone. On one row it and
          the score share ~343px with the date, which leaves the longest rows
          (a 3-digit margin against a double-digit line) a couple of dozen
          pixels of room — the wrap is what stops that being a clip. `w-full`
          in a flex-wrap row forces the break; `sm:w-auto` puts it back inline
          on anything wider. pl-14 lines it up under the opponent. */}
      {g.closingSpread != null && (
        <span className="w-full shrink-0 pl-14 font-mono text-[0.65rem] text-cream-dimmer sm:w-auto sm:pl-0 sm:text-right">
          <span className="hidden sm:inline">· </span>
          {"line "}
          {fmtSigned(g.closingSpread, 1)}{" "}
          <span className={g.ats === "covered" ? "text-cat-hoops" : undefined}>{g.ats}</span>
        </span>
      )}
    </li>
  );
}
