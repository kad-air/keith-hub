import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import {
  availableRatingModes,
  getHoopsMeta,
  getResultsWindow,
  getRoster,
  getTeamForm,
  getTeamRows,
  isRatingMode,
  resolveRatingMode,
} from "@/lib/hoops/queries";
import type { TeamFormGame } from "@/lib/hoops/queries";
import { MODE_COPY, fmtSigned, rankTeams, teamName } from "@/lib/hoops/rating";

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

  const totalMinutes = roster.reduce((s, p) => s + p.minutes, 0);

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
        {roster.length} players · {totalMinutes.toFixed(0)} raw expected minutes. Value is
        production net value per 36 minutes, in points; replacement level is{" "}
        <span className="font-mono">{meta.replacementPer36.toFixed(2)}</span>. It is a model
        estimate as of {meta.valueAsOf.slice(0, 10)}, not a measurement of this season.
      </p>

      <ol className="mt-4">
        <li className="flex items-baseline gap-2 border-b border-rule/60 pb-1 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          <span className="flex-1">Player</span>
          <span className="w-12 text-right">Min</span>
          <span className="w-14 text-right">Value</span>
          <span className="w-24 text-right max-sm:hidden">Pts/Reb/Ast</span>
        </li>
        {roster.map((p) => (
          <li key={p.athlete_id} className="border-b border-rule/40 py-2">
            <span className="flex items-baseline gap-2">
              <Link
                href={`/hoops/players/${p.athlete_id}`}
                className="min-w-0 flex-1 truncate font-display text-cream hover:text-cat-hoops"
              >
                {p.name}
              </Link>
              <span className="w-12 shrink-0 text-right font-mono text-[0.72rem] text-cream-dim">
                {p.minutes.toFixed(1)}
              </span>
              <span
                className={`w-14 shrink-0 text-right font-mono text-sm ${
                  p.value_per36 == null
                    ? "text-cream-dimmer"
                    : p.value_per36 >= 0
                      ? "text-cream"
                      : "text-cream-dim"
                }`}
              >
                {p.value_per36 == null ? "—" : fmtSigned(p.value_per36, 2)}
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-[0.68rem] text-cream-dimmer max-sm:hidden">
                {p.game_rates
                  ? `${p.game_rates.pts.toFixed(1)}/${p.game_rates.reb.toFixed(1)}/${p.game_rates.ast.toFixed(1)}`
                  : "no games"}
              </span>
            </span>
            {/* Same counting line, folded under the name on a phone rather
                than dropped — nothing renders on desktop that a phone hides. */}
            <span className="mt-0.5 block truncate font-mono text-[0.62rem] text-cream-dimmer sm:hidden">
              {p.game_rates
                ? `${p.game_rates.pts.toFixed(1)}/${p.game_rates.reb.toFixed(1)}/${p.game_rates.ast.toFixed(1)} in ${p.game_rates.gp} gp`
                : "no games this season"}
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs text-cream-dimmer">
        Minutes are the raw expected-minutes estimate before normalisation to a 240-minute team
        game — the simulator renormalises at allocation time, so these will not sum to 240.
      </p>
    </article>
  );
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
        {g.closingSpread != null && (
          <>
            {" · line "}
            {fmtSigned(g.closingSpread, 1)}{" "}
            <span className={g.ats === "covered" ? "text-cat-hoops" : undefined}>{g.ats}</span>
          </>
        )}
      </span>
    </li>
  );
}
