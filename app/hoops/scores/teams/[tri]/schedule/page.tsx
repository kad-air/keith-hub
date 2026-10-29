import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import LiveProvider from "@/components/hoops/scores/LiveProvider";
import { SourceNote } from "@/components/hoops/scores/SourceNote";
import TeamGameRow from "@/components/hoops/scores/TeamGameRow";
import { FRANCHISES } from "@/lib/hoops/nba-franchises";
import { getTeamGames, sourceMeta } from "@/lib/hoops/scores/data";
import { addDays, isGuardedDate, todayIn } from "@/lib/hoops/scores/dates";
import { guardGames } from "@/lib/hoops/scores/guard";
import { gameDate, teamFromSlug } from "@/lib/hoops/scores/teams";
import type { Game, GameState, SeasonKind } from "@/lib/hoops/scores/types";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { tri: string } }): Metadata {
  const tri = teamFromSlug(params.tri);
  return { title: tri ? `${FRANCHISES[tri].name} schedule — Hoops` : "Hoops · Schedule — hub" };
}

const KIND_LABEL: Record<SeasonKind, string> = {
  preseason: "Preseason",
  regular: "Regular season",
  postseason: "Playoffs",
  other: "Other",
};
const KIND_ORDER: SeasonKind[] = ["postseason", "regular", "preseason", "other"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A real club's whole season, by season type and month: every game links to
 * its game page (box score, plays) and every opponent to its team page.
 *
 * 🔴 Spoiler mode as on the team page (lib/hoops/scores/guard.ts): a started
 * game on a guarded date ships veiled; the rows pick up the viewer's reveal
 * or sync from this device under a LiveProvider. No running record is shown
 * — the team page counts one with the guarded games left out.
 */
export default async function HoopsScoresSchedulePage({ params }: { params: { tri: string } }) {
  const tri = teamFromSlug(params.tri);
  if (!tri) notFound();
  const now = new Date();
  const today = todayIn(now);
  const team = FRANCHISES[tri];

  const sched = await getTeamGames(tri, now);
  const { games, guarded } = guardGames(sched.games, now);

  // Season type, then month — newest season type first (the playoffs above
  // the regular season above the preseason), each read oldest game first.
  const sections = KIND_ORDER.map((kind) => {
    const ofKind = games.filter((g) => g.seasonKind === kind);
    const months: { key: string; label: string; games: Game[] }[] = [];
    for (const g of ofKind) {
      const d = gameDate(g.startUtc);
      const key = d.slice(0, 7);
      let m = months[months.length - 1];
      if (!m || m.key !== key) {
        m = { key, label: `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`, games: [] };
        months.push(m);
      }
      m.games.push(g);
    }
    return { kind, months };
  }).filter((s) => s.months.length > 0);

  const days = [today, addDays(today, -1)].filter(
    (d) => isGuardedDate(d, now) && games.some((g) => gameDate(g.startUtc) === d),
  );
  const states: Record<string, GameState> = Object.fromEntries(
    games.filter((g) => days.includes(gameDate(g.startUtc))).map((g) => [g.id, g.state]),
  );

  const body = !sched.games.length ? (
    <p className="font-display text-sm text-cream-dim">Schedule unavailable right now.</p>
  ) : (
    <div className="grid gap-8">
      {sections.map((s) => (
        <section key={s.kind}>
          <h3 className="mb-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">
            {KIND_LABEL[s.kind]}
          </h3>
          {s.months.map((m) => (
            <div key={m.key} className="mb-4">
              <p className="mb-0.5 font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">{m.label}</p>
              <ul>
                {m.games.map((g) => (
                  <TeamGameRow key={g.id} game={g} tri={tri} guarded={guarded.has(g.id)} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav area="scores" active="teams" />
      <p className="mb-3 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
        <Link href={`/hoops/scores/teams/${tri.toLowerCase()}`} className="text-cat-hoops hover:text-cream">
          ‹ {team.name}
        </Link>
      </p>
      <h2 className="mb-4 font-display text-lg text-cream">
        Schedule
        {sched.season && <span className="ml-2 font-mono text-[0.68rem] text-cream-dimmer">{sched.season}</span>}
      </h2>
      {days.length ? (
        <LiveProvider dates={days} states={states} guarded={days}>
          {body}
        </LiveProvider>
      ) : (
        body
      )}
      <SourceNote fetched={sched.fetched.map(sourceMeta)} />
    </article>
  );
}
