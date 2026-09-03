"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BoxScoreCaveats,
  RunProvenance,
  TeamBoxTable,
  VarianceNote,
} from "@/components/hoops/BoxScoreTable";
import MarginHistogram from "@/components/hoops/MarginHistogram";
import type { BoxscoreResult } from "@/lib/hoops/boxscore";
import type { Meeting, SimSummary } from "@/lib/hoops/matchup";
import type { FormSummary, HoopsMeta } from "@/lib/hoops/queries";
import { MODE_COPY, fmtSigned, rankTeams, teamName } from "@/lib/hoops/rating";
import { seriesLengthDistribution, seriesWinProb } from "@/lib/hoops/series";
import type { RankedTeam, RatingMode, TeamRow } from "@/lib/hoops/types";
import { useKeyboard } from "@/lib/useKeyboard";

interface Props {
  teams: TeamRow[];
  /** Recent form per team (up to last 10 in the results window). */
  form: Record<string, FormSummary>;
  meta: HoopsMeta;
  /** The lenses THIS bundle can offer — three, or four with nightly. Same
   *  list /hoops/teams draws, so the two screens never disagree. */
  modes: RatingMode[];
  defaultHome: string;
  defaultAway: string;
  defaultMode: RatingMode;
  defaultNeutral: boolean;
  /** Head to head for the default pair, server-rendered so the first paint
   *  already has it; re-fetched when a picker changes. */
  initialMeetings: Meeting[];
}

interface SimResponse {
  summary: SimSummary;
  box: BoxscoreResult;
  elapsedMs: number;
}

const N_SIMS = 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

