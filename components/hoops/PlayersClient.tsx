"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  PLAYER_SORTS,
  SORT_COPY,
  filterPlayers,
  rankPlayers,
  valueCoverage,
} from "@/lib/hoops/playervalue";
import type { PlayerSort, RankedPlayer } from "@/lib/hoops/playervalue";
import type { HoopsMeta } from "@/lib/hoops/queries";
import { fmtSigned, teamName } from "@/lib/hoops/rating";
import type { PlayerRow } from "@/lib/hoops/types";

interface Props {
  rows: PlayerRow[];
  /** Every tri code in the read model, sorted — the team filter's options. */
  tris: string[];
  meta: HoopsMeta;
  initialSort: PlayerSort;
  initialTeam: string | null;
}

// The whole league ships in the payload (~530 players × a handful of numbers),
// so sorting and filtering are instant and offline-safe — the same call
// TeamsClient makes for its three rating modes. ?sort= / ?team= stay in sync
// for deep links.
export default function PlayersClient({ rows, tris, meta, initialSort, initialTeam }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sort, setSort] = useState<PlayerSort>(initialSort);
  const [team, setTeam] = useState<string | null>(initialTeam);
  const [rotationOnly, setRotationOnly] = useState(false);
  // A name filter over 530 rows — "find Jokic" used to mean scrolling.
  const [query, setQuery] = useState("");

  const floor = meta.rotationFloorMinutes;

  // 🔴 A read model imported before the off/def split was carried through has
  // the columns and no values in them — the seed path rewrites itself on the
  // next boot (lib/hoops/import.ts), but a PUSH-sourced volume is authoritative
  // over disk by design and can only be refreshed by the Mini pushing again.
  // So say that plainly and drop the two sorts that would rank nobody, rather
  // than rendering a column of dashes and calling it a ranking.
  const hasSplit = useMemo(
    () => rows.some((r) => r.value_off_per36 != null && r.value_def_per36 != null),
    [rows],
  );
  // Same shape, for the promoted stack rating's value_pg field. Independent
  // of hasSplit — the two milestones shipped separately and a bundle could in
  // principle carry one without the other.
  const hasValue = useMemo(() => rows.some((r) => r.value_pg != null), [rows]);
  const sorts = PLAYER_SORTS.filter((s) => {
    if (s === "value") return hasValue;
    if (s === "off" || s === "def") return hasSplit;
    return true; // "net" is always available
  });
  const activeSort: PlayerSort = sorts.includes(sort) ? sort : "net";

  const ranked = useMemo(() => rankPlayers(rows, activeSort, floor), [rows, activeSort, floor]);
  const shown = useMemo(() => {
    const base = filterPlayers(ranked, { team, rotationOnly });
    const q = query.trim().toLowerCase();
    if (!q) return base;
    // Accent-insensitive so "jokic" finds Jokić and "doncic" finds Dončić.
    const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    return base.filter((p) => fold(p.name).includes(fold(q)));
  }, [ranked, team, rotationOnly, query]);
  const coverage = useMemo(() => valueCoverage(ranked), [ranked]);

  const syncUrl = useCallback(
    (next: { sort?: PlayerSort; team?: string | null }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.sort) params.set("sort", next.sort);
      if (next.team !== undefined) {
        if (next.team) params.set("team", next.team);
        else params.delete("team");
      }
      router.replace(`/hoops/players?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const pickSort = useCallback(
    (s: PlayerSort) => {
      setSort(s);
      syncUrl({ sort: s });
    },
    [syncUrl],
  );

  const pickTeam = useCallback(
    (t: string) => {
      const next = t === "" ? null : t;
      setTeam(next);
      syncUrl({ team: next });
    },
    [syncUrl],
  );

  return (
    <>
      <div className="flex gap-2">
        {sorts.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => pickSort(s)}
            aria-pressed={s === activeSort}
            className={`flex-1 border px-3 py-2 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors ${
              s === activeSort
                ? "border-cat-hoops/70 bg-cat-hoops/10 text-cat-hoops"
                : "border-rule/60 text-cream-dim hover:border-cat-hoops/40 hover:text-cream"
            }`}
          >
            {SORT_COPY[s].label}
          </button>
        ))}
      </div>

      {/* The honesty carry. What the number means, in one line, on screen. */}
      <p className="mt-3 border-l-2 border-cat-hoops/50 pl-3 text-sm text-cream-dim">
        {SORT_COPY[activeSort].blurb}
      </p>
      {!hasSplit && (
        <p className="mt-2 border-l-2 border-cat-hoops pl-3 text-sm text-cream-dim">
          This bundle carries no offence/defence split, so only the net ranking is available. The
          values are there in the export — push a fresh bundle from the Mini and the two halves
          appear.
        </p>
      )}
      <p className="mt-2 border-l-2 border-rule/60 pl-3 text-sm text-cream-dimmer">
        Points per 36 minutes against an average player, from the Mini&rsquo;s value model as of{" "}
        <span className="font-mono text-cream-dim">{meta.valueAsOf.slice(0, 10)}</span> — a model
        estimate, not a measurement of this season. Replacement level is{" "}
        <span className="font-mono text-cream-dim">{meta.replacementPer36.toFixed(2)}</span>, so an
        end-of-bench player sits a little below zero rather than at it.{" "}
        {coverage.valued < coverage.total && (
          <>
            {coverage.total - coverage.valued} of {coverage.total} players have no value estimate at
            all — no history to price them from — and sit unranked at the bottom.
          </>
        )}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="team-filter">
          Filter by team
        </label>
        <select
          id="team-filter"
          value={team ?? ""}
          onChange={(e) => pickTeam(e.target.value)}
          className="border border-rule/60 bg-ink px-3 py-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-hoops/40"
        >
          <option value="">All 30 teams</option>
          {tris.map((t) => (
            <option key={t} value={t}>
              {t} · {teamName(t)}
            </option>
          ))}
        </select>

        {floor != null && (
          <button
            type="button"
            onClick={() => setRotationOnly((v) => !v)}
            aria-pressed={rotationOnly}
            className={`border px-3 py-2 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors ${
              rotationOnly
                ? "border-cat-hoops/70 bg-cat-hoops/10 text-cat-hoops"
                : "border-rule/60 text-cream-dim hover:border-cat-hoops/40 hover:text-cream"
            }`}
          >
            Rotation only
          </button>
        )}

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a player"
          aria-label="Find a player by name"
          className="min-w-0 flex-1 border border-rule/60 bg-ink px-3 py-2 font-display text-sm text-cream placeholder:text-cream-dimmer focus:border-cat-hoops focus:outline-none"
        />
        <span className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          {shown.length} shown
        </span>
      </div>

      {/* A rate on thin minutes is a noisy rate, and this ranking is sorted by
          a rate — so say so where it can be seen, and give it a switch. The
          floor is hoops-sim's own rotation constant, not a number invented
          here. Same shape as the TeamsClient disagreement flag. */}
      {floor != null && coverage.thin > 0 && (
        <p className="mt-3 text-xs text-cream-dimmer">
          <span className="text-cat-hoops">!</span> marks the {coverage.thin} players expected under{" "}
          <span className="font-mono">{floor.toFixed(0)}</span> minutes a night —{" "}
          <em>Rotation only</em> hides them. Read the minutes and games on each row before the rank.
        </p>
      )}

      <ol className="mt-5">
        <li className="flex items-baseline gap-2 border-b border-rule/60 pb-1 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          <span className="w-7 shrink-0 text-right">#</span>
          <span className="flex-1">Player</span>
          <span className="w-11 text-right">Min</span>
          <span className="w-14 text-right">{SORT_COPY[activeSort].label}</span>
        </li>
        {shown.map((p) => (
          <PlayerLine key={p.athlete_id} p={p} sort={activeSort} />
        ))}
      </ol>

      {shown.length === 0 && (
        <p className="mt-6 text-sm text-cream-dim">
          Nobody matches that. Clear the search or the rotation filter, or pick another team.
        </p>
      )}

      {/* The full caution lives here rather than above the list: it is what you
          want when a name surprises you, and three explanatory paragraphs
          before rank 1 is most of a phone screen. */}
      <p className="mt-5 border-l-2 border-cat-hoops/50 pl-3 text-sm text-cream-dimmer">
        This is a ranking by a <em>rate</em> — per 36 minutes — so a deep-bench name can out-rank a
        star it would never out-play over a season.{" "}
        {floor != null && (
          <>
            The <span className="text-cat-hoops">!</span> flag catches one half of that: players
            hoops-sim&rsquo;s own rotation floor of{" "}
            <span className="font-mono">{floor.toFixed(0)}</span> minutes says are not really in the
            rotation.{" "}
          </>
        )}
        The games-played count is the other half. A big number off a three-game season is mostly the
        model&rsquo;s prior opinion of that player, not something it watched him do — the value
        model shrinks a thin sample toward what it expected, and at three games there is almost
        nothing pulling the other way.
      </p>

      <p className="mt-4 text-xs text-cream-dimmer">
        Tap any row for that player&rsquo;s team. A player&rsquo;s offence and defence <em>add</em>{" "}
        to his net, and a positive defence is{" "}
        <em>good</em> defence — points he stops. That is the opposite of the team ratings on{" "}
        <Link href="/hoops/teams" className="underline hover:text-cream-dim">
          Teams
        </Link>
        , where a positive defence means points allowed. Both conventions come straight from
        hoops-sim and both are carried through unchanged. Minutes are the raw expected-minutes
        estimate before normalisation to a 240-minute team game.
        {hasValue && (
          <>
            {" "}
            <em>Val/g</em> is a separate model — the stack rating times how many minutes he&rsquo;s
            expected to play that game, divided by 36 — not derived from the net/off/def figures
            above it.
          </>
        )}
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule/60 pt-3 font-mono text-[0.65rem] text-cream-dimmer">
        <dt>Fit</dt>
        <dd className="text-right text-cream-dim">{meta.paramVersion}</dd>
        <dt>Value as of</dt>
        <dd className="text-right text-cream-dim">{meta.valueAsOf.slice(0, 10)}</dd>
        <dt>Exported</dt>
        <dd className="text-right text-cream-dim">{meta.generatedAt.slice(0, 10)}</dd>
        <dt>Rows</dt>
        <dd className="text-right text-cream-dim">
          {coverage.total} players · {coverage.split} with an off/def split
          {hasValue && <> · {coverage.valuePg} with a value/g read</>}
        </dd>
      </dl>
    </>
  );
}

/**
 * One ranked player.
 *
 * Two or three lines, at every breakpoint — the offence/defence split is the
 * reason this page exists, so it renders on a phone rather than hiding behind
 * `sm:`. The second line is the split and the per-game counting line; a third
 * (value/g, expected minutes, evidence) appears only for a bundle carrying
 * the stack rating. In mono, under the name: The Feed's own stacked-meta
 * shape.
 */
function PlayerLine({ p, sort }: { p: RankedPlayer; sort: PlayerSort }) {
  const primary = sort === "off" ? p.off : sort === "def" ? p.def : sort === "value" ? p.valuePg : p.net;
  return (
    <li>
      <Link
        href={`/hoops/players/${p.athlete_id}`}
        className="flex items-baseline gap-2 border-b border-rule/40 py-2 transition-colors hover:bg-ink-raised/60"
      >
        <span className="w-7 shrink-0 text-right font-mono text-[0.7rem] text-cream-dimmer">
          {p.rank === 0 ? "—" : p.rank}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <span className="font-display text-cream">{p.name}</span>
            {p.thinMinutes && (
              <span
                title="expected to play under hoops-sim's rotation floor — a per-36 rate on thin minutes"
                className="ml-1 font-mono text-[0.7rem] text-cat-hoops"
              >
                !
              </span>
            )}
            <span className="ml-2 font-mono text-[0.62rem] uppercase tracking-kicker text-cat-hoops">
              {p.tri}
            </span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[0.62rem] text-cream-dimmer">
            {p.off == null || p.def == null ? (
              <span>no off/def split</span>
            ) : (
              <>
                <span className={sort === "off" ? "text-cream-dim" : undefined}>
                  off {fmtSigned(p.off, 2)}
                </span>
                {" · "}
                <span className={sort === "def" ? "text-cream-dim" : undefined}>
                  def {fmtSigned(p.def, 2)}
                </span>
              </>
            )}
            {p.ppg != null &&
              p.rpg != null &&
              p.apg != null &&
              ` · ${p.ppg.toFixed(1)}/${p.rpg.toFixed(1)}/${p.apg.toFixed(1)} in ${p.gp ?? 0} gp`}
          </span>
          {(p.valuePg != null || p.evidence != null) && (
            <span className="mt-0.5 block truncate font-mono text-[0.62rem] text-cream-dimmer">
              {p.valuePg != null && (
                <span className={sort === "value" ? "text-cream-dim" : undefined}>
                  val/g {fmtSigned(p.valuePg, 2)}
                </span>
              )}
              {p.expectedMinutes != null && ` (${p.expectedMinutes.toFixed(1)} exp min)`}
              {p.evidence != null && ` · ${p.evidence}`}
            </span>
          )}
        </span>

        <span className="w-11 shrink-0 text-right font-mono text-[0.72rem] text-cream-dim">
          {p.minutes.toFixed(1)}
        </span>
        <span
          className={`w-14 shrink-0 text-right font-mono text-sm ${
            primary == null ? "text-cream-dimmer" : primary >= 0 ? "text-cream" : "text-cream-dim"
          }`}
        >
          {primary == null ? "—" : fmtSigned(primary, 2)}
        </span>
      </Link>
    </li>
  );
}
