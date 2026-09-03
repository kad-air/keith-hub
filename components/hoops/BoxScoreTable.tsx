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
 * "Shai Gilgeous-Alexander" -> "S. Gilgeous-Alexander". The phone-width name.
 *
 * A box score is read down the surname column, so the first name is the part
 * that can go — and it has to GO, not be cut off by an ellipsis: a truncated
 * "Marvin Bagle…" hides the half of the name that identifies him. Suffixes
 * (Jr., III) stay attached to the surname because two Wembanyamas or two
 * Porters are exactly when you need them.
 */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const first = parts[0];
  const rest = parts.slice(1).join(" ");
  const initial = [...first][0];
  return initial ? `${initial}. ${rest}` : name;
}

/**
 * One team's lines. STL/BLK/TOV collapse below the `sm` breakpoint — six stat
 * columns plus minutes plus a name does not fit on a phone, and the three that
 * survive are the ones a box score is actually read for. The points range
 * (p10-p90) goes with them: it is the least-read column, and the variance note
 * under every box score already says the spread out loud, so nothing is lost
 * and the table says nothing about the missing column.
 *
 * Names are first-initial-plus-surname below `sm` rather than truncated, and
 * the whole list sits in a horizontal scroller so an unusually long one moves
 * the table sideways instead of losing its own letters.
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

      {/* The last-resort valve: with the phone name and the four collapsed
          columns this list fits at 375px, but a freak name scrolls the table
          sideways rather than losing letters. */}
      <div className="mt-3 overflow-x-auto">
      <ol>
        <li className="flex items-baseline gap-1.5 border-b border-rule/60 pb-1 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          <span className="flex-1 whitespace-nowrap">Player</span>
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
            <span className="w-[4.5rem] text-right max-sm:hidden">Pts p10–p90</span>
          )}
        </li>

        {players.map((p) => (
          <li
            key={p.athlete_id}
            className="flex items-baseline gap-1.5 border-b border-rule/40 py-1.5"
          >
            <span className="flex-1 whitespace-nowrap font-display text-sm text-cream">
              <span className="sm:hidden">{shortName(p.name)}</span>
              <span className="max-sm:hidden">{p.name}</span>
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
              <span className="w-[4.5rem] text-right font-mono text-[0.66rem] text-cream-dimmer max-sm:hidden">
                {p.ptsP10?.toFixed(0)}–{p.ptsP90?.toFixed(0)}
              </span>
            )}
          </li>
        ))}

        <li className="flex items-baseline gap-1.5 border-b-2 border-rule pt-1.5 pb-1.5 font-mono text-[0.72rem]">
          <span className="flex-1 whitespace-nowrap text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
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
          {mode === "expected" && <span className="w-[4.5rem] max-sm:hidden" />}
        </li>
      </ol>
      </div>

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
