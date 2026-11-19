"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SectionTabKeys from "@/components/SectionTabKeys";

// The Christmas section's header: kicker, title, the countdown in sleeps, a
// little snow, and the List / Helper tabs (1 / 2 on a keyboard — rows in
// lib/shortcuts.ts). Hub type and colours; pine and gold beside the red.

const TABS = [
  { key: "list", label: "List", href: "/christmas" },
  { key: "helper", label: "Helper", href: "/christmas/helper" },
];

// Fixed positions so the server and the browser draw the same snow.
const FLAKES = [
  [4, 0, 9], [13, 3.1, 11], [22, 6.2, 8.5], [31, 1.4, 12], [40, 4.8, 10], [49, 7.5, 9.5],
  [58, 2.2, 11.5], [67, 5.6, 8], [76, 0.8, 10.5], [85, 3.9, 9], [93, 6.8, 12],
];

function sleeps(): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let xmas = new Date(now.getFullYear(), 11, 25);
  if (today > xmas) xmas = new Date(now.getFullYear() + 1, 11, 25);
  const d = Math.round((xmas.getTime() - today.getTime()) / 864e5);
  if (d === 0) return "Merry Christmas";
  if (d === 1) return "1 sleep to go";
  return `${d} sleeps to go`;
}

export default function ChristmasHeader({ active }: { active: "list" | "helper" }) {
  const [countdown, setCountdown] = useState("");
  useEffect(() => setCountdown(sleeps()), []);
  return (
    <header className="relative mb-6">
      <div aria-hidden className="xmas-snow">
        {FLAKES.map(([left, delay, dur], i) => (
          <span
            key={i}
            style={{ left: `${left}%`, animationDelay: `${delay}s`, animationDuration: `${dur}s`, fontSize: `${0.55 + (i % 3) * 0.2}rem` }}
          >
            ✻
          </span>
        ))}
      </div>
      <p className="relative font-mono text-[0.62rem] uppercase tracking-kicker text-cat-xmas">The Adairs · 2026</p>
      <div className="relative mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="font-display text-[2.1rem] italic leading-none tracking-tight text-cream sm:text-[2.6rem]">
          Christmas<span className="text-accent">.</span>
        </h1>
        <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cat-xmas-gold" suppressHydrationWarning>
          {countdown && <>✶ {countdown}</>}
        </p>
      </div>
      <SectionTabKeys hrefs={TABS.map((t) => t.href)} />
      <nav className="relative mt-4 flex gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className={`whitespace-nowrap border px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors ${
              t.key === active
                ? "border-accent/70 text-accent"
                : "border-rule/60 text-cream-dim hover:border-accent/40 hover:text-cream"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
