import type { Metadata } from "next";
import GamePage from "@/components/hoops/scores/GamePage";

export const dynamic = "force-dynamic";

// 🔴 generateMetadata is deliberately synchronous: an async one commits the
// response status before notFound() below can turn it into a 404 (the
// tracker-pages lesson in CLAUDE.md).
export function generateMetadata({ params }: { params: { game: string } }): Metadata {
  return { title: `Hoops · ${params.game.toUpperCase().replace("-", " @ ")} — hub` };
}

export default function HoopsRealBoxPage({ params }: { params: { date: string; game: string } }) {
  return <GamePage date={params.date} slug={params.game} tab="box" />;
}
