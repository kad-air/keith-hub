import type { BoxscoreResult, PlayerLine, Stat, TeamBox } from "@/lib/hoops/boxscore";
import { STAT_ORDER } from "@/lib/hoops/boxscore";
import { teamName } from "@/lib/hoops/rating";

const HEADER: Record<Stat, string> = {
  pts: "PTS",
  reb: "REB",
  ast: "AST",
  stl: "STL",
  blk: "BLK",
  tov: "TOV",
};

function fmt(v: number, mode: "expected" | "sample"): string {
  return mode === "sample" ? String(v) : v.toFixed(1);
}

function sortByMinutes(players: PlayerLine[]): PlayerLine[] {
  return [...players].sort((a, b) => b.minutes - a.minutes);
}

/**
 * One team's lines. STL/BLK/TOV collapse below the `sm` breakpoint — six stat
 * columns plus minutes plus a name does not fit on a phone, and the three that
 * survive are the ones a box score is actually read for.
 */
export function TeamBoxTable({
  box,
  mode,
  poss,
}: {
  box: TeamBox;
  mode: "expected" | "sample";
  poss: number;
}) {
  const players = sortByMinutes(box.players);
  const anyImputed = players.some((p) => p.ratesImputed);

  return (
    <section className="mt-6">
      <h3 className="font-display text-lg text-cream">
        <span className="font-mono text-[0.72rem] text-cat-hoops">{box.tri}</span>{" "}
        {teamName(box.tri)}
      </h3>
      <p className="mt-0.5 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
        {box.basis} · {poss.toFixed(0)} poss
        {box.omitted > 0 && ` · ${box.omitted} not projected`}
      </p>

      <ol className="mt-3">
        <li className="flex items-baseline gap-1.5 border-b border-rule/60 pb-1 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          <span className="flex-1">Player</span>
          <span className="w-10 text-right">Min</span>
          {STAT_ORDER.map((s) => (
            <span
              key={s}
              className={`w-10 text-right ${
                s === "stl" || s === "blk" || s === "tov" ? "max-sm:hidden" : ""
              }`}
            >
              {HEADER[s]}
            </span>
          ))}
          {mode === "expected" && (
            <span className="w-[4.5rem] text-right">Pts p10–p90</span>
          )}
        </li>

        {players.map((p) => (
          <li
            key={p.athlete_id}
            className="flex items-baseline gap-1.5 border-b border-rule/40 py-1.5"
          >
            <span className="flex-1 truncate font-display text-sm text-cream">
              {p.name}
              {p.ratesImputed && <span className="ml-1 text-cat-hoops">*</span>}
            </span>
            <span className="w-10 text-right font-mono text-[0.7rem] text-cream-dim">
              {p.minutes.toFixed(1)}
            </span>
            {STAT_ORDER.map((s) => (
              <span
                key={s}
                className={`w-10 text-right font-mono text-[0.72rem] ${
                  s === "pts" ? "text-cream" : "text-cream-dim"
                } ${s === "stl" || s === "blk" || s === "tov" ? "max-sm:hidden" : ""}`}
              >
                {fmt(p.stats[s], mode)}
              </span>
            ))}
            {mode === "expected" && (
              <span className="w-[4.5rem] text-right font-mono text-[0.66rem] text-cream-dimmer">
                {p.ptsP10?.toFixed(0)}–{p.ptsP90?.toFixed(0)}
              </span>
            )}
          </li>
        ))}

        <li className="flex items-baseline gap-1.5 border-b-2 border-rule pt-1.5 pb-1.5 font-mono text-[0.72rem]">
          <span className="flex-1 text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
            Totals
          </span>
          <span className="w-10 text-right text-cream-dim">{box.totals.min.toFixed(0)}</span>
          {STAT_ORDER.map((s) => (
            <span
              key={s}
              className={`w-10 text-right ${s === "pts" ? "text-cat-hoops" : "text-cream-dim"} ${
                s === "stl" || s === "blk" || s === "tov" ? "max-sm:hidden" : ""
              }`}
            >
              {fmt(box.totals[s], mode)}
            </span>
          ))}
          {mode === "expected" && <span className="w-[4.5rem]" />}
        </li>
      </ol>

      {anyImputed && (
        <p className="mt-2 font-mono text-[0.62rem] text-cream-dimmer">
          <span className="text-cat-hoops">*</span> no per-36 rates in the export — this line was
          rebuilt from per-game rates.
        </p>
      )}
    </section>
  );
}

/**
 * 🔴 The variance-honesty note. Non-negotiable on every box score
 * (HOOPS_PLAN.md §8, issue #67): it is printed on every hoops-sim CLI output
 * today and must be visible here too, never folded into an info modal.
 */
export function VarianceNote() {
  return (
    <p className="mt-5 border-l-2 border-cat-hoops pl-3 text-sm text-cream-dim">
      <span className="font-mono text-[0.62rem] uppercase tracking-kicker text-cat-hoops">
        Variance honesty
      </span>
      <br />
      Player-level spread here <em>understates</em> real game-to-game variance. There are no hot or
      cold shooting nights in this model, no minutes variance, and no usage response to matchup or
      injury — a multinomial over fixed shares is the whole mechanism. A projected 24 is a centre of
      mass, not a forecast of the night.
    </p>
  );
}

/** How the stat lines were built, in the terms the model actually works in. */
export function BoxScoreCaveats() {
  return (
    <p className="mt-3 text-xs leading-relaxed text-cream-dimmer">
      Minutes are a mechanical renormalisation of season-typical minutes onto a 240-minute team
      game, not a rotation or coach-decision model. Points come from the possession engine;
      rebounds, assists, steals, blocks and turnovers are per-possession rates times{" "}
      <em>this game&rsquo;s own</em> simulated possession count, so pace flows through every column.
      The engine itself only models points directly.
    </p>
  );
}

/** run_id + fit provenance. Always on screen — reproducibility for free. */
export function RunProvenance({
  box,
  extra,
}: {
  box: BoxscoreResult;
  extra?: React.ReactNode;
}) {
  return (
    <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-rule/60 pt-3 font-mono text-[0.62rem] text-cream-dimmer">
      <dt>run_id</dt>
      <dd className="truncate text-right text-cream-dim">{box.runId}</dd>
      <dt>Fit</dt>
      <dd className="text-right text-cream-dim">{box.paramVersion}</dd>
      <dt>Data as of</dt>
      <dd className="text-right text-cream-dim">{box.dataAsOf}</dd>
      <dt>Replicates</dt>
      <dd className="text-right text-cream-dim">{box.nSims.toLocaleString()}</dd>
      {extra}
    </dl>
  );
}
