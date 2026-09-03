import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CompareWithPicker } from "@/components/hoops/ComparePicker";
import type { PickOption } from "@/components/hoops/ComparePicker";
import HoopsNav from "@/components/hoops/HoopsNav";
import { PlayerExplainBlock } from "@/components/hoops/PlayerExplain";
import { rankPlayers } from "@/lib/hoops/playervalue";
import {
  getAllPlayers,
  getExplainModel,
  getHoopsMeta,
  getPlayer,
  getResultsWindow,
} from "@/lib/hoops/queries";
import { fmtSigned, teamName } from "@/lib/hoops/rating";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { athleteId: string } }): Metadata {
  const p = getPlayer(Number(params.athleteId));
  return { title: p ? `${p.name} — Hoops` : "Hoops · Player — hub" };
}

/**
 * One player: his rating, and HOW the model came to it. The ledger and the
 * itemised wage sheet come straight off the bundle's explain block; the
 * league ranks are computed here over the same rows /hoops/players ranks.
 */
export default function HoopsPlayerPage({ params }: { params: { athleteId: string } }) {
  const id = Number(params.athleteId);
  if (!Number.isInteger(id)) notFound();
  const p = getPlayer(id);
  if (!p) notFound();

  const meta = getHoopsMeta();
  const model = getExplainModel();
  const all = getAllPlayers();
  const floor = meta.rotationFloorMinutes;
  const rankOf = (sort: "value" | "off" | "def" | "net"): { rank: number; of: number } => {
    const ranked = rankPlayers(all, sort, floor);
    const me = ranked.find((r) => r.athlete_id === id);
    return { rank: me?.rank ?? 0, of: ranked.filter((r) => r.rank > 0).length };
  };
  const rValue = rankOf("value");
  // Offence/defence ranks on the STACK rating's own halves — the rating this
  // page explains — never on the older flagship split the ranking's Off/Def
  // sorts use (Jokić reads defence #89 on that one and +1.67 here; the two
  // are different models, and a page must not rank one by the other).
  const stackRank = (key: "stack_off_per36" | "stack_def_per36"): { rank: number; of: number } => {
    const vals = all.filter((r) => r[key] != null).map((r) => r[key] as number);
    const mine = p[key];
    if (mine == null) return { rank: 0, of: vals.length };
    return { rank: 1 + vals.filter((v) => v > mine).length, of: vals.length };
  };
  const rOff = stackRank("stack_off_per36");
  const rDef = stackRank("stack_def_per36");

  const net = p.stack_net_per36 ?? p.value_per36;
  const gr = p.game_rates;
  // The whole league, three fields each, for the "Compare with…" select.
  const compareOptions: PickOption[] = all.map((r) => ({
    athlete_id: r.athlete_id,
    name: r.name,
    tri: r.tri,
  }));
  const through = getResultsWindow()?.to ?? null;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="players" through={through} />

      <Link
        href={`/hoops/players?team=${p.tri}`}
        className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dimmer transition-colors hover:text-cream-dim"
      >
        ← Players
      </Link>

      <header className="mt-3">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-hoops">
          <Link href={`/hoops/teams/${p.tri}`} className="hover:underline">
            {p.tri} · {teamName(p.tri)}
          </Link>
        </p>
        <h2 className="mt-1 font-display text-3xl text-cream">{p.name}</h2>
        <p className="mt-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          {rValue.rank > 0 ? `#${rValue.rank} of ${rValue.of} by value a game` : "unranked"}
          {rOff.rank > 0 && ` · offence #${rOff.rank}`}
          {rDef.rank > 0 && ` · defence #${rDef.rank}`}
        </p>
        {/* The comparison is a link, so this is only a shortcut into it. */}
        <CompareWithPicker options={compareOptions} self={id} />
      </header>

      <dl className="mt-5 grid grid-cols-3 gap-2 border-y border-rule/60 py-3">
        <Stat
          label="Value / game"
          value={p.value_pg != null ? fmtSigned(p.value_pg, 2) : "—"}
          sub="margin vs average"
        />
        <Stat
          label="Rate / 36"
          value={net != null ? fmtSigned(net, 2) : "—"}
          sub={
            p.stack_off_per36 != null && p.stack_def_per36 != null
              ? `${fmtSigned(p.stack_off_per36, 1)} off · ${fmtSigned(p.stack_def_per36, 1)} def`
              : "no rating"
          }
        />
        <Stat
          label="Expected min"
          value={(p.expected_minutes ?? p.minutes).toFixed(1)}
          sub={p.evidence ?? ""}
        />
      </dl>

      {gr && (
        <p className="mt-3 text-sm text-cream-dim">
          This season: <span className="font-mono">{gr.pts.toFixed(1)}</span> points,{" "}
          <span className="font-mono">{gr.reb.toFixed(1)}</span> rebounds,{" "}
          <span className="font-mono">{gr.ast.toFixed(1)}</span> assists a game in{" "}
          <span className="font-mono">{gr.gp}</span> games
          {p.per36 && (
            <>
              {" "}
              — per 36, <span className="font-mono">{p.per36.fg3m.toFixed(1)}</span> threes,{" "}
              <span className="font-mono">{p.per36.stl.toFixed(1)}</span> steals,{" "}
              <span className="font-mono">{p.per36.blk.toFixed(1)}</span> blocks,{" "}
              <span className="font-mono">{p.per36.tov.toFixed(1)}</span> turnovers
            </>
          )}
          .
        </p>
      )}
      {!gr && (
        <p className="mt-3 text-sm text-cream-dimmer">No games this season.</p>
      )}

      {p.explain && net != null ? (
        <PlayerExplainBlock
          name={p.name.split(" ").slice(-1)[0] || p.name}
          e={p.explain}
          model={model}
          net={net}
          expectedMinutes={p.expected_minutes}
          valuePg={p.value_pg}
        />
      ) : (
        <p className="mt-6 border-l-2 border-cat-hoops pl-3 text-sm text-cream-dim">
          {p.stack_net_per36 == null
            ? "The model has no rating for him — nothing to explain yet."
            : "This bundle carries the rating but not the ingredients behind it. Push a fresh bundle from the Mini (after `hoops tape-refresh`) and the breakdown appears."}
        </p>
      )}

      <dl className="mt-8 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-rule/60 pt-3 font-mono text-[0.65rem] text-cream-dimmer">
        <dt>Value as of</dt>
        <dd className="text-right text-cream-dim">{meta.valueAsOf.slice(0, 10)}</dd>
        <dt>Fit</dt>
        <dd className="text-right text-cream-dim">{meta.paramVersion}</dd>
        <dt>Athlete id</dt>
        <dd className="text-right text-cream-dim">{p.athlete_id}</dd>
      </dl>
    </article>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
        {label}
      </dt>
      <dd className="mt-0.5 font-display text-lg text-cream">{value}</dd>
      <dd className="truncate font-mono text-[0.58rem] text-cream-dimmer">{sub}</dd>
    </div>
  );
}
