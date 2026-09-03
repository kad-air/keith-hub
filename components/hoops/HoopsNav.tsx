import Link from "next/link";

// 🔴 There is no global sub-tab bar to hang hoops screens off — SubBar,
// HeaderNav and BottomNav were all removed upstream, and Masthead + Contents
// are the only persistent chrome. So the section self-hosts its own in-page
// nav here. Studio / Season / Tonight land in later milestones and slot into
// the same row.
//
// This answers the first half of the #68 design spike ("is /hoops one screen
// with modes, or six sibling pages with an in-section switcher?") in favour of
// SIBLING PAGES: each screen owns a route, so every result is linkable and
// server-renderable, and the switcher is this row. /hoops/game/[runId] and
// /hoops/players/[athleteId] are deliberately NOT tabs — they are results you
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

export const HOOPS_TABS: HoopsTab[] = [
  { key: "matchup", label: "Matchup", href: "/hoops" },
  { key: "teams", label: "Teams", href: "/hoops/teams" },
  { key: "players", label: "Players", href: "/hoops/players" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-04-12" → "Apr 12, 2026". String maths, never a Date round-trip. */
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

export default function HoopsNav({
  active,
  through,
}: {
  active: string;
  /** The last real game date the bundle carries a result for — the results
   *  window's end. Null on a bundle with no results at all. */
  through?: string | null;
}) {
  return (
    <header className="mb-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-display text-xl text-cream">Hoops</h1>
        {through && (
          <p className="truncate font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
            games through {fmtDate(through)}
          </p>
        )}
      </div>
      {HOOPS_TABS.length > 1 && (
        <nav className="mt-3 flex gap-2 overflow-x-auto">
          {HOOPS_TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={`whitespace-nowrap border px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors ${
                t.key === active
                  ? "border-cat-hoops/70 text-cat-hoops"
                  : "border-rule/60 text-cream-dim hover:border-cat-hoops/40 hover:text-cream"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
