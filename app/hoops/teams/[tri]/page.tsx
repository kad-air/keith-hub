import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import {
  DEFAULT_RATING_MODE,
  getHoopsMeta,
  getRoster,
  getTeamRows,
  isRatingMode,
} from "@/lib/hoops/queries";
import { MODE_COPY, fmtSigned, rankTeams, teamName } from "@/lib/hoops/rating";
import { RATING_MODES } from "@/lib/hoops/types";

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

  const mode = isRatingMode(searchParams.mode) ? searchParams.mode : DEFAULT_RATING_MODE;
  const byMode = Object.fromEntries(
    RATING_MODES.map((m) => [m, rankTeams(rows, m).find((t) => t.tri === tri)!]),
  );
  const team = byMode[mode];
  const roster = getRoster(tri);
  const meta = getHoopsMeta();

  const totalMinutes = roster.reduce((s, p) => s + p.minutes, 0);

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="teams" />

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

      {/* All three ratings side by side — the mode is a choice, not a default
          to be hidden. */}
      <div className="mt-5 grid grid-cols-3 gap-2">
        {RATING_MODES.map((m) => {
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
          <li
            key={p.athlete_id}
            className="flex items-baseline gap-2 border-b border-rule/40 py-2"
          >
            <span className="flex-1 truncate font-display text-cream">{p.name}</span>
            <span className="w-12 text-right font-mono text-[0.72rem] text-cream-dim">
              {p.minutes.toFixed(1)}
            </span>
            <span
              className={`w-14 text-right font-mono text-sm ${
                p.value_per36 == null
                  ? "text-cream-dimmer"
                  : p.value_per36 >= 0
                    ? "text-cream"
                    : "text-cream-dim"
              }`}
            >
              {p.value_per36 == null ? "—" : fmtSigned(p.value_per36, 2)}
            </span>
            <span className="w-24 text-right font-mono text-[0.68rem] text-cream-dimmer max-sm:hidden">
              {p.game_rates
                ? `${p.game_rates.pts.toFixed(1)}/${p.game_rates.reb.toFixed(1)}/${p.game_rates.ast.toFixed(1)}`
                : "no games"}
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
