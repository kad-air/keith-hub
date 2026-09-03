import Link from "next/link";
import { fmtSigned } from "@/lib/hoops/rating";
import type { ExplainItem, ExplainModel, RawPlayerExplain } from "@/lib/hoops/types";

// The player page's "how we got here" — every number below comes off the
// bundle's explain block and reconciles to the rating it explains
// (check:hoops:explain re-adds it on every build). Nothing here is computed
// from a formula of our own; where a sentence needs arithmetic (the tape's
// share of the answer) the constant it uses is named on screen.
//
// Read it top to bottom as a story: what his line is worth, what his history
// said, how the two are mixed, what age costs him, and how far seven seasons
// of tape moved him from there. Basketball words, never model words.

/** The wage sheet's features, in the words a box score uses. */
export const STAT_COPY: Record<string, { label: string; unit: string }> = {
  pts: { label: "Scoring", unit: "pts / 36" },
  load: { label: "Shots used", unit: "shots + TOs / 36" },
  tov: { label: "Turnovers", unit: "TOs / 36" },
  ast: { label: "Assists", unit: "ast / 36" },
  oreb: { label: "Offensive boards", unit: "oreb / 36" },
  load_x_eff: { label: "Efficiency on volume", unit: "volume × efficiency" },
  stl: { label: "Steals", unit: "stl / 36" },
  blk: { label: "Blocks", unit: "blk / 36" },
  dreb: { label: "Defensive boards", unit: "dreb / 36" },
};

const WAGE_COPY: Array<[string, string]> = [
  ["made_2", "a made two"],
  ["made_3", "a made three"],
  ["missed_fg", "a missed shot"],
  ["turnover", "a turnover"],
  ["assist", "an assist"],
  ["oreb", "an offensive board"],
  ["steal", "a steal"],
  ["block", "a block"],
  ["dreb", "a defensive board"],
];

export function seasonLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Two numbers, offence and defence, on one row of the ledger. */
function LedgerRow({
  label,
  sub,
  off,
  def,
  emphasis,
  op,
}: {
  label: string;
  sub?: string;
  off: number | null;
  def: number | null;
  emphasis?: "result" | "muted";
  /** A leading operator glyph, so the column reads as a sum. */
  op?: string;
}) {
  const num = (v: number | null): string => (v == null ? "—" : fmtSigned(v, 2));
  const tone =
    emphasis === "result"
      ? "font-display text-base text-cream"
      : emphasis === "muted"
        ? "text-cream-dimmer"
        : "text-cream-dim";
  return (
    <li
      className={`grid grid-cols-[1.2rem_1fr_4rem_4rem] items-baseline gap-x-2 py-1.5 ${
        emphasis === "result" ? "border-t border-rule/60 pt-2" : "border-b border-rule/30"
      }`}
    >
      <span className="font-mono text-[0.7rem] text-cream-dimmer">{op ?? ""}</span>
      <span className="min-w-0">
        <span className={`block ${emphasis === "result" ? "font-display text-cream" : "text-sm text-cream-dim"}`}>
          {label}
        </span>
        {sub && <span className="block text-xs text-cream-dimmer">{sub}</span>}
      </span>
      <span className={`text-right font-mono text-sm ${tone}`}>{num(off)}</span>
      <span className={`text-right font-mono text-sm ${tone}`}>{num(def)}</span>
    </li>
  );
}

