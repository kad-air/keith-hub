"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  MODE_COPY,
  fmtSigned,
  modeDisagreement,
  rankTeams,
  teamName,
} from "@/lib/hoops/rating";
import type { FormSummary, HoopsMeta, NightlyMeta } from "@/lib/hoops/queries";
import type { RatingMode, TeamRow } from "@/lib/hoops/types";

interface Props {
  rows: TeamRow[];
  rosterSizes: Record<string, number>;
  /** Recent form per team (up to last 10 games in the results window). */
  form: Record<string, FormSummary>;
  /** The results window's date span, for the form footnote. */
  resultsWindow: { from: string; to: string } | null;
  meta: HoopsMeta;
  /** Which lenses THIS bundle can offer — three, or four with `nightly`. Not a
   *  constant: an older bundle carries no nightly read and must not show the
   *  button at all. */
  modes: RatingMode[];
  nightly: NightlyMeta;
  initialMode: RatingMode;
}

// A team whose two ratings disagree by more than this is flagged inline. The
// plan's caveat is "above 30% roster churn"; the export doesn't carry churn,
// so the flag fires on the disagreement the data actually shows. 5 pts is
// comfortably above the league median (~3) — it means the ratings genuinely
// diverge about this team, not that everything is noisy.
const DISAGREEMENT_FLAG_PTS = 5;

