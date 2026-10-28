import type { Metadata } from "next";
import GamePage from "@/components/hoops/scores/GamePage";

export const dynamic = "force-dynamic";

// Synchronous for the same reason as the box score page next door.
export function generateMetadata({ params }: { params: { game: string } }): Metadata {
  return { title: `Hoops · ${params.game.toUpperCase().replace("-", " @ ")} play-by-play — hub` };
}

export default function HoopsRealPlaysPage({ params }: { params: { date: string; game: string } }) {
  return <GamePage date={params.date} slug={params.game} tab="plays" />;
}
