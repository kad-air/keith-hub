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
// server-renderable, and the switcher is this row. /hoops/game/[runId] is
// deliberately NOT a tab — it is a result you arrive at, not a destination you
// navigate to, so it highlights Matchup while you are on it.

export interface HoopsTab {
  key: string;
  label: string;
  href: string;
}

export const HOOPS_TABS: HoopsTab[] = [
  { key: "matchup", label: "Matchup", href: "/hoops" },
  { key: "teams", label: "Teams", href: "/hoops/teams" },
];

export default function HoopsNav({ active }: { active: string }) {
  return (
    <header className="mb-6">
      <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-hoops">
        Section
      </p>
      <h1 className="mt-1 font-display text-2xl text-cream">Hoops</h1>
      <p className="mt-1 text-sm text-cream-dim">
        An NBA simulation studio. The read model is a committed snapshot from
        hoops-sim — no live connection to anything.
      </p>
      {HOOPS_TABS.length > 1 && (
        <nav className="mt-4 flex gap-2 overflow-x-auto">
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