export default function TeamsClient({
  rows,
  rosterSizes,
  form,
  resultsWindow,
  meta,
  modes,
  nightly,
  initialMode,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<RatingMode>(initialMode);

  // Every mode ships in the payload (30 teams x up to 4 lenses), so switching
  // is instant and offline-safe. ?mode= is kept in sync for deep links.
  const teams = useMemo(() => rankTeams(rows, mode), [rows, mode]);
  const spread = useMemo(() => modeDisagreement(rows), [rows]);

  const pick = useCallback(
    (m: RatingMode) => {
      setMode(m);
      const params = new URLSearchParams(searchParams.toString());
      params.set("mode", m);
      router.replace(`/hoops/teams?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const flagged = teams.filter((t) => t.modeDisagreement >= DISAGREEMENT_FLAG_PTS);

  return (
    <>
      <div className="flex gap-2">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => pick(m)}
            aria-pressed={m === mode}
            className={`flex-1 border px-3 py-2 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors ${
              m === mode
                ? "border-cat-hoops/70 bg-cat-hoops/10 text-cat-hoops"
                : "border-rule/60 text-cream-dim hover:border-cat-hoops/40 hover:text-cream"
            }`}
          >
            {MODE_COPY[m].label}
          </button>
        ))}
      </div>

      {/* The honesty carry. Always on screen, never a tooltip. */}
      <p className="mt-3 border-l-2 border-cat-hoops/50 pl-3 text-sm text-cream-dim">
        {MODE_COPY[mode].blurb}
      </p>

      {/* Nightly's own provenance and its caveats — on screen, in the language
          of the sport, and only when the lens is actually selected. */}
      {mode === "nightly" && nightly.present && (
        <p className="mt-2 border-l-2 border-cat-hoops/30 pl-3 text-sm text-cream-dimmer">
          Built from each team&rsquo;s last{" "}
          <span className="font-mono text-cream-dim">{nightly.lastNGames ?? 10}</span> games, with
          player ratings as of{" "}
          <span className="font-mono text-cream-dim">{nightly.asOf ?? "—"}</span>. It is a{" "}
          <em>margin</em> read only: a team&rsquo;s contribution to a game&rsquo;s total points is
          carried straight over from the Results rating, so switching to this lens never changes
          how high-scoring we expect a game to be, only who we expect to win it.
          {nightly.priced ? (
            <> This is also the rating a simulated game is priced with unless you pick another.</>
          ) : (
            <>
              {" "}
              It is shown here but <em>not</em> used to price a simulated game — the model has not
              yet vouched for this read as a pricing input.
            </>
          )}
          {nightly.abstained.length > 0 && (
            <>
              {" "}
              No read yet for{" "}
              <span className="font-mono">{nightly.abstained.join(" ")}</span> — too few games so
              far, so they keep their Results rating unchanged rather than showing a number we
              did not work out.
            </>
          )}
        </p>
      )}
      <p className="mt-2 border-l-2 border-rule/60 pl-3 text-sm text-cream-dimmer">
        Results and roster ratings currently disagree by{" "}
        <span className="font-mono text-cream-dim">{spread.median.toFixed(1)}</span> points for the
        median team, and by as much as{" "}
        <span className="font-mono text-cream-dim">{spread.max.toFixed(1)}</span> for {spread.maxTeam}
        . The bottom-up roster rating is the noisier of the two — treat a big gap as{" "}
        <em>these two views disagree</em>, not as a correction.
        {flagged.length > 0 && (
          <>
            {" "}
            Flagged below (<span className="text-cat-hoops">!</span>):{" "}
            <span className="font-mono">{flagged.map((t) => t.tri).join(" ")}</span>.
          </>
        )}
      </p>

      <ol className="mt-5">
        <li className="flex items-baseline gap-2 border-b border-rule/60 pb-1 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          <span className="w-6 shrink-0 text-right">#</span>
          <span className="flex-1">Team</span>
          <span className="w-14 text-right">Net</span>
          <span className="w-12 text-right max-sm:hidden">Off</span>
          <span className="w-12 text-right max-sm:hidden">Def</span>
        </li>
        {teams.map((t) => {
          const f = form[t.tri];
          return (
            <li key={t.tri}>
              {/* Two lines everywhere: the name + net stay on the scan line,
                  and the meta drops underneath instead of squeezing beside the
                  name. Off/def render as columns at sm+ and fold into the meta
                  line below that — same information at every width, different
                  placement. */}
              <Link
                href={`/hoops/teams/${t.tri}?mode=${mode}`}
                className="block border-b border-rule/40 py-2 transition-colors hover:bg-ink-raised/60"
              >
                <span className="flex items-baseline gap-2">
                  <span className="w-6 shrink-0 text-right font-mono text-[0.7rem] text-cream-dimmer">
                    {t.rank}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-[0.72rem] text-cat-hoops">{t.tri}</span>{" "}
                    <span className="font-display text-cream">{teamName(t.tri)}</span>
                    {t.modeDisagreement >= DISAGREEMENT_FLAG_PTS && (
                      <span
                        title={`results and roster ratings differ by ${t.modeDisagreement.toFixed(1)} pts`}
                        className="ml-1 font-mono text-[0.7rem] text-cat-hoops"
                      >
                        !
                      </span>
                    )}
                  </span>
                  <span
                    className={`w-14 shrink-0 text-right font-mono text-sm ${
                      t.net >= 0 ? "text-cream" : "text-cream-dim"
                    }`}
                  >
                    {fmtSigned(t.net)}
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-[0.72rem] text-cream-dim max-sm:hidden">
                    {fmtSigned(t.off)}
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-[0.72rem] text-cream-dim max-sm:hidden">
                    {fmtSigned(t.def)}
                  </span>
                </span>
                <span className="mt-0.5 block truncate pl-8 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
                  <span className="sm:hidden">
                    off {fmtSigned(t.off)} · def {fmtSigned(t.def)} ·{" "}
                  </span>
                  {t.conference} · {rosterSizes[t.tri] ?? 0} players
                  {f && f.n > 0 && (
                    <>
                      {" · "}
                      <span className={f.wins >= f.losses ? "text-cream-dim" : undefined}>
                        {f.wins}–{f.losses}
                      </span>{" "}
                      last {f.n}
                    </>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 text-xs text-cream-dimmer">
        Net is points per 100 possessions (off − def). A positive <em>Def</em> means points allowed
        above league average, so a good defence reads negative — that is hoops-sim&rsquo;s own
        convention, carried through unchanged.
        {resultsWindow && (
          <>
            {" "}
            The win–loss figure is recent form, not a season record: the bundle carries the last
            200 completed games league-wide (
            <span className="font-mono">{resultsWindow.from}</span> to{" "}
            <span className="font-mono">{resultsWindow.to}</span>), about thirteen per team.
          </>
        )}
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule/60 pt-3 font-mono text-[0.65rem] text-cream-dimmer">
        <dt>Fit</dt>
        <dd className="text-right text-cream-dim">{meta.paramVersion}</dd>
        <dt>Data as of</dt>
        <dd className="text-right text-cream-dim">{meta.dataAsOf}</dd>
        <dt>Exported</dt>
        <dd className="text-right text-cream-dim">{meta.generatedAt.slice(0, 10)}</dd>
        <dt>Rows</dt>
        <dd className="text-right text-cream-dim">
          {meta.teams} teams · {meta.players} players · {meta.scheduledGames} games
        </dd>
      </dl>
    </>
  );
}
