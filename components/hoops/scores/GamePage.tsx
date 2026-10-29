import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import GameCard from "./GameCard";
import GameTabs from "./GameTabs";
import LiveBoxScores from "./LiveBoxScores";
import LivePlays from "./LivePlays";
import LiveProvider from "./LiveProvider";
import { SourceNote } from "./SourceNote";
import { findGame, getBox, getScoreboard, sourceMeta } from "@/lib/hoops/scores/data";
import { isGuardedDate, isIsoDate, longDate, todayIn } from "@/lib/hoops/scores/dates";
import { gameSlug } from "@/lib/hoops/scores/parse";
import { playsAt, veilGame, wirePlay } from "@/lib/hoops/scores/spoiler";

/**
 * One real game: the card, then a tab row — the box score
 * (/hoops/scores/<date>/<game>) or the play-by-play (…/plays).
 *
 * 🔴 Spoiler mode reaches this page too (owner, 2026-10-28): on TODAY's date
 * a started game is `guarded`, exactly as its card is on today's scores page.
 * The server renders the card veiled and NEITHER the box nor the plays — it
 * can't know this device's choice — and the first live tick (which carries
 * the viewer's reveal/sync) fills them in: nothing while veiled; the box
 * rebuilt from the plays up to the synced moment and only those plays while
 * synced; the live box and every play once revealed. Last night's game stays
 * guarded the same way until 3 AM Mountain (dates.ts isGuardedDate), so a
 * game synced last night is still held to its moment here after midnight.
 * Another day's game, or one not started, renders straight from the server
 * as before.
 */
export default async function GamePage({
  date,
  slug,
  tab,
}: {
  date: string;
  slug: string;
  tab: "box" | "plays";
}) {
  if (!isIsoDate(date)) notFound();
  const sb = await getScoreboard(date);
  const now = new Date();
  const today = todayIn(now);
  const isToday = date === today;
  const guardDay = isGuardedDate(date, now);
  const dayHref = isToday ? "/hoops/scores" : `/hoops/scores/${date}`;

  if (!sb.data) {
    return (
      <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
        <HoopsNav area="scores" active="scores" />
        <SourceNote fetched={[sourceMeta(sb)]} />
      </article>
    );
  }
  const game = findGame(sb.data, slug);
  if (!game) notFound();

  const guarded = guardDay && game.state !== "pre";
  // Under guard nothing past the veil is read for the render at all.
  const box = game.state === "pre" || guarded ? null : await getBox(game.id);
  const teams = box?.data?.teams ?? [];
  const plays = tab === "plays" && box?.data?.plays ? playsAt(box.data.plays, Infinity).map(wirePlay) : [];
  const tv = [
    ...game.tv.national,
    ...game.tv.away.map((n) => `${n} (${game.away.tri})`),
    ...game.tv.home.map((n) => `${n} (${game.home.tri})`),
  ];
  const base = `/hoops/scores/${date}/${gameSlug(game)}`;

  const body = (
    <>
      <p className="mb-3 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
        <Link href={dayHref} className="text-cat-hoops hover:text-cream">
          ‹ {longDate(date)}
        </Link>
      </p>
      <h2 className="mb-3 font-display text-lg text-cream">
        <Link href={`/hoops/scores/teams/${game.away.tri.toLowerCase()}`} className="hover:text-cat-hoops">
          {game.away.name}
        </Link>{" "}
        <span className="text-cream-dimmer">at</span>{" "}
        <Link href={`/hoops/scores/teams/${game.home.tri.toLowerCase()}`} className="hover:text-cat-hoops">
          {game.home.name}
        </Link>
      </h2>
      <GameCard game={guarded ? veilGame(game) : game} date={date} protect={guardDay} />
      {tv.length > 0 && (
        <p className="mt-2 font-mono text-[0.6rem] text-cream-dimmer">TV: {tv.join(", ")}</p>
      )}

      <GameTabs base={base} active={tab} />

      {game.state === "pre" ? (
        <p className="mt-6 font-display text-sm text-cream-dim">
          The {tab === "box" ? "box score" : "play-by-play"} fills in once the game tips off.
        </p>
      ) : tab === "box" ? (
        <LiveBoxScores initial={teams} gameId={game.id} guarded={guarded} />
      ) : (
        <LivePlays
          initial={plays}
          gameId={game.id}
          guarded={guarded}
          away={{ tri: game.away.tri, espnId: game.away.espnId }}
          home={{ tri: game.home.tri, espnId: game.home.espnId }}
        />
      )}

      <SourceNote fetched={(box ? [sb, box] : [sb]).map(sourceMeta)} />
    </>
  );

  // A game in progress (or about to tip) ticks in place: the card's clock,
  // totals and last play every few seconds, the box score every 6s. A
  // guarded game always has a provider: its first tick is what applies the
  // viewer's choice, and a synced view keeps following after the final.
  const watch = game.state === "in" || (game.state === "pre" && !game.postponed) || guarded;
  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav area="scores" active="scores" />
      {watch ? (
        <LiveProvider
          dates={[date]}
          gameId={game.id}
          states={{ [game.id]: game.state }}
          guarded={guardDay ? [date] : []}
          plays={tab === "plays"}
        >
          {body}
        </LiveProvider>
      ) : (
        body
      )}
    </article>
  );
}