/** One wage-sheet line: what the stat earned him, as a bar around zero. */
function ItemRow({ item, maxAbs }: { item: ExplainItem; maxAbs: number }) {
  const copy = STAT_COPY[item.stat] ?? { label: item.stat, unit: "" };
  const w = maxAbs > 0 ? Math.min(1, Math.abs(item.contrib) / maxAbs) : 0;
  const pos = item.contrib >= 0;
  const isInteraction = item.stat === "load_x_eff";
  return (
    <li className="border-b border-rule/30 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-cream-dim">{copy.label}</span>
        <span className="shrink-0 font-mono text-[0.62rem] text-cream-dimmer">
          {isInteraction
            ? `${item.rate.toFixed(2)}`
            : `${item.rate.toFixed(1)} vs ${item.league.toFixed(1)} lg`}
        </span>
        <span
          className={`w-14 shrink-0 text-right font-mono text-sm ${
            pos ? "text-cream" : "text-cream-dim"
          }`}
        >
          {fmtSigned(item.contrib, 2)}
        </span>
      </div>
      {/* Bar around a centre line: right of centre helps, left hurts. */}
      <div className="relative mt-1 h-1.5" aria-hidden>
        <span className="absolute left-1/2 top-0 h-full w-px bg-rule" />
        <span
          className={`absolute top-0 h-full ${pos ? "bg-cat-hoops/70" : "bg-cream-dimmer/50"}`}
          style={
            pos
              ? { left: "50%", width: `${(w * 50).toFixed(1)}%` }
              : { right: "50%", width: `${(w * 50).toFixed(1)}%` }
          }
        />
      </div>
    </li>
  );
}

