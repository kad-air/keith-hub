"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { TRACKER_CONFIGS } from "@/lib/tracker-config";

const FEED_TABS = [
  { href: "/", label: "Today" },
  { href: "/saved", label: "Saved" },
  { href: "/read", label: "Read" },
] as const;

export default function BottomNav() {
  const pathname = usePathname();
  const [trackersOpen, setTrackersOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const activeTracker = TRACKER_CONFIGS.find(
    (t) => pathname === `/trackers/${t.slug}`,
  );
  const isOnComics = pathname.startsWith("/comics");
  const isOnTracker = !!activeTracker || isOnComics;

  // Close popover on outside tap or navigation
  useEffect(() => {
    if (!trackersOpen) return;
    function onTap(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setTrackersOpen(false);
      }
    }
    document.addEventListener("mousedown", onTap);
    return () => document.removeEventListener("mousedown", onTap);
  }, [trackersOpen]);

  // Close on navigation
  useEffect(() => {
    setTrackersOpen(false);
  }, [pathname]);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-rule/60 bg-ink/95 sm:hidden"
      role="navigation"
      aria-label="Primary"
    >
      <div className="mx-auto flex max-w-[720px] items-stretch justify-around px-[max(0.5rem,env(safe-area-inset-left))] pb-[env(safe-area-inset-bottom)]">
        {FEED_TABS.map((tab) => {
          const isActive =
            tab.href === "/"
              ? pathname === "/"
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={[
                "relative flex flex-1 items-center justify-center py-3 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
                isActive ? "text-cream" : "text-cream-dimmer",
              ].join(" ")}
            >
              {tab.label}
              {isActive && (
                <span className="absolute top-0 left-1/4 right-1/4 h-[2px] bg-accent" />
              )}
            </Link>
          );
        })}

        {/* Divider */}
        <span
          aria-hidden
          className="my-2.5 w-px bg-rule/60"
        />

        {/* Trackers toggle */}
        <div ref={popoverRef} className="relative flex flex-1">
          <button
            type="button"
            onClick={() => setTrackersOpen((v) => !v)}
            className={[
              "flex flex-1 items-center justify-center gap-1 py-3 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
              isOnTracker ? "text-cream" : "text-cream-dimmer",
            ].join(" ")}
          >
            <span>{activeTracker?.label ?? (isOnComics ? "Comics" : "Trackers")}</span>
            <svg
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={[
                "transition-transform duration-150",
                trackersOpen ? "rotate-180" : "",
              ].join(" ")}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            {isOnTracker && (
              <span className="absolute top-0 left-1/4 right-1/4 h-[2px] bg-accent" />
            )}
          </button>

          {/* Tracker popover */}
          {trackersOpen && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-36 border border-rule-strong bg-ink-raised/95 shadow-2xl shadow-black/40 backdrop-blur-md animate-fade-in">
              {TRACKER_CONFIGS.map((t) => {
                const isActiveTracker = pathname === `/trackers/${t.slug}`;
                return (
                  <Link
                    key={t.slug}
                    href={`/trackers/${t.slug}`}
                    className={[
                      "flex items-center gap-2.5 px-4 py-2.5 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
                      isActiveTracker
                        ? `${t.colorClass}`
                        : "text-cream-dim hover:text-cream",
                    ].join(" ")}
                  >
                    <span
                      aria-hidden
                      className={[
                        "h-1.5 w-1.5 rounded-full",
                        isActiveTracker ? "bg-current" : "bg-rule-strong",
                      ].join(" ")}
                    />
                    {t.label}
                  </Link>
                );
              })}
              <Link
                href="/comics"
                className={[
                  "flex items-center gap-2.5 border-t border-rule/40 px-4 py-2.5 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
                  isOnComics
                    ? "text-accent"
                    : "text-cream-dim hover:text-cream",
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "h-1.5 w-1.5 rounded-full",
                    isOnComics ? "bg-current" : "bg-rule-strong",
                  ].join(" ")}
                />
                Comics
              </Link>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
