import type { Metadata } from "next";
import ScoresDay from "@/components/hoops/scores/ScoresDay";
import { todayIn } from "@/lib/hoops/scores/dates";
import { viewerTz } from "@/lib/hoops/scores/viewerTz";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hoops · Scores — hub" };

/** Today, in the viewer's time zone (Mountain until the device has said —
 *  ViewerTz.tsx). A dated URL for today renders the same view. */
export default function HoopsScoresPage() {
  return <ScoresDay date={todayIn(new Date(), viewerTz())} />;
}
