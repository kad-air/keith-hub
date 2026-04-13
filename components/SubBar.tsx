"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const FEED_TABS = [
  { href: "/", label: "Today", match: (p: string) => p === "/" },
  { href: "/saved", label: "Saved", match: (p: string) => p.startsWith("/saved") },
  { href: "/read", label: "Read", match: (p: string) => p.startsWith("/read") },
] as const;

function isFeedRoute(pathname: string) {
  return FEED_TABS.some((t) => t.match(pathname));
}

export default function SubBar() {
  const pathname = usePathname();
  if (!isFeedRoute(pathname)) return null;

  return (
    <div className="border-t border-rule/60 bg-ink">
      <div
        className="mx-auto flex max-w-[1100px] items-stretch gap-0 overflow-x-auto px-[max(1rem,env(safe-area-inset-left))] sm:px-[max(1.5rem,env(safe-area-inset-left))] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Feed views"
      >
        {FEED_TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              role="tab"
              aria-selected={active}
              className={[
                "relative whitespace-nowrap px-4 py-3 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
                active ? "text-cream" : "text-cream-dim hover:text-cream",
              ].join(" ")}
            >
              {tab.label}
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-4 -bottom-px h-px bg-accent"
                />
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
