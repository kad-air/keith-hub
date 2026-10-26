"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useKeyboard } from "@/lib/useKeyboard";

/**
 * Prev / next day, a date picker and a jump back to today. `p` / `n` step a
 * day from the keyboard (lib/shortcuts.ts lists them). Every day is a URL, so
 * the picker just navigates — there is no client state to lose.
 */
export default function ScoresDayNav({
  date,
  today,
  prev,
  next,
  label,
}: {
  date: string;
  today: string;
  prev: string;
  next: string;
  label: string;
}) {
  const router = useRouter();
  const href = (d: string) => (d === today ? "/hoops/scores" : `/hoops/scores/${d}`);
  useKeyboard({
    p: () => router.push(href(prev)),
    n: () => router.push(href(next)),
  });

  const btn =
    "border border-rule/60 px-2.5 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-hoops/40 hover:text-cream";

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-2">
        <Link href={href(prev)} className={btn} aria-label="Previous day" rel="prev">
          ‹ <span className="max-sm:hidden">Prev</span>
        </Link>
        <h2 className="min-w-0 flex-1 text-center font-display text-base text-cream sm:text-lg">
          {label}
        </h2>
        <Link href={href(next)} className={btn} aria-label="Next day" rel="next">
          <span className="max-sm:hidden">Next</span> ›
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-2 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
          Go to
          <input
            type="date"
            value={date}
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) router.push(href(v));
            }}
            className="border border-rule/60 bg-ink-raised px-2 py-1 font-mono text-[0.72rem] text-cream focus:border-cat-hoops focus:outline-none"
          />
        </label>
        {date !== today && (
          <Link
            href="/hoops/scores"
            className="font-mono text-[0.62rem] uppercase tracking-kicker text-cat-hoops hover:text-cream"
          >
            Today
          </Link>
        )}
      </div>
    </div>
  );
}
