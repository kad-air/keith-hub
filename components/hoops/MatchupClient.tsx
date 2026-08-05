"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  BoxScoreCaveats,
  RunProvenance,
  TeamBoxTable,
  VarianceNote,
} from "@/components/hoops/BoxScoreTable";
import MarginHistogram from "@/components/hoops/MarginHistogram";
import type { BoxscoreResult } from "@/lib/hoops/boxscore";
import type { SimSummary } from "@/lib/hoops/matchup";
import type { HoopsMeta } from "@/lib/hoops/queries";
import { MODE_COPY, fmtSigned, teamName } from "@/lib/hoops/rating";
import type { RatingMode, TeamRow } from "@/lib/hoops/types";
import { RATING_MODES } from "@/lib/hoops/types";

interface Props {
  teams: TeamRow[];
  meta: HoopsMeta;
  defaultHome: string;
  defaultAway: string;
  defaultMode: RatingMode;
}

interface SimResponse {
  summary: SimSummary;
  box: BoxscoreResult;
  elapsedMs: number;
}

const N_SIMS = 1000;

export default function MatchupClient({
  teams,
  meta,
  defaultHome,
  defaultAway,
  defaultMode,
}: Props) {
  const [home, setHome] = useState(defaultHome);
  const [away, setAway] = useState(defaultAway);
  const [neutral, setNeutral] = useState(false);
  const [mode, setMode] = useState<RatingMode>(defaultMode);
  const [result, setResult] = useState<SimResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const tris = useMemo(() => teams.map((t) => t.tri).sort(), [teams]);
  const sameTeam = home === away;

  const sim = useCallback(async () => {
    if (sameTeam || busy) return;
    setBusy(true);
    setError(null);
    // The nonce is what makes a second tap a different set of games rather
    // than a replay — it feeds the run_id, which is the RNG key.
    const nonce = `${Date.now().toString(36)}-${(seq.current += 1)}`;
    try {
      const res = await fetch("/api/hoops/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ home, away, neutral, mode, nSims: N_SIMS, nonce }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json as SimResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [home, away, neutral, mode, sameTeam, busy]);

  const summary = result?.summary;

  return (
    <>
      {/* ── Pickers ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
        <TeamPicker label="Away" value={away} onChange={setAway} options={tris} />
        <span className="pb-2 text-center font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          {neutral ? "vs" : "@"}
        </span>
        <TeamPicker label="Home" value={home} onChange={setHome} options={tris} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setNeutral((v) => !v)}
          aria-pressed={neutral}
          className={`border px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-kicker transition-colors ${
            neutral
              ? "border-cat-hoops/70 bg-cat-hoops/10 text-cat-hoops"
              : "border-rule/60 text-cream-dim hover:border-cat-hoops/40"
          }`}
        >
          Neutral court
        </button>
        <span className="font-mono text-[0.62rem] text-cream-dimmer">
          {neutral
            ? "no home advantage applied"
            : `home advantage ${meta.hcaPts.toFixed(2)} pts`}
        </span>
      </div>

      {/* Rating mode is a CHOICE with a caveat, never a hidden default. */}
      <div className="mt-4 flex gap-2">
        {RATING_MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={m === mode}
            className={`flex-1 border px-2 py-1.5 font-mono text-[0.65rem] uppercase tracking-kicker transition-colors ${
              m === mode
                ? "border-cat-hoops/70 bg-cat-hoops/10 text-cat-hoops"
                : "border-rule/60 text-cream-dim hover:border-cat-hoops/40"
            }`}
          >
            {MODE_COPY[m].label}
          </button>
        ))}
      </div>
      <p className="mt-2 border-l-2 border-cat-hoops/50 pl-3 text-sm text-cream-dim">
        {MODE_COPY[mode].blurb}
      </p>

      <button
        type="button"
        onClick={sim}
        disabled={sameTeam || busy}
        className="mt-5 w-full border-2 border-accent bg-accent/10 px-4 py-3 font-mono text-sm uppercase tracking-kicker text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:border-rule/60 disabled:bg-transparent disabled:text-cream-dimmer"
      >
        {busy ? "Simulating…" : sameTeam ? "Pick two different teams" : "Sim"}
      </button>

      {error && (
        <p className="mt-3 border-l-2 border-accent pl-3 text-sm text-cream-dim">{error}</p>
      )}

      {summary && result && (
        <>
          {/* ── The answer ─────────────────────────────────────────── */}
          <section className="mt-8 border-t border-rule pt-5">
            <p className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
              {teamName(summary.away)} {summary.neutralSite ? "vs" : "at"}{" "}
              {teamName(summary.home)}
            </p>

            <div className="mt-2 flex items-baseline justify-between gap-4">
              <h2 className="font-display text-3xl text-cream">
                {summary.home}{" "}
                <span className="text-cat-hoops">
                  {(summary.homeWinProb * 100).toFixed(1)}%
                </span>
              </h2>
              <p className="font-mono text-sm text-cream-dim">
                {summary.away} {((1 - summary.homeWinProb) * 100).toFixed(1)}%
              </p>
            </div>

            <dl className="mt-4 grid grid-cols-3 gap-2 border-y border-rule/60 py-3">
              <Stat
                label="Line"
                value={`${summary.home} ${fmtSigned(summary.homeSpread)}`}
                sub={`± ${summary.mcStderrMargin.toFixed(2)} MC`}
              />
              <Stat
                label="Total"
                value={summary.meanTotal.toFixed(1)}
                sub={`${summary.total.p25.toFixed(0)}–${summary.total.p75.toFixed(0)} mid half`}
              />
              <Stat
                label="Score"
                value={`${summary.meanHomeScore.toFixed(0)}–${summary.meanAwayScore.toFixed(0)}`}
                sub={`OT ${summary.otPct.toFixed(1)}%`}
              />
            </dl>

            <MarginHistogram
              hist={summary.marginHist}
              home={summary.home}
              away={summary.away}
              meanMargin={summary.meanMargin}
            />

            {/* The whole reason the histogram is here, said out loud. */}
            <p className="mt-3 border-l-2 border-rule/60 pl-3 text-sm text-cream-dim">
              The answer is a <em>distribution</em>, not a number.{" "}
              {summary.meanMargin >= 0 ? summary.home : summary.away} by{" "}
              <span className="font-mono">{Math.abs(summary.meanMargin).toFixed(1)}</span> is the
              middle of a cloud about{" "}
              <span className="font-mono">{(summary.sdMargin * 2).toFixed(0)}</span> points wide —
              half of these games land between{" "}
              <span className="font-mono">{summary.margin.p25.toFixed(0)}</span> and{" "}
              <span className="font-mono">{summary.margin.p75.toFixed(0)}</span>, and one in ten
              finishes outside{" "}
              <span className="font-mono">
                {summary.margin.p5.toFixed(0)} … {summary.margin.p95.toFixed(0)}
              </span>
              .
            </p>
          </section>

          {/* ── Expected box score ─────────────────────────────────── */}
          <section className="mt-8">
            <h2 className="font-display text-xl text-cream">Expected box score</h2>
            <p className="mt-1 text-sm text-cream-dim">
              What a <em>typical</em> night looks like — every line is a mean over{" "}
              {summary.nSims.toLocaleString()} simulated games, so the numbers are fractional on
              purpose. For one specific night with a real final score, sim a single game below.
            </p>

            <TeamBoxTable box={result.box.away} mode="expected" poss={result.box.possAway} />
            <TeamBoxTable box={result.box.home} mode="expected" poss={result.box.possHome} />

            <VarianceNote />
            <BoxScoreCaveats />
            <RunProvenance
              box={result.box}
              extra={
                <>
                  <dt>Ratings</dt>
                  <dd className="text-right text-cream-dim">{summary.ratingMode}</dd>
                  <dt>Elapsed</dt>
                  <dd className="text-right text-cream-dim">{result.elapsedMs} ms</dd>
                </>
              }
            />

            {/* A DIFFERENT question, reached deliberately. The link carries a
                fresh nonce so the sampled game is its own draw — reusing this
                run's replicates would produce a game its run_id cannot
                reproduce (see lib/hoops/boxscore.ts on batch size). */}
            <Link
              href={`/hoops/game/new?home=${summary.home}&away=${summary.away}&mode=${summary.ratingMode}${summary.neutralSite ? "&neutral=1" : ""}`}
              className="mt-6 block border border-cat-hoops/60 px-4 py-3 text-center font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops transition-colors hover:bg-cat-hoops/10"
            >
              Sim one specific night →
            </Link>
          </section>
        </>
      )}
    </>
  );
}

function TeamPicker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="block">
      <span className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full appearance-none border border-rule/60 bg-ink-raised px-2 py-2 font-display text-base text-cream focus:border-cat-hoops focus:outline-none"
      >
        {options.map((t) => (
          <option key={t} value={t}>
            {t} — {teamName(t)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
        {label}
      </dt>
      <dd className="mt-0.5 font-display text-lg text-cream">{value}</dd>
      <dd className="font-mono text-[0.58rem] text-cream-dimmer">{sub}</dd>
    </div>
  );
}
