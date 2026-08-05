import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  BoxScoreCaveats,
  RunProvenance,
  TeamBoxTable,
  VarianceNote,
} from "@/components/hoops/BoxScoreTable";
import HoopsNav from "@/components/hoops/HoopsNav";
import { encodeRunId, parseRunId } from "@/lib/hoops/matchup";
import { DEFAULT_RATING_MODE, isRatingMode } from "@/lib/hoops/queries";
import { teamName } from "@/lib/hoops/rating";
import { runSampledGame, UnknownTeamError } from "@/lib/hoops/run";

export const dynamic = "force-dynamic";

/**
 * `/hoops/game/new?home=&away=&mode=&neutral=` mints a fresh run_id and
 * redirects to it, so a rendered result ALWAYS sits at a stable, shareable
 * URL. Without this the "sim one night" action would either need a POST (not
 * linkable) or would render at a URL that re-rolls on refresh.
 */
const NEW = "new";

export function generateMetadata({ params }: { params: { runId: string } }): Metadata {
  const coords = parseRunId(params.runId);
  if (!coords) return { title: "Hoops · Game — hub" };
  return { title: `${coords.away} at ${coords.home} — Hoops` };
}

export default function HoopsGamePage({
  params,
  searchParams,
}: {
  params: { runId: string };
  searchParams: { home?: string; away?: string; mode?: string; neutral?: string };
}) {
  if (params.runId === NEW) {
    const home = searchParams.home?.toUpperCase();
    const away = searchParams.away?.toUpperCase();
    if (!home || !away || home === away) notFound();
    const runId = encodeRunId(
      {
        home,
        away,
        neutralSite: searchParams.neutral === "1",
        ratingMode: isRatingMode(searchParams.mode) ? searchParams.mode : DEFAULT_RATING_MODE,
      },
      // A wall-clock nonce is the whole point here: each visit to /new mints a
      // DIFFERENT game. The id it lands on is then permanent.
      `${Date.now()}`,
    );
    redirect(`/hoops/game/${runId}`);
  }

  const coords = parseRunId(params.runId);
  if (!coords) notFound();

  let sampled;
  try {
    sampled = runSampledGame(params.runId, coords);
  } catch (err) {
    if (err instanceof UnknownTeamError) notFound();
    throw err;
  }

  const { box } = sampled;
  const homeWon = box.homeScore > box.awayScore;
  const otLabel =
    box.nOt === 0 || box.nOt === null ? "Final" : box.nOt === 1 ? "Final / OT" : `Final / ${box.nOt}OT`;

  const rerollHref =
    `/hoops/game/new?home=${coords.home}&away=${coords.away}&mode=${coords.ratingMode}` +
    (coords.neutralSite ? "&neutral=1" : "");

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="matchup" />

      <Link
        href={`/hoops?home=${coords.home}&away=${coords.away}&mode=${coords.ratingMode}`}
        className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dimmer transition-colors hover:text-cream-dim"
      >
        ← Matchup
      </Link>

      <header className="mt-3">
        <p className="font-mono text-[0.62rem] uppercase tracking-kicker text-cat-hoops">
          {otLabel} · one simulated game
        </p>

        <div className="mt-3 border-y border-rule">
          <ScoreRow
            tri={box.away.tri}
            score={box.awayScore}
            won={!homeWon}
            note={coords.neutralSite ? "" : "away"}
          />
          <ScoreRow
            tri={box.home.tri}
            score={box.homeScore}
            won={homeWon}
            note={coords.neutralSite ? "neutral court" : "home"}
          />
        </div>

        {/* Expected vs sampled has to read as TWO QUESTIONS, not a toggle. */}
        <p className="mt-4 border-l-2 border-cat-hoops/50 pl-3 text-sm text-cream-dim">
          This is <em>one specific night</em> — a single simulated game, not an average. The lines
          below are whole numbers and they add up to the score above exactly. Reload and you get
          this same game again, forever: it is a pure function of the run_id in the URL. For what a{" "}
          <em>typical</em> night looks like, the{" "}
          <Link
            href={`/hoops?home=${coords.home}&away=${coords.away}&mode=${coords.ratingMode}`}
            className="text-cat-hoops underline decoration-cat-hoops/40 underline-offset-2"
          >
            matchup screen
          </Link>{" "}
          averages a thousand of them.
        </p>
      </header>

      <TeamBoxTable box={box.away} mode="sample" poss={box.possAway} />
      <TeamBoxTable box={box.home} mode="sample" poss={box.possHome} />

      <VarianceNote />
      <BoxScoreCaveats />

      <RunProvenance
        box={box}
        extra={
          <>
            <dt>Ratings</dt>
            <dd className="text-right text-cream-dim">{coords.ratingMode}</dd>
            <dt>Court</dt>
            <dd className="text-right text-cream-dim">
              {coords.neutralSite ? "neutral" : `${coords.home} home`}
            </dd>
          </>
        }
      />

      <p className="mt-3 text-xs leading-relaxed text-cream-dimmer">
        The run_id reproduces this game against <em>this</em> fit. A refreshed parameter blob from
        the Mac Mini replaces the model underneath it, which is why the fit version and its
        as-of date sit next to the id rather than the id standing alone.
      </p>

      <Link
        href={rerollHref}
        className="mt-6 block border border-cat-hoops/60 px-4 py-3 text-center font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops transition-colors hover:bg-cat-hoops/10"
      >
        Sim another night →
      </Link>
    </article>
  );
}

function ScoreRow({
  tri,
  score,
  won,
  note,
}: {
  tri: string;
  score: number;
  won: boolean;
  note: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5 [&:first-child]:border-b [&:first-child]:border-rule/40">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-mono text-[0.72rem] text-cat-hoops">{tri}</span>{" "}
        <span className={`font-display text-xl ${won ? "text-cream" : "text-cream-dim"}`}>
          {teamName(tri)}
        </span>
        {note && (
          <span className="ml-2 font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
            {note}
          </span>
        )}
      </span>
      <span
        className={`font-display text-3xl tabular-nums ${won ? "text-cat-hoops" : "text-cream-dim"}`}
      >
        {score}
      </span>
    </div>
  );
}