export default function MatchupClient({
  teams,
  form,
  meta,
  modes,
  defaultHome,
  defaultAway,
  defaultMode,
  defaultNeutral,
  initialMeetings,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [home, setHome] = useState(defaultHome);
  const [away, setAway] = useState(defaultAway);
  const [neutral, setNeutral] = useState(defaultNeutral);
  const [mode, setMode] = useState<RatingMode>(defaultMode);
  const [result, setResult] = useState<SimResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>(initialMeetings);
  // The mirror-image sim (same two teams, courts swapped) a best-of-seven
  // needs. Fetched on demand, never with the first Sim — it is a second
  // question, and the first one should stay fast.
  const [series, setSeries] = useState<{ pHome: number; pAway: number; runId: string } | null>(null);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const seq = useRef(0);
  const resultRef = useRef<HTMLElement | null>(null);
  const firstRender = useRef(true);

  const tris = useMemo(() => teams.map((t) => t.tri).sort(), [teams]);
  // Rank + net under the CURRENT rating mode, so the context line under each
  // picker answers "who did I just pick?" before anything is simulated.
  const rankedByTri = useMemo(() => {
    const map: Record<string, RankedTeam> = {};
    for (const t of rankTeams(teams, mode)) map[t.tri] = t;
    return map;
  }, [teams, mode]);
  const sameTeam = home === away;

  // ── URL sync: the matchup is shareable before a sim is run ──────────────
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("home", home);
    params.set("away", away);
    params.set("mode", mode);
    if (neutral) params.set("neutral", "1");
    else params.delete("neutral");
    router.replace(`/hoops?${params.toString()}`, { scroll: false });
    // searchParams deliberately not a dependency: this effect WRITES it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, away, mode, neutral, router]);

  // ── Head to head follows the pickers ────────────────────────────────────
  useEffect(() => {
    if (sameTeam) return;
    let cancelled = false;
    fetch(`/api/hoops/meetings?a=${home}&b=${away}`)
      .then((r) => (r.ok ? r.json() : { meetings: [] }))
      .then((j: { meetings: Meeting[] }) => {
        if (!cancelled) setMeetings(j.meetings ?? []);
      })
      .catch(() => {
        if (!cancelled) setMeetings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [home, away, sameTeam]);

  // A new matchup invalidates the old answer and its series.
  const changePair = useCallback((nextHome: string, nextAway: string) => {
    setHome(nextHome);
    setAway(nextAway);
    setResult(null);
    setSeries(null);
    setError(null);
  }, []);

  const swap = useCallback(() => changePair(away, home), [away, home, changePair]);

  const surprise = useCallback(() => {
    const pool = tris.filter((t) => t !== home && t !== away);
    const h = pool[Math.floor(Math.random() * pool.length)];
    const rest = pool.filter((t) => t !== h);
    const a = rest[Math.floor(Math.random() * rest.length)];
    changePair(h, a);
  }, [tris, home, away, changePair]);

  const simOnce = useCallback(
    async (h: string, a: string): Promise<SimResponse> => {
      // The nonce is what makes a second tap a different set of games rather
      // than a replay — it feeds the run_id, which is the RNG key.
      const nonce = `${Date.now().toString(36)}-${(seq.current += 1)}`;
      const res = await fetch("/api/hoops/sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ home: h, away: a, neutral, mode, nSims: N_SIMS, nonce }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      return json as SimResponse;
    },
    [neutral, mode],
  );

  const sim = useCallback(async () => {
    if (sameTeam || busy) return;
    setBusy(true);
    setError(null);
    setSeries(null);
    try {
      const r = await simOnce(home, away);
      setResult(r);
      // The answer renders below the form; on a phone that is below the
      // fold, and a tap that changes nothing on screen reads as a dead tap.
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [home, away, sameTeam, busy, simOnce]);

  const runSeries = useCallback(async () => {
    if (!result || seriesBusy) return;
    setSeriesBusy(true);
    try {
      const pHome = result.summary.homeWinProb;
      if (neutral) {
        setSeries({ pHome, pAway: pHome, runId: result.summary.runId });
      } else {
        const mirror = await simOnce(away, home);
        setSeries({ pHome, pAway: 1 - mirror.summary.homeWinProb, runId: mirror.summary.runId });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Series simulation failed");
    } finally {
      setSeriesBusy(false);
    }
  }, [result, seriesBusy, neutral, simOnce, away, home]);

  useKeyboard({ s: () => void sim(), x: swap, r: surprise });

  const summary = result?.summary;

  // The last meeting's closing line, from tonight's HOME side, for the "our
  // line vs the market" sentence. A meeting where the other team hosted has
  // its spread flipped to this side.
  const lastLined = [...meetings].reverse().find((m) => m.homeSpread != null);
  const lastLineFromHome =
    lastLined && lastLined.homeSpread != null
      ? lastLined.home === home
        ? lastLined.homeSpread
        : -lastLined.homeSpread
      : null;

  return (
    <>
      {/* ── Pickers ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
        <TeamPicker label="Away" value={away} onChange={(v) => changePair(home, v)} options={tris} />
        <button
          type="button"
          onClick={swap}
          title="Swap home and away (x)"
          aria-label="Swap home and away"
          className="mb-0.5 border border-rule/60 px-2 py-1.5 font-mono text-[0.72rem] text-cream-dim transition-colors hover:border-cat-hoops/60 hover:text-cat-hoops"
        >
          {neutral ? "vs" : "@"} ⇄
        </button>
        <TeamPicker label="Home" value={home} onChange={(v) => changePair(v, away)} options={tris} />
      </div>

      {/* Who did I just pick? Rank, net, and recent form under the current
          rating mode — the context the sim's answer gets read against. */}
      <div className="mt-1.5 grid grid-cols-[1fr_auto_1fr] gap-2">
        <TeamContext team={rankedByTri[away]} form={form[away]} />
        <span />
        <TeamContext team={rankedByTri[home]} form={form[home]} align="right" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setNeutral((v) => !v);
            setResult(null);
            setSeries(null);
          }}
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
          {neutral ? "no home advantage" : `home advantage ${meta.hcaPts.toFixed(2)} pts`}
        </span>
        <button
          type="button"
          onClick={surprise}
          title="A random matchup (r)"
          className="ml-auto border border-rule/60 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-hoops/40 hover:text-cream"
        >
          Surprise me
        </button>
      </div>

      {/* Rating mode is a CHOICE with a caveat, never a hidden default. The
          list is whatever this bundle can offer, same as /hoops/teams. */}
      <div className="mt-4 flex gap-2">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setResult(null);
              setSeries(null);
            }}
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
        {busy
          ? "Simulating…"
          : sameTeam
            ? "Pick two different teams"
            : result
              ? `Sim again · ${N_SIMS.toLocaleString()} new games`
              : `Sim ${N_SIMS.toLocaleString()} games`}
      </button>
      <p className="mt-1.5 hidden text-center font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer sm:block">
        s sim · x swap · r surprise
      </p>

      {error && (
        <p className="mt-3 border-l-2 border-accent pl-3 text-sm text-cream-dim">{error}</p>
      )}

      {/* ── Head to head this season ─────────────────────────────────── */}
      {!sameTeam && meetings.length > 0 && (
        <section className="mt-6">
          <h2 className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
            Head to head this season
          </h2>
          <ol className="mt-1">
            {meetings.map((m) => (
              <li
                key={m.gameId}
                className="flex flex-wrap items-baseline gap-x-2 border-b border-rule/30 py-1 font-mono text-[0.68rem]"
              >
                <span className="w-12 text-cream-dimmer">{fmtDate(m.date)}</span>
                <span className="text-cream-dim">
                  {m.away} {m.neutral ? "vs" : "at"} <span className="text-cat-hoops">{m.home}</span>
                </span>
                <span className="ml-auto text-cream-dimmer">
                  {m.homeSpread != null
                    ? `closed ${m.home} ${fmtSigned(m.homeSpread, 1)}${m.total != null ? ` · o/u ${m.total}` : ""}`
                    : "no line"}
                </span>
                {m.homeScore != null && m.awayScore != null && (
                  <span className="text-cream">
                    {m.homeScore > m.awayScore ? m.home : m.away}{" "}
                    {Math.max(m.homeScore, m.awayScore)}–{Math.min(m.homeScore, m.awayScore)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {summary && result && (
        <>
          {/* ── The answer ─────────────────────────────────────────── */}
          <section ref={resultRef} className="mt-8 scroll-mt-20 border-t border-rule pt-5">
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

            {/* The same number as a length. The labels above carry identity;
                the tick is the coin-flip line, so lopsidedness reads at a
                glance. Home is the accented side, matching the histogram. */}
            <div className="relative mt-2" aria-hidden>
              <div className="flex h-2 gap-0.5">
                <div
                  className="bg-cat-hoops/70"
                  style={{ width: `${(summary.homeWinProb * 100).toFixed(2)}%` }}
                />
                <div className="flex-1 bg-cream-dimmer/40" />
              </div>
              <span className="absolute -top-0.5 left-1/2 h-3 w-px -translate-x-1/2 bg-cream-dimmer" />
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

            {/* The sim's read next to the market's — a curiosity, never an
                edge (HOOPS_PLAN.md §8). Different night, different roster,
                and the market misses by less than we do. */}
            {lastLined && lastLineFromHome != null && (
              <p className="mt-3 border-l-2 border-rule/60 pl-3 text-sm text-cream-dimmer">
                We make it{" "}
                <span className="font-mono text-cream-dim">
                  {summary.home} {fmtSigned(summary.homeSpread)}
                </span>
                . The market closed{" "}
                <span className="font-mono text-cream-dim">
                  {summary.home} {fmtSigned(lastLineFromHome, 1)}
                </span>{" "}
                the last time these two met ({fmtDate(lastLined.date)}
                {lastLined.home !== summary.home && !lastLined.neutral && `, at ${lastLined.home}`}) —
                a different night and a different roster. The market&rsquo;s typical miss is
                smaller than ours, so a gap here says something about the model, not about the
                game.
              </p>
            )}

            {/* ── Best of seven ─────────────────────────────────────── */}
            <div className="mt-4">
              {series ? (
                <SeriesBlock home={summary.home} away={summary.away} neutral={neutral} s={series} />
              ) : (
                <button
                  type="button"
                  onClick={runSeries}
                  disabled={seriesBusy}
                  className="border border-rule/60 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-hoops/40 hover:text-cream disabled:text-cream-dimmer"
                >
                  {seriesBusy ? "Simulating the other floor…" : "What about a best of seven?"}
                </button>
              )}
            </div>
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

/** Best-of-seven odds from the two single-game reads, with the honesty
 *  carry that this is regular-season strength on seven floors — the sim
 *  has no playoff rotation tightening in it. */
function SeriesBlock({
  home,
  away,
  neutral,
  s,
}: {
  home: string;
  away: string;
  neutral: boolean;
  s: { pHome: number; pAway: number; runId: string };
}) {
  const p = seriesWinProb(s.pHome, s.pAway);
  const lengths = seriesLengthDistribution(s.pHome, s.pAway);
  const fav = p >= 0.5 ? home : away;
  const favP = p >= 0.5 ? p : 1 - p;
  return (
    <div className="border-t border-rule/60 pt-3">
      <p className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
        Best of seven{neutral ? " · neutral floors" : ` · ${home} holds home court`}
      </p>
      <p className="mt-1 font-display text-xl text-cream">
        {fav} <span className="text-cat-hoops">{(favP * 100).toFixed(0)}%</span>{" "}
        <span className="font-mono text-sm text-cream-dim">
          · {fav === home ? away : home} {((1 - favP) * 100).toFixed(0)}%
        </span>
      </p>
      <p className="mt-1 font-mono text-[0.62rem] text-cream-dimmer">
        {lengths.map((l) => `${l.games === 4 ? "sweep" : `in ${l.games}`} ${(l.prob * 100).toFixed(0)}%`).join(" · ")}
      </p>
      <p className="mt-2 text-xs text-cream-dimmer">
        {neutral
          ? `Seven games at ${(s.pHome * 100).toFixed(0)}% each, no home floor.`
          : `${home} wins ${(s.pHome * 100).toFixed(0)}% at home and ${(s.pAway * 100).toFixed(0)}% at ${away}, in the 2-2-1-1-1 pattern.`}{" "}
        This is regular-season strength on seven floors: a real playoff rotation tightens and a
        top-heavy team plays above its rating in May, and the sim does not model that here.
      </p>
    </div>
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
    <label className="block min-w-0">
      <span className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full min-w-0 appearance-none border border-rule/60 bg-ink-raised px-2 py-2 font-display text-sm text-cream focus:border-cat-hoops focus:outline-none sm:text-base"
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

function TeamContext({
  team,
  form,
  align,
}: {
  team: RankedTeam | undefined;
  form: FormSummary | undefined;
  align?: "right";
}) {
  if (!team) return <span />;
  return (
    <p
      className={`truncate font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer ${
        align === "right" ? "text-right" : ""
      }`}
    >
      #{team.rank} · <span className="text-cream-dim">{fmtSigned(team.net)}</span> net
      {form && form.n > 0 && (
        <>
          {" · "}
          {form.wins}–{form.losses} last {form.n}
        </>
      )}
    </p>
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
