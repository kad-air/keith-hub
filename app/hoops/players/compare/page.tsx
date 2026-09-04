import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ComparePickers from "@/components/hoops/ComparePicker";
import type { PickOption } from "@/components/hoops/ComparePicker";
import HoopsNav from "@/components/hoops/HoopsNav";
import PlayerCompare from "@/components/hoops/PlayerCompare";
import type { ComparePlayer } from "@/components/hoops/PlayerCompare";
import { rankPlayers, replacementLevelsOf } from "@/lib/hoops/playervalue";
import { fmtSigned } from "@/lib/hoops/rating";
import {
  getAllPlayers,
  getExplainModel,
  getHoopsMeta,
  getPlayer,
  getResultsWindow,
} from "@/lib/hoops/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hoops · Compare players — hub" };

/**
 * Two players, side by side, with the working shown.
 *
 * `?a=` and `?b=` are the whole state: the answer is a pure function of the
 * two athlete ids, so every comparison is a link and nothing here needs to be
 * a client component except the two pickers. An id nobody carries 404s rather
 * than rendering half a page; `a` alone renders the picker with `a` filled,
 * which is the shape the player page's "Compare with…" control arrives in.
 */
export default function HoopsComparePage({
  searchParams,
}: {
  searchParams: { a?: string; b?: string };
}) {
  const all = getAllPlayers();
  const meta = getHoopsMeta();
  const model = getExplainModel();
  const through = getResultsWindow()?.to ?? null;
  // Issue #70 F5 round 2 (owner decision 2026-09-04: "one scale on every
  // player surface" — the compare page too, so it never disagrees with the
  // player page about what zero means).
  const levels = replacementLevelsOf(meta.replacementPer36, meta.replacementTiltPer36);

  const resolve = (raw: string | undefined): number | null => {
    if (raw == null || raw === "") return null;
    const id = Number(raw);
    if (!Number.isInteger(id)) notFound();
    if (!all.some((p) => p.athlete_id === id)) notFound();
    return id;
  };
  const aId = resolve(searchParams.a);
  const bId = resolve(searchParams.b);

  const options: PickOption[] = all.map((p) => ({
    athlete_id: p.athlete_id,
    name: p.name,
    tri: p.tri,
  }));

  // League ranks, computed before anything is picked — the same league ranking
  // /hoops/players prints, never a re-rank of the two men on screen.
  const ranked = rankPlayers(all, "value", meta.rotationFloorMinutes);
  const of = ranked.filter((r) => r.rank > 0).length;
  const rankOf = (id: number): { rank: number; of: number } => ({
    rank: ranked.find((r) => r.athlete_id === id)?.rank ?? 0,
    of,
  });

  const load = (id: number): ComparePlayer => {
    const row = getPlayer(id);
    if (!row) notFound();
    return { row, rank: rankOf(id) };
  };

  const a = aId != null ? load(aId) : null;
  const b = bId != null ? load(bId) : null;
  const same = aId != null && aId === bId;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="players" through={through} />

      <Link
        href="/hoops/players"
        className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dimmer transition-colors hover:text-cream-dim"
      >
        ← Players
      </Link>

      <header className="mt-3">
        <h2 className="font-display text-2xl text-cream">Side by side</h2>
        <p className="mt-1 text-sm text-cream-dim">
          Two players&rsquo; ratings with the working shown — where each man&rsquo;s number came
          from, and which part of it puts one above the other.
        </p>
        {levels && (
          <p className="mt-2 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
            0 = a replacement-level player ({fmtSigned(levels.net, 2)} per 36 below the league
            average this season)
          </p>
        )}
      </header>

      <div className="mt-4">
        <ComparePickers options={options} a={aId} b={bId} />
      </div>

      {same && (
        <p className="mt-6 border-l-2 border-cat-hoops pl-3 text-sm text-cream-dim">
          That is the same man on both sides — pick two different players.
        </p>
      )}

      {!same && a && b && <PlayerCompare a={a} b={b} model={model} levels={levels} />}

      {!same && !(a && b) && (
        <p className="mt-6 text-sm text-cream-dimmer">
          {a || b
            ? "Pick the second player and the two ledgers appear side by side."
            : "Pick two players and their ledgers appear side by side."}
        </p>
      )}

      <dl className="mt-8 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule/60 pt-3 font-mono text-[0.65rem] text-cream-dimmer">
        <dt>Value as of</dt>
        <dd className="text-right text-cream-dim">{meta.valueAsOf.slice(0, 10)}</dd>
        <dt>Fit</dt>
        <dd className="text-right text-cream-dim">{meta.paramVersion}</dd>
      </dl>
    </article>
  );
}
