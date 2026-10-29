import type { Metadata } from "next";
import Link from "next/link";
import HoopsNav from "@/components/hoops/HoopsNav";
import ProjectionTable from "@/components/hoops/ProjectionTable";
import { fmtAsOf } from "@/lib/hoops/projections";
import { getProjection, getResultsWindow } from "@/lib/hoops/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hoops · Projections — hub" };

/**
 * The rest of the season, as hoops-sim projects it nightly: each conference
 * ordered by projected wins, with the record so far, the projected record,
 * the 80% band on wins, and the playoff / title odds. Everything on this page
 * is the sender's number, dated by the sender's own as_of_date — the hub
 * computes nothing here but the order and the formatting
 * (lib/hoops/projections.ts), so the "as of" line is the one fact that
 * tells the reader how fresh it is.
 */
export default function HoopsProjectionsPage() {
  const projection = getProjection();
  const through = getResultsWindow()?.to ?? null;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav area="sim" active="projections" through={through} />
      <h2 className="mb-1 font-display text-lg text-cream">Rest of season</h2>

      {!projection ? (
        <div className="mt-3 border border-rule/60 p-4">
          <p className="font-display text-sm text-cream-dim">
            No projection has been received yet.
          </p>
          <p className="mt-2 font-mono text-[0.62rem] leading-relaxed text-cream-dimmer">
            The Mac Mini publishes one nightly once hoops-sim declares{" "}
            <span className="text-cream-dim">season_projection</span> on its bundle. Until then the
            real table is on{" "}
            <Link href="/hoops/scores/standings" className="text-cat-hoops hover:text-cream">
              Standings
            </Link>
            .
          </p>
        </div>
      ) : (
        <>
          <p className="mb-5 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
            as of {fmtAsOf(projection.meta.asOfDate)} ·{" "}
            {projection.meta.seasonStartYear}–{String(projection.meta.seasonStartYear + 1).slice(2)}
          </p>

          <div className="grid gap-8">
            <ProjectionTable conference="East" rows={projection.teams} />
            <ProjectionTable conference="West" rows={projection.teams} />
          </div>

          <div className="mt-5 grid gap-2 font-mono text-[0.6rem] leading-relaxed text-cream-dimmer">
            <p>
              <span className="text-cream-dim">What this is.</span> Simulated{" "}
              {projection.meta.replicates.toLocaleString("en-US")} times from the standings after the games
              of {fmtAsOf(projection.meta.asOfDate)}: every remaining game is played out by the model,
              and each team&apos;s row is what happened across those seasons. Method, in the sender&apos;s
              words: {projection.meta.method}
            </p>
            <p>
              <span className="text-cream-dim">Reading the columns.</span> W-L is the real record so far;
              Proj is the average final record; 80% is the band the win total landed in four seasons out
              of five; Playoffs is a top-6 seed or a play-in win; Title is winning it all. On a narrow screen the play-in, conference-finals and finals columns
              are folded away.
            </p>
            <p>
              Rules under 6th and 10th mark the projected playoff and play-in lines by projected wins
              only — the real tiebreakers are not applied here. A projection is a distribution, not a
              prediction: a 40% title chance loses the title six times in ten.
            </p>
          </div>
        </>
      )}
    </article>
  );
}
