import Link from "next/link";
import { STAT_COPY } from "@/components/hoops/PlayerExplain";
import {
  LEDGER_ORDER,
  LEDGER_SHORT,
  compareVerdict,
  ledgerLines,
  pct,
  seasonLabel,
  verdictSentence,
} from "@/lib/hoops/compare";
import type { LedgerKey, LedgerLine } from "@/lib/hoops/compare";
import { fmtSigned, teamName } from "@/lib/hoops/rating";
import type { ExplainItem, ExplainModel, PlayerRow } from "@/lib/hoops/types";

// Two players' ledgers side by side — the same rows the player page prints,
// in the same words (lib/hoops/compare.ts owns both), with a second column of
// numbers and one plain-language sentence at the bottom saying who is rated
// higher and why.
//
// Two narrow columns AT EVERY WIDTH, on purpose: a comparison read one player
// at a time is not a comparison. That is what sets every size decision here —
// four-digit numbers, short row labels, and the per-player prose moved out of
// the table into a fine-print line underneath it.

export interface ComparePlayer {
  row: PlayerRow;
  rank: { rank: number; of: number };
}

/** The colour that means "the left-hand man" everywhere on this page. */
const A_TONE = "text-cat-hoops";
const B_TONE = "text-cream";
const A_BAR = "bg-cat-hoops/70";
const B_BAR = "bg-cream/50";

const GRID = "grid grid-cols-[minmax(0,1fr)_2.45rem_2.45rem_2.45rem_2.45rem] items-baseline gap-x-1";

function lastName(n: string): string {
  return n.split(" ").slice(-1)[0] || n;
}

function num(v: number | null): string {
  return v == null ? "—" : fmtSigned(v, 2);
}

// ---------------------------------------------------------------------------
// 1. The two headers
// ---------------------------------------------------------------------------

