import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import PlayerLogView from "@/components/hoops/scores/PlayerLogView";
import { SourceNote } from "@/components/hoops/scores/SourceNote";
import { getPlayer } from "@/lib/hoops/queries";
import { getAthlete, getGamelog, getScoreboard, sourceMeta } from "@/lib/hoops/scores/data";
import { todayIn } from "@/lib/hoops/scores/dates";
import { guardLog } from "@/lib/hoops/scores/guard";

export const dynamic = "force-dynamic";

const ID = /^\d{1,12}$/;

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  if (!ID.test(params.id)) return { title: "Hoops · Player — hub" };
  const bio = await getAthlete(params.id);
  return { title: bio.data ? `${bio.data.name} — Hoops` : "Hoops · Player — hub" };
}


/** Does the sim carry this player? Its ids are ESPN athlete ids. A missing
 *  or unreadable bundle just drops the link. */
function inSim(id: string): boolean {
  try {
    return getPlayer(Number(id)) !== null;
  } catch {
    return false;
  }
}

/**
 * One real player: who they are, their per-game averages and game log, each
 * game linking to its box score and each opponent to its team page. Off the
 * same upstream as the scores pages; the sim's rating is one link away
 * when the sim carries them.
 *
 * 🔴 Spoiler mode (lib/hoops/scores/guard.ts): a game-log line from a
 * guarded date (today, and last night until 3 AM Mountain) ships as a bare
 * row — date and opponent, no result, no stats — and the averages are taken
 * over the shown lines only, never off the source's own season summary. The
 * hidden row links to the game page, where the reveal and sync controls are;
 * once the viewer has unlocked that game on this device, PlayerLogView asks
 * for its line and puts it, and its numbers, back.
 */
export default async function HoopsScoresPlayerPage({ params }: { params: { id: string } }) {
  if (!ID.test(params.id)) notFound();
  const now = new Date();
  const today = todayIn(now);
  const bioF = await getAthlete(params.id);
  if (!bioF.data && !bioF.error) notFound();
  const bio = bioF.data;

  // A game today for their team → the log turns over faster.
  const sb = bio?.team ? await getScoreboard(today, now) : null;
  const busyToday = !!sb?.data?.games.some((g) => g.home.tri === bio!.team!.tri || g.away.tri === bio!.team!.tri);
  const logF = await getGamelog(params.id, busyToday);
  const shown = logF.data ? guardLog(logF.data.games, now) : [];

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav area="scores" active="teams" />
      <p className="mb-3 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
        {bio?.team ? (
          <Link href={`/hoops/scores/teams/${bio.team.tri.toLowerCase()}`} className="text-cat-hoops hover:text-cream">
            ‹ {bio.team.name}
          </Link>
        ) : (
          <Link href="/hoops/scores/teams" className="text-cat-hoops hover:text-cream">
            ‹ Teams
          </Link>
        )}
      </p>

      {!bio ? (
        <p className="font-display text-sm text-cream-dim">Player unavailable right now.</p>
      ) : (
        <header>
          <h2 className="font-display text-lg text-cream">
            {bio.jersey && <span className="font-mono text-[0.72rem] text-cat-hoops">#{bio.jersey} </span>}
            {bio.name}
          </h2>
          <p className="mt-0.5 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
            {[bio.posName ?? bio.pos, bio.team?.name ?? (bio.active ? "Free agent" : "Inactive")].filter(Boolean).join(" · ")}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.68rem] sm:grid-cols-3">
            {(
              [
                ["Height", bio.height],
                ["Weight", bio.weight],
                ["Age", bio.age === null ? null : String(bio.age)],
                ["Experience", bio.experience],
                ["Draft", bio.draft],
                ["From", bio.birthPlace],
              ] as const
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[0.56rem] uppercase tracking-kicker text-cream-dimmer">{k}</dt>
                  <dd className="truncate text-cream-dim">{v}</dd>
                </div>
              ))}
          </dl>
          {inSim(bio.id) && (
            <p className="mt-3 font-mono text-[0.62rem] uppercase tracking-kicker">
              <Link href={`/hoops/sim/players/${bio.id}`} className="text-cat-hoops hover:text-cream">
                In the sim →
              </Link>
            </p>
          )}
        </header>
      )}

      {!logF.data ? (
        <p className="mt-6 font-display text-sm text-cream-dim">Game log unavailable right now.</p>
      ) : shown.length === 0 ? (
        <p className="mt-6 font-display text-sm text-cream-dim">No games yet this season.</p>
      ) : (
        <PlayerLogView playerId={params.id} shown={shown} />
      )}

      <SourceNote fetched={[bioF, logF].map(sourceMeta)} />
    </article>
  );
}