export function PlayerExplainBlock({
  name,
  e,
  model,
  net,
  expectedMinutes,
  valuePg,
}: {
  name: string;
  e: RawPlayerExplain;
  model: ExplainModel | null;
  net: number;
  expectedMinutes: number | null;
  valuePg: number | null;
}) {
  const first = model ? seasonLabel(model.seasons.first) : "the tape window";
  const last = model ? seasonLabel(model.seasons.last) : "";
  const lam = model?.lam ?? null;
  const n = Math.min(e.tape.n_off_poss, e.tape.n_def_poss);
  const ownShare = lam != null && n + lam > 0 ? n / (n + lam) : null;

  const mixed =
    e.prior_kind === "box+history" && e.history && e.box && e.weights
      ? {
          off: e.weights.off * e.history.off + (1 - e.weights.off) * e.box.off,
          def: e.weights.def * e.history.def + (1 - e.weights.def) * e.box.def,
        }
      : null;
  const scoutingOff = e.mu.off;
  const scoutingDef = e.mu.def;
  const items = e.box?.items ?? [];
  const maxAbs = items.reduce((m, it) => Math.max(m, Math.abs(it.contrib)), 0);
  const offItems = items.filter((it) => it.side === "off");
  const defItems = items.filter((it) => it.side === "def");

  return (
    <>
      {/* ── 1. The number ─────────────────────────────────────────────── */}
      <section className="mt-6">
        <h3 className="font-display text-lg text-cream">The number</h3>
        <p className="mt-1 text-sm text-cream-dim">
          {name} is worth{" "}
          <span className="font-mono text-cream">{fmtSigned(net, 2)}</span> points per 36 minutes
          against an average NBA player —{" "}
          <span className="font-mono">{fmtSigned(e.final.off, 2)}</span> of it on offence and{" "}
          <span className="font-mono">{fmtSigned(e.final.def, 2)}</span> on defence.
          {valuePg != null && expectedMinutes != null && (
            <>
              {" "}
              Over the{" "}
              <span className="font-mono">{expectedMinutes.toFixed(1)}</span> minutes we expect
              him to play, that is{" "}
              <span className="font-mono text-cream">{fmtSigned(valuePg, 2)}</span> points of
              margin a game.
            </>
          )}
        </p>
      </section>

      {/* ── 2. The ledger ─────────────────────────────────────────────── */}
      <section className="mt-6">
        <h3 className="font-display text-lg text-cream">How we got there</h3>
        <p className="mt-1 text-sm text-cream-dim">
          Two things make the rating: a <em>scouting report</em> written before the tape is
          watched, and the <em>tape</em> — every possession he has played since {first}
          {last && ` through ${last}`}, which pulls him away from the report in proportion to how
          much of him it has seen.
        </p>

        <ol className="mt-3">
          <li className="grid grid-cols-[1.2rem_1fr_4rem_4rem] gap-x-2 border-b border-rule/60 pb-1 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
            <span />
            <span>per 36 minutes</span>
            <span className="text-right">Off</span>
            <span className="text-right">Def</span>
          </li>

          {e.prior_kind === "resume" && (
            <LedgerRow
              label="His résumé"
              sub="no possessions on the tape yet — priced from box score and history alone"
              off={e.mu.off}
              def={e.mu.def}
            />
          )}
          {e.prior_kind === "rookie" && (
            <LedgerRow
              label="Draft night"
              sub="no NBA line yet: priced from draft slot, college box, age and size"
              off={e.mu.off}
              def={e.mu.def}
            />
          )}
          {e.prior_kind === "none" && (
            <LedgerRow
              label="No scouting report"
              sub="nothing to price him from before the tape — he starts at league average"
              off={0}
              def={0}
              emphasis="muted"
            />
          )}

          {e.box && (
            <LedgerRow
              label="What his box score earns"
              sub={
                e.box.minutes != null
                  ? `the wage sheet on ${Math.round(e.box.minutes).toLocaleString()} minutes of his line`
                  : "the wage sheet on his line"
              }
              off={e.box.off}
              def={e.box.def}
            />
          )}
          {e.history && (
            <LedgerRow
              label="What happened with him on the floor"
              sub={`his plus-minus history through ${seasonLabel(e.history.ref_season)}, before the tape window`}
              off={e.history.off}
              def={e.history.def}
            />
          )}
          {mixed && e.weights && (
            <LedgerRow
              op="="
              label={`Mixed ${pct(e.weights.off)} history, ${pct(1 - e.weights.off)} box score`}
              sub={
                e.weights.def !== e.weights.off
                  ? `defence is mixed ${pct(e.weights.def)} / ${pct(1 - e.weights.def)}`
                  : undefined
              }
              off={mixed.off}
              def={mixed.def}
            />
          )}
          {(e.aging.off !== 0 || e.aging.def !== 0) && (
            <LedgerRow
              op="+"
              label="A year older"
              sub="the league's own aging curve, at the strength that predicts real next seasons"
              off={e.aging.off}
              def={e.aging.def}
            />
          )}
          {e.prior_kind !== "none" && !e.prior_floored && (
            <LedgerRow
              op="="
              label="The scouting report"
              sub="what we would say before watching a possession"
              off={scoutingOff}
              def={scoutingDef}
              emphasis="result"
            />
          )}
          {e.prior_floored && (
            <LedgerRow
              op="="
              label="Scouting report set aside"
              sub={`under ${model?.prior_min_box_minutes?.toFixed(0) ?? "the floor of"} minutes of box evidence, so it is not trusted — he starts at league average instead`}
              off={0}
              def={0}
              emphasis="muted"
            />
          )}
          {e.prior_kind !== "resume" && (
            <LedgerRow
              op="+"
              label="What the tape moved him"
              sub={`${n.toLocaleString()} possessions${
                ownShare != null ? ` — about ${pct(ownShare)} his own numbers, ${pct(1 - ownShare)} the report` : ""
              }`}
              off={e.tape.move_off}
              def={e.tape.move_def}
            />
          )}
          <LedgerRow op="=" label="His rating" off={e.final.off} def={e.final.def} emphasis="result" />
        </ol>

        <p className="mt-3 text-xs leading-relaxed text-cream-dimmer">
          A positive defence is <em>good</em> defence — points he stops. Offence and defence add
          to his net. Every row above is read off the model&rsquo;s own fit, and the build checks
          that the rows add up to the rating on every player.
          {lam != null && (
            <>
              {" "}
              The tape&rsquo;s pull is set by one constant: at about{" "}
              <span className="font-mono">{lam.toLocaleString()}</span> possessions the model
              believes his own numbers and his scouting report equally; at ten times that, almost
              only him.
            </>
          )}
        </p>
      </section>

      {/* ── 3. The wage sheet, itemised ───────────────────────────────── */}
      {e.box && items.length > 0 && (
        <section className="mt-8">
          <h3 className="font-display text-lg text-cream">What his line is paid for</h3>
          <p className="mt-1 text-sm text-cream-dim">
            His box score, rate by rate, against the league — and what each one earns on the wage
            sheet. Rates are per 36 minutes, shrunk toward the league&rsquo;s the fewer minutes
            they rest on.
          </p>
          <p className="mt-2 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
            Offence · earns {fmtSigned(e.box.off, 2)} a game per 36
          </p>
          <ol className="mt-1">
            {offItems.map((it) => (
              <ItemRow key={it.stat} item={it} maxAbs={maxAbs} />
            ))}
          </ol>
          <p className="mt-3 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
            Defence · earns {fmtSigned(e.box.def, 2)} a game per 36
          </p>
          <ol className="mt-1">
            {defItems.map((it) => (
              <ItemRow key={it.stat} item={it} maxAbs={maxAbs} />
            ))}
          </ol>
          <p className="mt-3 text-xs leading-relaxed text-cream-dimmer">
            A perfectly league-average line earns{" "}
            <span className="font-mono">{fmtSigned(e.box.baseline_off, 2)}</span> on offence and{" "}
            <span className="font-mono">{fmtSigned(e.box.baseline_def, 2)}</span> on defence here;
            the bars are what {name} earns above or below that. The sheet cannot see most of
            defence — help rotations, deterrence, switching — so a defensive box line earns little
            either way, and it is the tape that decides defence for anyone it has watched.
          </p>
        </section>
      )}

      {/* ── 4. The wage sheet itself ──────────────────────────────────── */}
      {model && Object.keys(model.wage_sheet).length > 0 && (
        <section className="mt-8">
          <h3 className="font-display text-lg text-cream">The wage sheet</h3>
          <p className="mt-1 text-sm text-cream-dim">
            What this model pays a full-season starter for each event, in points. A made shot
            earns its points back on top of the possession it cost; a turnover costs the
            possession and then some.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[0.72rem] sm:grid-cols-3">
            {WAGE_COPY.filter(([k]) => model.wage_sheet[k] != null).map(([k, label]) => (
              <div key={k} className="flex items-baseline justify-between border-b border-rule/30 py-1">
                <dt className="text-cream-dimmer">{label}</dt>
                <dd className={(model.wage_sheet[k] ?? 0) >= 0 ? "text-cream" : "text-cream-dim"}>
                  {fmtSigned(model.wage_sheet[k] ?? 0, 2)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* ── 5. The tape ───────────────────────────────────────────────── */}
      {model && (
        <section className="mt-8">
          <h3 className="font-display text-lg text-cream">The tape</h3>
          <p className="mt-1 text-sm leading-relaxed text-cream-dim">
            Every possession from {first} through {last}, with all ten men on the floor named,
            solved together so a player is credited for what happened with him out there against
            who he was out there with and against. Recent seasons weigh most.
            {model.playoffs_included && " A playoff possession counts as exactly one possession."}
            {model.luck_adjusted &&
              " On defence, opponents' three-point makes are replaced by what those shots usually go in at — a hot-shooting opponent is a coin flip, not a defensive failing."}{" "}
            {name} has{" "}
            <span className="font-mono text-cream">{e.tape.n_off_poss.toLocaleString()}</span>{" "}
            possessions on it
            {e.tape.n_def_poss !== e.tape.n_off_poss && (
              <>
                {" "}
                (<span className="font-mono">{e.tape.n_def_poss.toLocaleString()}</span> on defence)
              </>
            )}
            .
          </p>
        </section>
      )}

      <p className="mt-6 text-xs text-cream-dimmer">
        Compare him on the{" "}
        <Link href="/hoops/players" className="underline hover:text-cream-dim">
          league ranking
        </Link>
        .
      </p>
    </>
  );
}
