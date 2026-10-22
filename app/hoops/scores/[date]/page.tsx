import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ScoresDay from "@/components/hoops/scores/ScoresDay";
import { isIsoDate, shortDate } from "@/lib/hoops/scores/dates";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { date: string } }): Metadata {
  return {
    title: isIsoDate(params.date) ? `Hoops · Scores ${shortDate(params.date)} — hub` : "Hoops · Scores — hub",
  };
}

export default function HoopsScoresDatePage({ params }: { params: { date: string } }) {
  if (!isIsoDate(params.date)) notFound();
  return <ScoresDay date={params.date} />;
}
