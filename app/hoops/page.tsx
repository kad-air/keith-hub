import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The section landing is Scores — real games before the sim. /hoops/scores
 * already resolves today's Mountain-time date, so this only redirects.
 *
 * The Matchup screen used to live here and its pickers were in the URL
 * (`/hoops?home=DEN&away=OKC&mode=n&neutral=1`), so an old shared link that
 * carries any of those params is sent to /hoops/matchup with them intact
 * rather than dropped on today's scores.
 */
export default function HoopsLandingPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const legacy = ["home", "away", "mode", "neutral"];
  if (legacy.some((k) => searchParams[k] !== undefined)) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) params.append(k, one);
    }
    redirect(`/hoops/matchup?${params.toString()}`);
  }
  redirect("/hoops/scores");
}
