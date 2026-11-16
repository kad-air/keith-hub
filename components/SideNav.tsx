"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GROUP_ORDER, SECTIONS, getCurrentSection } from "@/lib/sections";

/**
 * The desktop section rail — `lg` (1024px) and up only.
 *
 * Below `lg` the hub is navigated exactly as before: the Masthead switcher
 * opens Contents. On a laptop or monitor every section is one click away
 * instead, grouped the same way Contents groups them (GROUP_ORDER), with the
 * `g ·` chord shown on hover so the keyboard map teaches itself.
 *
 * 🔴 The rail is `position: fixed` and 13rem wide (`w-52`). The layout pads
 * everything else by the same amount at `lg` (`.hub-shell` in app/globals.css,
 * which only pads while this rail is actually on the page — /login has none),
 * and any other full-width fixed bar must start after it (`lg:left-52`) or it
 * slides under the rail. Change the width in all three places together.
 */
export default function SideNav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  const current = getCurrentSection(pathname);

  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: SECTIONS.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);

  return (
    <nav
      id="hub-sidenav"
      aria-label="Sections"
      className="fixed inset-y-0 left-0 z-50 hidden w-52 flex-col overflow-y-auto border-r border-rule/60 bg-ink/95 backdrop-blur-xl lg:flex"
    >
      <Link
        href="/"
        className="group flex h-[4.25rem] shrink-0 items-center border-b border-rule/60 px-6"
      >
        <span className="font-display text-[1.5rem] font-medium italic leading-none tracking-tight text-cream transition-colors group-hover:text-accent">
          hub
        </span>
      </Link>

      <div className="flex-1 px-3 pb-6 pt-2">
        {groups.map(({ group, items }) => (
          <div key={group} className="mt-5">
            <p className="mb-1 px-3 font-mono text-[0.58rem] uppercase tracking-[0.28em] text-cream-dimmer">
              {group}
            </p>
            <ul>
              {items.map((s) => {
                const active = s.key === current.key;
                return (
                  <li key={s.key}>
                    <Link
                      href={s.href}
                      aria-current={active ? "page" : undefined}
                      title={s.desc}
                      className={[
                        "group flex items-baseline gap-2 border-l-2 px-3 py-1.5 font-display text-[1.02rem] leading-tight transition-colors",
                        active
                          ? "border-accent bg-ink-raised/70 text-cream"
                          : "border-transparent text-cream-dim hover:border-rule-strong hover:bg-ink-raised/40 hover:text-cream",
                      ].join(" ")}
                    >
                      <span className="flex-1 truncate">{s.name}</span>
                      {s.hotkey && (
                        <span
                          aria-hidden
                          className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-cream-dimmer opacity-0 transition-opacity group-hover:opacity-100"
                        >
                          g {s.hotkey}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <p className="shrink-0 border-t border-rule/60 px-6 py-3 font-mono text-[0.56rem] uppercase tracking-[0.18em] text-cream-dimmer">
        ⌘K jump · ? keys
      </p>
    </nav>
  );
}
