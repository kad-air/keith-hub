import type { Metadata } from "next";
import ScoresDay from "@/components/hoops/scores/ScoresDay";
import { todayIn } from "@/lib/hoops/scores/dates";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hoops · Scores — hub" };

/** Today, in Mountain time. A dated URL for today renders the same view. */
export default function HoopsScoresPage() {
  return <ScoresDay date={todayIn(new Date())} />;
}
