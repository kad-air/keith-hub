import Link from "next/link";
import SectionTabKeys from "@/components/SectionTabKeys";

// 🔴 There is no global sub-tab bar to hang hoops screens off — SubBar,
// HeaderNav and BottomNav were all removed upstream, and Masthead + Contents
// are the only persistent chrome. So the section self-hosts its own in-page
// nav here. Studio / Season / Tonight land in later milestones and slot into
// the same row.
//
// This answers the first half of the #68 design spike ("is /hoops one screen
// with modes, or six sibling pages with an in-section switcher?") in favour of
// SIBLING PAGES: each screen owns a route, so every result is linkable and
// server-renderable, and the switcher is this row. /hoops/sim/game/[runId] and
// /hoops/sim/players/[athleteId] are deliberately NOT tabs — they are results you
// arrive at, not destinations you navigate to, so they highlight the tab you
// came from.
//
// Compact on purpose (usability pass, 2026-09-02): the masthead already says
// "Hoops", so the old three-line preamble ("Section / Hoops / An NBA
// simulation studio. The read model is a committed snapshot…") spent a quarter
// of the first phone screen saying it again in developer words. What a reader
// actually needs above the tabs is the one fact that dates everything below:
// how far the real season had got when the model last looked.

export interface HoopsTab {
  key: string;
  label: string;
  href: string;
}

export type HoopsArea = "scores" | "sim";

// Two areas since 2026-10-29 (owner): Scores is the real NBA off ESPN
// (lib/hoops/scores/), Sim is the hoops-sim studio. Each is a section of its
// own in Contents (lib/sections.ts) with its own tab row here; the header
// names the area and links across to the other one.
export const SCORES_TABS: HoopsTab[] = [
  { key: "scores", label: "Scores", href: "/hoops/scores" },
  { key: "standings", label: "Standings", href: "/hoops/scores/standings" },
  // The 30 clubs, each with its roster, schedule and players (real, not the
  // sim's ratings — those are under Sim → Teams).
  { key: "teams", label: "Teams", href: "/hoops/scores/teams" },
];

export const SIM_TABS: HoopsTab[] = [
  // Where the real season is headed: hoops-sim's nightly rest-of-season
  // projection (season_projection) — the Sim area's landing.
  { key: "projections", label: "Projections", href: "/hoops/sim/projections" },
  { key: "matchup", label: "Matchup", href: "/hoops/sim/matchup" },
  { key: "teams", label: "Teams", href: "/hoops/sim/teams" },
  { key: "players", label: "Players", href: "/hoops/sim/players" },
];

const AREAS: Record<HoopsArea, { label: string; tabs: HoopsTab[]; other: HoopsArea }> = {
  scores: { label: "Scores", tabs: SCORES_TABS, other: "sim" },
  sim: { label: "Sim", tabs: SIM_TABS, other: "scores" },
};

const AREA_HOME: Record<HoopsArea, string> = { scores: "/hoops/scores", sim: "/hoops/sim/projections" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-04-12" → "Apr 12, 2026". String maths, never a Date round-trip. */
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

export default function HoopsNav({
  area,
  active,
  through,
}: {
  area: HoopsArea;
  /** The tab to highlight; a page that is not a tab (a game, a team, a
   *  player) passes the tab it belongs under. */
  active: string;
  /** The last real game date the bundle carries a result for — the results
   *  window's end. Null on a bundle with no results at all. Sim only. */
  through?: string | null;
}) {
  const { label, tabs, other } = AREAS[area];
  return (
    <header className="mb-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-display text-xl text-cream">
          Hoops <span className="text-cream-dimmer">·</span> {label}
        </h1>
        <div className="flex min-w-0 items-baseline gap-3">
          {through && (
            <p className="truncate font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer max-sm:hidden">
              games through {fmtDate(through)}
            </p>
          )}
          <Link
            href={AREA_HOME[other]}
            className="whitespace-nowrap font-mono text-[0.6rem] uppercase tracking-kicker text-cat-hoops hover:text-cream"
          >
            {AREAS[other].label} →
          </Link>
        </div>
      </div>
      {/* On a phone the area link takes the room beside the title, so the
          results date gets its own line rather than a clipped one. */}
      {through && (
        <p className="mt-0.5 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer sm:hidden">
          games through {fmtDate(through)}
        </p>
      )}
      {/* 1 … n switch tabs from the keyboard, in this area's order (lib/shortcuts.ts lists them). */}
      <SectionTabKeys hrefs={tabs.map((t) => t.href)} />
      <nav className="mt-3 flex gap-1.5 overflow-x-auto sm:gap-2">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className={`whitespace-nowrap border px-2 py-1 font-mono text-[0.64rem] uppercase tracking-normal transition-colors sm:px-3 sm:text-[0.7rem] sm:tracking-kicker ${
              t.key === active
                ? "border-cat-hoops/70 text-cat-hoops"
                : "border-rule/60 text-cream-dim hover:border-cat-hoops/40 hover:text-cream"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