function PlayerColumn({ p, tone }: { p: ComparePlayer; tone: string }) {
  const r = p.row;
  const net = r.stack_net_per36 ?? r.value_per36;
  return (
    <div className="min-w-0">
      <p className="truncate font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
        <Link href={`/hoops/teams/${r.tri}`} className="hover:underline">
          {r.tri} · {teamName(r.tri)}
        </Link>
      </p>
      <h3 className={`mt-0.5 font-display text-lg leading-tight ${tone}`}>
        <Link href={`/hoops/players/${r.athlete_id}`} className="hover:underline">
          {r.name}
        </Link>
      </h3>
      <p className="mt-0.5 font-mono text-[0.58rem] uppercase leading-tight tracking-kicker text-cream-dimmer">
        {p.rank.rank > 0 ? (
          <>
            #{p.rank.rank} of {p.rank.of}
            <span className="block">by value a game</span>
          </>
        ) : (
          "unranked"
        )}
      </p>
      <dl className="mt-2 space-y-1">
        <Cell label="Value / game" value={r.value_pg != null ? fmtSigned(r.value_pg, 2) : "—"} />
        <Cell
          label="Rate / 36"
          value={net != null ? fmtSigned(net, 2) : "—"}
          sub={
            r.stack_off_per36 != null && r.stack_def_per36 != null
              ? `${fmtSigned(r.stack_off_per36, 1)} off · ${fmtSigned(r.stack_def_per36, 1)} def`
              : undefined
          }
        />
        <Cell label="Expected min" value={(r.expected_minutes ?? r.minutes).toFixed(1)} />
      </dl>
    </div>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1 border-b border-rule/30 pb-1">
      <dt className="truncate font-mono text-[0.55rem] uppercase tracking-kicker text-cream-dimmer">
        {label}
      </dt>
      <dd className="shrink-0 text-right">
        <span className="font-mono text-[0.72rem] text-cream">{value}</span>
        {sub && (
          <span className="block font-mono text-[0.52rem] text-cream-dimmer">{sub}</span>
        )}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. The ledger, both men
// ---------------------------------------------------------------------------

function pairRows(
  a: LedgerLine[],
  b: LedgerLine[],
): Array<{ key: LedgerKey; op?: string; a: LedgerLine | null; b: LedgerLine | null }> {
  const ai = new Map(a.map((l) => [l.key, l]));
  const bi = new Map(b.map((l) => [l.key, l]));
  return LEDGER_ORDER.filter((k) => ai.has(k) || bi.has(k)).map((k) => ({
    key: k,
    op: (ai.get(k) ?? bi.get(k))?.op,
    a: ai.get(k) ?? null,
    b: bi.get(k) ?? null,
  }));
}

/** The per-player facts that will not fit beside four columns of numbers. */
function finePrint(p: ComparePlayer, model: ExplainModel | null): string {
  const e = p.row.explain;
  if (!e) return "no breakdown in this bundle";
  const bits: string[] = [];
  if (e.box?.minutes != null) {
    bits.push(`${Math.round(e.box.minutes).toLocaleString()} minutes of box line`);
  }
  // 🔴 The block carries `weights` even for a man with no plus-minus history
  // to mix in — printing "mixed 20% history" for him would invent a half of
  // the rating he does not have. Gate on the history, exactly as the ledger's
  // own "Mixed" row does.
  if (e.history) {
    bits.push(`history through ${seasonLabel(e.history.ref_season)}`);
    if (e.weights) {
      bits.push(
        e.weights.def !== e.weights.off
          ? `mixed ${pct(e.weights.off)} / ${pct(e.weights.def)} history`
          : `mixed ${pct(e.weights.off)} history, ${pct(1 - e.weights.off)} box`,
      );
    }
  }
  if (e.prior_floored) bits.push("scouting report set aside, under the box-evidence floor");
  bits.push(`${e.tape.n_off_poss.toLocaleString()} possessions of tape`);
  const lam = model?.lam ?? null;
  const n = Math.min(e.tape.n_off_poss, e.tape.n_def_poss);
  if (lam != null && n + lam > 0) bits.push(`${pct(n / (n + lam))} his own numbers`);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// 3. The wage sheet, paired
// ---------------------------------------------------------------------------

function Bar({ v, maxAbs, tone }: { v: number | null; maxAbs: number; tone: string }) {
  const w = v != null && maxAbs > 0 ? Math.min(1, Math.abs(v) / maxAbs) : 0;
  const pos = (v ?? 0) >= 0;
  return (
    <div className="relative h-1" aria-hidden>
      <span className="absolute left-1/2 top-0 h-full w-px bg-rule" />
      <span
        className={`absolute top-0 h-full ${tone}`}
        style={
          pos
            ? { left: "50%", width: `${(w * 50).toFixed(1)}%` }
            : { right: "50%", width: `${(w * 50).toFixed(1)}%` }
        }
      />
    </div>
  );
}

function ItemPair({
  stat,
  a,
  b,
  maxAbs,
}: {
  stat: string;
  a: ExplainItem | undefined;
  b: ExplainItem | undefined;
  maxAbs: number;
}) {
  const copy = STAT_COPY[stat] ?? { label: stat, unit: "" };
  // 🔴 THE ITEM'S OWN coef, not the pooled model's (wing-defence.md §9e) — on
  // a group-interacted wage sheet the two men can genuinely be priced at
  // different rates for the same stat (a different position group each).
  // Shown only when it's informative (both present and actually different)
  // so the tight two-column layout doesn't grow a line for every stat.
  const showCoefs = a?.coef != null && b?.coef != null && Math.abs(a.coef - b.coef) > 0.005;
  return (
    <li className="border-b border-rule/30 py-1.5">
      <div className="flex items-baseline gap-1">
        <span className="min-w-0 flex-1 truncate text-[0.78rem] text-cream-dim">{copy.label}</span>
        <span className={`w-11 shrink-0 text-right font-mono text-[0.62rem] ${A_TONE}`}>
          {num(a?.contrib ?? null)}
        </span>
        <span className={`w-11 shrink-0 text-right font-mono text-[0.62rem] ${B_TONE}`}>
          {num(b?.contrib ?? null)}
        </span>
      </div>
      {showCoefs && (
        <div className="flex items-baseline gap-1 text-[0.55rem] text-cream-dimmer">
          <span className="min-w-0 flex-1 truncate">priced at ×{(a?.coef as number).toFixed(2)} / ×{(b?.coef as number).toFixed(2)}</span>
        </div>
      )}
      <div className="mt-1 space-y-[2px]">
        <Bar v={a?.contrib ?? null} maxAbs={maxAbs} tone={A_BAR} />
        <Bar v={b?.contrib ?? null} maxAbs={maxAbs} tone={B_BAR} />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------

export default function PlayerCompare({
  a,
  b,
  model,
}: {
  a: ComparePlayer;
  b: ComparePlayer;
  model: ExplainModel | null;
}) {
  const ae = a.row.explain;
  const be = b.row.explain;
  let aShort = lastName(a.row.name);
  let bShort = lastName(b.row.name);
  if (aShort === bShort) {
    aShort = a.row.name;
    bShort = b.row.name;
  }

  const header = (
    <section className="mt-4 grid grid-cols-2 gap-3">
      <PlayerColumn p={a} tone={A_TONE} />
      <PlayerColumn p={b} tone={B_TONE} />
    </section>
  );

  // A player with no explain block: say so rather than printing an empty
  // ledger. The rating itself, and both headers, still stand.
  if (!ae || !be) {
    const missing = [!ae ? a.row.name : null, !be ? b.row.name : null].filter(Boolean).join(" and ");
    return (
      <>
        {header}
        <p className="mt-6 border-l-2 border-cat-hoops pl-3 text-sm text-cream-dim">
          We can put their ratings next to each other, but not the working: this bundle carries no
          breakdown for {missing}. Push a fresh bundle from the Mini (after{" "}
          <span className="font-mono">hoops tape-refresh</span>) and the ledger appears.
        </p>
      </>
    );
  }

  const aRows = ledgerLines(ae, model);
  const bRows = ledgerLines(be, model);
  const rows = pairRows(aRows, bRows);

  const aItems = new Map((ae.box?.items ?? []).map((it) => [it.stat, it]));
  const bItems = new Map((be.box?.items ?? []).map((it) => [it.stat, it]));
  const allItems = [...(ae.box?.items ?? []), ...(be.box?.items ?? [])];
  const maxAbs = allItems.reduce((m, it) => Math.max(m, Math.abs(it.contrib)), 0);
  const statsOn = (side: "off" | "def"): string[] =>
    Object.keys(STAT_COPY).filter((s) => {
      const it = aItems.get(s) ?? bItems.get(s);
      return it != null && it.side === side;
    });

  const v = compareVerdict(
    { name: aShort, e: ae, valuePg: a.row.value_pg },
    { name: bShort, e: be, valuePg: b.row.value_pg },
  );
  const sentence = verdictSentence(v, aShort, bShort);

  const lam = model?.lam ?? null;
  const first = model ? seasonLabel(model.seasons.first) : "the tape window";
  const last = model ? seasonLabel(model.seasons.last) : "";

  return (
    <>
      {header}

      {/* ── The ledger ───────────────────────────────────────────────── */}
      <section className="mt-7">
        <h3 className="font-display text-lg text-cream">How each rating was built</h3>
        <p className="mt-1 text-sm text-cream-dim">
          The same ledger the player pages print, one row per line — a scouting report written
          before the tape is watched, then every possession since {first}
          {last && ` through ${last}`} pulling each man away from it.
        </p>

        <ol className="mt-3">
          <li className={`${GRID} border-b border-rule/60 pb-1`}>
            <span />
            <span
              className={`col-span-2 min-w-0 truncate text-center font-mono text-[0.55rem] uppercase tracking-kicker ${A_TONE}`}
            >
              {aShort}
            </span>
            <span
              className={`col-span-2 min-w-0 truncate text-center font-mono text-[0.55rem] uppercase tracking-kicker ${B_TONE}`}
            >
              {bShort}
            </span>
          </li>
          <li className={`${GRID} border-b border-rule/30 pb-1 font-mono text-[0.55rem] uppercase tracking-kicker text-cream-dimmer`}>
            <span>per 36</span>
            <span className="text-right">Off</span>
            <span className="text-right">Def</span>
            <span className="text-right">Off</span>
            <span className="text-right">Def</span>
          </li>
          {rows.map((r) => {
            const result = r.key === "rating" || r.key === "scouting";
            const muted = r.key === "no-prior" || r.key === "floored";
            const tone = result
              ? "text-cream"
              : muted
                ? "text-cream-dimmer"
                : "text-cream-dim";
            return (
              <li
                key={r.key}
                className={`${GRID} py-1.5 ${
                  r.key === "rating"
                    ? "border-t border-rule/60 pt-2"
                    : "border-b border-rule/30"
                }`}
              >
                <span
                  className={`min-w-0 truncate text-[0.74rem] ${
                    r.key === "rating" ? "font-display text-cream" : tone
                  }`}
                >
                  <span className="font-mono text-[0.62rem] text-cream-dimmer">{r.op ?? ""}</span>{" "}
                  {LEDGER_SHORT[r.key]}
                </span>
                <span className={`text-right font-mono text-[0.62rem] ${tone}`}>
                  {num(r.a?.off ?? null)}
                </span>
                <span className={`text-right font-mono text-[0.62rem] ${tone}`}>
                  {num(r.a?.def ?? null)}
                </span>
                <span className={`text-right font-mono text-[0.62rem] ${tone}`}>
                  {num(r.b?.off ?? null)}
                </span>
                <span className={`text-right font-mono text-[0.62rem] ${tone}`}>
                  {num(r.b?.def ?? null)}
                </span>
              </li>
            );
          })}
        </ol>

        <dl className="mt-3 space-y-1 text-[0.68rem] leading-snug text-cream-dimmer">
          <div>
            <dt className={`truncate font-mono text-[0.58rem] uppercase tracking-kicker ${A_TONE}`}>
              {aShort}
            </dt>
            <dd>{finePrint(a, model)}</dd>
          </div>
          <div>
            <dt className={`truncate font-mono text-[0.58rem] uppercase tracking-kicker ${B_TONE}`}>
              {bShort}
            </dt>
            <dd>{finePrint(b, model)}</dd>
          </div>
        </dl>
      </section>

      {/* ── The wage sheet, paired ───────────────────────────────────── */}
      {maxAbs > 0 && (
        <section className="mt-8">
          <h3 className="font-display text-lg text-cream">What their lines are paid for</h3>
          <p className="mt-1 text-sm text-cream-dim">
            Each man&rsquo;s box score against the league, rate by rate, and what it earns on the
            wage sheet. Both sets of bars are drawn to one scale, so a longer bar really is a
            bigger number.
          </p>
          {/* A legend, not column headers: a name does not fit in a
              four-digit column, and truncating it to "Wemb…" helps nobody.
              The upper bar and the left figure are always the first man. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule/60 pb-1.5 font-mono text-[0.58rem] uppercase tracking-kicker">
            <span className={`flex min-w-0 items-center gap-1.5 ${A_TONE}`}>
              <span className={`h-1.5 w-4 shrink-0 ${A_BAR}`} aria-hidden />
              <span className="truncate">{aShort}</span>
            </span>
            <span className={`flex min-w-0 items-center gap-1.5 ${B_TONE}`}>
              <span className={`h-1.5 w-4 shrink-0 ${B_BAR}`} aria-hidden />
              <span className="truncate">{bShort}</span>
            </span>
          </div>
          <p className="mt-2 font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
            Offence · {fmtSigned(ae.box?.off ?? 0, 2)} vs {fmtSigned(be.box?.off ?? 0, 2)}
          </p>
          <ol className="mt-1">
            {statsOn("off").map((s) => (
              <ItemPair key={s} stat={s} a={aItems.get(s)} b={bItems.get(s)} maxAbs={maxAbs} />
            ))}
          </ol>
          <p className="mt-3 font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
            Defence · {fmtSigned(ae.box?.def ?? 0, 2)} vs {fmtSigned(be.box?.def ?? 0, 2)}
          </p>
          <ol className="mt-1">
            {statsOn("def").map((s) => (
              <ItemPair key={s} stat={s} a={aItems.get(s)} b={bItems.get(s)} maxAbs={maxAbs} />
            ))}
          </ol>
          <p className="mt-3 text-xs leading-relaxed text-cream-dimmer">
            The sheet cannot see most of defence — help rotations, deterrence, switching — so a
            defensive box line earns little either way for either man, and it is the tape that
            decides defence for anyone it has watched.
          </p>
        </section>
      )}

      {/* ── The verdict ──────────────────────────────────────────────── */}
      <section className="mt-8 border-l-2 border-cat-hoops pl-3">
        <h3 className="font-display text-lg text-cream">The short version</h3>
        <p className="mt-1 text-sm leading-relaxed text-cream-dim">{monoNumbers(sentence)}</p>
        {v.shapesDiffer && (
          <p className="mt-2 text-xs text-cream-dimmer">
            The two are priced from different ingredients — one has a plus-minus history to mix in
            and the other does not — so the reason above is picked on the coarser split both of
            them have: the scouting report against the tape.
          </p>
        )}
      </section>

      <p className="mt-6 text-xs leading-relaxed text-cream-dimmer">
        A positive defence is <em>good</em> defence — points he stops — and offence and defence add
        to a man&rsquo;s net. Every number above is read off the model&rsquo;s own fit, and the
        build checks that the rows add up to the rating on every player.
        {lam != null && (
          <>
            {" "}
            The tape&rsquo;s pull is set by one constant: at about{" "}
            <span className="font-mono">{lam.toLocaleString()}</span> possessions the model
            believes a man&rsquo;s own numbers and his scouting report equally; at ten times that,
            almost only him.
          </>
        )}
      </p>
    </>
  );
}

/** Render a generated sentence with its figures in the mono face, without
 *  letting the component invent any: the string is the single source. */
function monoNumbers(s: string): React.ReactNode[] {
  const parts = s.split(/([-+]?\d[\d,]*(?:\.\d+)?)/g);
  return parts.map((p, i) =>
    /^[-+]?\d[\d,]*(?:\.\d+)?$/.test(p) ? (
      <span key={i} className="font-mono text-cream">
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}
