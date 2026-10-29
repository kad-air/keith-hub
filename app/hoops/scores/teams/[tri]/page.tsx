import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import LiveProvider from "@/components/hoops/scores/LiveProvider";
import { SourceNote } from "@/components/hoops/scores/SourceNote";
import TeamGameRow from "@/components/hoops/scores/TeamGameRow";
import { FRANCHISES } from "@/lib/hoops/nba-franchises";
import { getRoster, getTeamGames, sourceMeta } from "@/lib/hoops/scores/data";
import { addDays, isGuardedDate, todayIn } from "@/lib/hoops/scores/dates";
import { guardGames, guardRoster, teamRecord, type TeamRecord } from "@/lib/hoops/scores/guard";
import { gameDate, teamFromSlug } from "@/lib/hoops/scores/teams";
import type { Game, GameState } from "@/lib/hoops/scores/types";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { tri: string } }): Metadata {
  const tri = teamFromSlug(params.tri);
  return { title: tri ? `${FRANCHISES[tri].name} — Hoops` : "Hoops · Team — hub" };
}

const NEXT_N = 3;
const RECENT_N = 5;

/**
 * One real club: its record, the next few games and the last few, and the
 * roster, every player linking to their page. Off the same upstream as the
 * scores pages (ESPN's site API), not the hoops-sim bundle — the sim's view of
 * the team is one link away.
 *
 * 🔴 Spoiler mode, the scores list's own rule (lib/hoops/scores/guard.ts): a
 * game that has started on a guarded date (today, and last night until 3 AM
 * Mountain) ships veiled, and the record, home/road split, streak and
 * last-five strip are counted WITHOUT it. Under a LiveProvider the rows pick
 * up the viewer's reveal or sync from this device, as the scores list's cards
 * do; the record stays the server's (it can't see that choice), so it keeps
 * leaving the game out and says so. An injury stamped since the guarded tip
 * is held too.
 */
