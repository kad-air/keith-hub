import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import GameCard from "@/components/hoops/scores/GameCard";
import LiveBoxScores from "@/components/hoops/scores/LiveBoxScores";
import LiveProvider from "@/components/hoops/scores/LiveProvider";
import { SourceNote } from "@/components/hoops/scores/SourceNote";
import { findGame, getBox, getScoreboard, sourceMeta } from "@/lib/hoops/scores/data";
import { isIsoDate, longDate, todayIn } from "@/lib/hoops/scores/dates";

export const dynamic = "force-dynamic";

// 🔴 generateMetadata is deliberately synchronous: an async one commits the
// response status before notFound() below can turn it into a 404 (the
// tracker-pages lesson in CLAUDE.md).
export function generateMetadata({ params }: { params: { game: string } }): Metadata {
  return { title: `Hoops · ${params.game.toUpperCase().replace("-", " @ ")} — hub` };
}

export default async function HoopsRealBoxPage({
  params,
}: {
  params: { date: string; game: string };
}) {
  if (!isIsoDate(params.date)) notFound();
  const sb = await getScoreboard(params.date);
  const dayHref = params.date === todayIn(new Date()) ? "/hoops/scores" : `/hoops/scores/${params.date}`;

  if (!sb.data) {
    return (
      <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
        <HoopsNav active="scores" />
        <SourceNote fetched={[sourceMeta(sb)]} />
      </article>
    );
  }
  const game = findGame(sb.data, params.game);
  if (!game) notFound();

  const box = game.state === "pre" ? null : await getBox(game.id);
  const teams = box?.data?.teams ?? [];
  const tv = [
    ...game.tv.national,
    ...game.tv.away.map((n) => `${n} (${game.away.tri})`),
    ...game.tv.home.map((n) => `${n} (${game.home.tri})`),
  ];

  const body = (
    <>
      <p className="mb-3 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
        <Link href={dayHref} className="text-cat-hoops hover:text-cream">
          ‹ {longDate(params.date)}
        </Link>
      </p>
      <h2 className="mb-3 font-display text-lg text-cream">
        {game.away.name} <span className="text-cream-dimmer">at</span> {game.home.name}
      </h2>
      <GameCard game={game} date={params.date} />
      {tv.length > 0 && (
        <p className="mt-2 font-mono text-[0.6rem] text-cream-dimmer">TV: {tv.join(", ")}</p>
      )}

      {game.state === "pre" ? (
        <p className="mt-6 font-display text-sm text-cream-dim">
          The box score fills in once the game tips off.
        </p>
      ) : (
        <LiveBoxScores initial={teams} />
      )}

      <SourceNote fetched={(box ? [sb, box] : [sb]).map(sourceMeta)} />
    </>
  );

  // A game in progress (or about to tip) ticks in place: the card's clock,
  // totals and last play every few seconds, the box score every 6s.
  const watch = game.state === "in" || (game.state === "pre" && !game.postponed);
  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="scores" />
      {watch ? (
        <LiveProvider dates={[params.date]} gameId={game.id} states={{ [game.id]: game.state }}>
          {body}
        </LiveProvider>
      ) : (
        body
      )}
    </article>
  );
}
