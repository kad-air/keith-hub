import GameCard from "./GameCard";
import { veilGame } from "@/lib/hoops/scores/spoiler";
import type { Game } from "@/lib/hoops/scores/types";

/**
 * One titled list of games — today's "Tonight" and "Last night", or a past
 * day's "Games". No "use client" on purpose: rendered from ScoresDay it stays
 * a server component, so under `protect` the veil is applied BEFORE the games
 * reach the client (today's scores are in neither the HTML nor the RSC
 * payload until the viewer reveals them). LastNight renders it client side,
 * always unprotected.
 */
export default function GamesSection({
  title,
  date,
  games,
  protect = false,
}: {
  title: string;
  /** The day the games are listed under (the box-score links' date). */
  date: string;
  /** null when the scoreboard couldn't be read. */
  games: Game[] | null;
  protect?: boolean;
}) {
  const list = games ?? [];
  const started = list.filter((g) => g.state !== "pre").length;
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="mb-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">
        {title}
        {list.length > 0 && <span className="text-cream-dimmer"> · {list.length}</span>}
      </h3>
      {protect && started > 0 && (
        <p className="mb-2 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          Scores hidden · hold a game to reveal it · tap to sync to where you are
        </p>
      )}
      {!games ? (
        <p className="font-display text-sm text-cream-dim">Scores unavailable right now.</p>
      ) : list.length === 0 ? (
        <p className="font-display text-sm text-cream-dim">No NBA games.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {list.map((g) => (
            <GameCard
              key={g.id}
              game={protect && g.state !== "pre" ? veilGame(g) : g}
              date={date}
              protect={protect}
            />
          ))}
        </div>
      )}
    </section>
  );
}