export default async function HoopsScoresTeamPage({ params }: { params: { tri: string } }) {
  const tri = teamFromSlug(params.tri);
  if (!tri) notFound();
  const slug = tri.toLowerCase();
  const now = new Date();
  const today = todayIn(now);
  const team = FRANCHISES[tri];

  const [sched, rosterF] = await Promise.all([getTeamGames(tri, now), getRoster(tri)]);
  const raw = sched.games;
  const { games, guarded } = guardGames(raw, now);

  const regular = teamRecord(raw, tri, now, "regular", RECENT_N);
  const preseason = teamRecord(raw, tri, now, "preseason", RECENT_N);
  const playoffs = teamRecord(raw, tri, now, "postseason", RECENT_N);
  const started = (r: TeamRecord) => r.wins + r.losses + r.held > 0;
  const headline = started(playoffs)
    ? { label: "Playoffs", rec: playoffs }
    : started(regular)
      ? { label: null, rec: regular }
      : started(preseason)
        ? { label: "Preseason", rec: preseason }
        : null;

  const upcoming = games.filter((g) => g.state === "pre" && !g.postponed).slice(0, NEXT_N);
  const recent = games
    .filter((g) => g.state !== "pre")
    .slice(-RECENT_N)
    .reverse();

  const roster = rosterF.data ? guardRoster(rosterF.data, raw, now) : null;

  // The rows tick when this page lists a guarded day's game (a viewer's
  // reveal or sync applies) or a game today (a tip turns the row live).
  const shown = [...upcoming, ...recent];
  const days = [today, addDays(today, -1)].filter(
    (d) => isGuardedDate(d, now) && shown.some((g) => gameDate(g.startUtc) === d),
  );
  const states: Record<string, GameState> = Object.fromEntries(
    shown.filter((g) => days.includes(gameDate(g.startUtc))).map((g) => [g.id, g.state]),
  );

  const row = (g: Game) => <TeamGameRow key={g.id} game={g} tri={tri} guarded={guarded.has(g.id)} />;

  const body = (
    <>
      <section className="mt-6">
        <h3 className="mb-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">Next</h3>
        {upcoming.length ? (
          <ul>{upcoming.map(row)}</ul>
        ) : (
          <p className="font-display text-sm text-cream-dim">Nothing scheduled.</p>
        )}
      </section>
      {recent.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">Recent</h3>
          <ul>{recent.map(row)}</ul>
        </section>
      )}
      <p className="mt-2 font-mono text-[0.62rem] uppercase tracking-kicker">
        <Link href={`/hoops/scores/teams/${slug}/schedule`} className="text-cat-hoops hover:text-cream">
          Full schedule →
        </Link>
      </p>
    </>
  );

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav area="scores" active="teams" />
      <p className="mb-3 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
        <Link href="/hoops/scores/teams" className="text-cat-hoops hover:text-cream">
          ‹ Teams
        </Link>
      </p>

      <header>
        <h2 className="font-display text-lg text-cream">
          <span className="font-mono text-[0.72rem] text-cat-hoops">{tri}</span> {team.name}
        </h2>
        <p className="mt-0.5 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          {team.conference} · {team.division}
          {sched.season && ` · ${sched.season}`}
        </p>
        {headline && <RecordLine label={headline.label} rec={headline.rec} />}
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.62rem] uppercase tracking-kicker">
          <Link href={`/hoops/scores/teams/${slug}/schedule`} className="text-cat-hoops hover:text-cream">
            Schedule
          </Link>
          <Link href="/hoops/scores/standings" className="text-cat-hoops hover:text-cream">
            Standings
          </Link>
          <Link href={`/hoops/sim/teams/${tri}`} className="text-cat-hoops hover:text-cream">
            In the sim →
          </Link>
        </p>
      </header>

      {days.length ? (
        <LiveProvider dates={days} states={states} guarded={days}>
          {body}
        </LiveProvider>
      ) : (
        body
      )}

      <section className="mt-8">
        <h3 className="mb-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">Roster</h3>
        {!roster ? (
          <p className="font-display text-sm text-cream-dim">Roster unavailable right now.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap font-mono text-[0.72rem] tabular-nums">
                <thead>
                  <tr className="border-b border-rule/60 text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
                    <th className="w-7 pb-1 text-right font-normal">#</th>
                    <th className="pb-1 pl-2 text-left font-normal">Player</th>
                    <th className="px-1.5 pb-1 text-left font-normal">Pos</th>
                    <th className="px-1.5 pb-1 text-right font-normal">Ht</th>
                    <th className="px-1.5 pb-1 text-right font-normal max-sm:hidden">Wt</th>
                    <th className="px-1.5 pb-1 text-right font-normal">Age</th>
                    <th className="px-1.5 pb-1 text-right font-normal max-sm:hidden">Exp</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.roster.players.map((p) => (
                    <tr key={p.id} className="border-b border-rule/30">
                      <td className="py-1.5 text-right text-cream-dimmer">{p.jersey ?? ""}</td>
                      <td className="pl-2 text-left">
                        <Link
                          href={`/hoops/scores/players/${p.id}`}
                          className="font-display text-sm text-cream hover:text-cat-hoops"
                          data-kb-item
                        >
                          {p.name}
                        </Link>
                        {p.injury && (
                          <span className="ml-1.5 text-[0.6rem] uppercase text-cat-hoops">{p.injury.status}</span>
                        )}
                      </td>
                      <td className="px-1.5 text-left text-cream-dim">{p.pos ?? ""}</td>
                      <td className="px-1.5 text-right text-cream-dim">{p.height ?? ""}</td>
                      <td className="px-1.5 text-right text-cream-dim max-sm:hidden">{p.weight ?? ""}</td>
                      <td className="px-1.5 text-right text-cream-dim">{p.age ?? ""}</td>
                      <td className="px-1.5 text-right text-cream-dim max-sm:hidden">
                        {p.experience === null ? "" : p.experience === 0 ? "R" : p.experience}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {roster.roster.coach && (
              <p className="mt-2 font-mono text-[0.62rem] text-cream-dimmer">Head coach: {roster.roster.coach}</p>
            )}
            {roster.heldInjuries > 0 && (
              <p className="mt-1 font-mono text-[0.62rem] text-cream-dimmer">
                {roster.heldInjuries === 1 ? "One injury update" : `${roster.heldInjuries} injury updates`} since the
                guarded tip {roster.heldInjuries === 1 ? "is" : "are"} hidden until the 3 AM spoiler window ends.
              </p>
            )}
          </>
        )}
      </section>

      <SourceNote fetched={[...sched.fetched, rosterF].map(sourceMeta)} />
    </article>
  );
}

function RecordLine({ label, rec }: { label: string | null; rec: TeamRecord }) {
  const split = (s: [number, number]) => `${s[0]}-${s[1]}`;
  return (
    <div className="mt-2 font-mono text-[0.72rem] tabular-nums text-cream-dim">
      <p>
        {label && <span className="text-cream-dimmer">{label} </span>}
        <span className="text-base text-cream">
          {rec.wins}-{rec.losses}
        </span>
        <span className="text-cream-dimmer"> · home </span>
        {split(rec.home)}
        <span className="text-cream-dimmer"> · road </span>
        {split(rec.road)}
        {rec.streak && (
          <>
            <span className="text-cream-dimmer"> · </span>
            {rec.streak}
          </>
        )}
        {rec.recent.length > 0 && (
          <span className="ml-2 tracking-[0.15em]">
            {rec.recent.map((r, i) => (
              <span key={i} className={r === "W" ? "text-cat-hoops" : "text-cream-dimmer"}>
                {r}
              </span>
            ))}
          </span>
        )}
      </p>
      {rec.held > 0 && (
        <p className="mt-0.5 text-[0.62rem] text-cream-dimmer">
          Leaves out {rec.held === 1 ? "a game" : `${rec.held} games`} under spoiler protection until 3 AM.
        </p>
      )}
    </div>
  );
}
