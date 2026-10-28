import Link from "next/link";

/**
 * The game page's two views, as sibling routes (the section's convention —
 * see HoopsNav): the box score at /hoops/scores/<date>/<game>, the
 * play-by-play at …/plays. Both hold to the viewer's synced moment under
 * spoiler mode, so moving between them never spoils.
 */
export default function GameTabs({ base, active }: { base: string; active: "box" | "plays" }) {
  const tab = (key: "box" | "plays", label: string, href: string) => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={`border-b-2 pb-1 ${active === key ? "border-cat-hoops text-cream" : "border-transparent text-cream-dimmer hover:text-cream"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="mt-4 flex gap-4 border-b border-rule/60 font-mono text-[0.66rem] uppercase tracking-kicker">
      {tab("box", "Box score", base)}
      {tab("plays", "Play-by-play", `${base}/plays`)}
    </nav>
  );
}
