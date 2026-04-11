"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TRACKER_CONFIGS } from "@/lib/tracker-config";
import AppMenu from "@/components/AppMenu";

const FEED_LINKS = [
  { href: "/", label: "Today" },
  { href: "/saved", label: "Saved" },
  { href: "/read", label: "Read" },
] as const;

export default function HeaderNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-5">
      {/* Feed links — hidden on mobile (BottomNav handles it) */}
      {FEED_LINKS.map((link) => {
        const isActive =
          link.href === "/"
            ? pathname === "/"
            : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={[
              "hidden font-mono text-[0.68rem] uppercase tracking-kicker transition-colors sm:inline",
              isActive
                ? "text-cream"
                : "text-cream-dim hover:text-cream",
            ].join(" ")}
          >
            {link.label}
          </Link>
        );
      })}

      <span className="hidden h-3.5 w-px bg-rule sm:inline-block" aria-hidden />

      {/* Tracker links — desktop only */}
      {TRACKER_CONFIGS.map((t) => {
        const isActive = pathname === `/trackers/${t.slug}`;
        return (
          <Link
            key={t.slug}
            href={`/trackers/${t.slug}`}
            className={[
              "hidden font-mono text-[0.68rem] uppercase tracking-kicker transition-colors sm:inline",
              isActive
                ? t.colorClass
                : "text-cream-dim hover:text-cream",
            ].join(" ")}
          >
            {t.label}
          </Link>
        );
      })}

      <AppMenu />
    </nav>
  );
}
