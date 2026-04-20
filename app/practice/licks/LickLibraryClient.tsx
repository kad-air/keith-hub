"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type {
  Lick,
  LickDifficulty,
  LickTag,
} from "@/lib/practice/licks";

type Filter = "all" | "unlearned" | "learned";
type DifficultyFilter = 0 | 1 | 2 | 3; // 0 = any

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unlearned", label: "To learn" },
  { value: "learned", label: "Learned" },
];

// Aggregate tag counts so the filter chips only show tags that actually appear.
function uniqueTags(licks: Lick[]): LickTag[] {
  const set = new Set<LickTag>();
  for (const l of licks) for (const t of l.teaches) set.add(t);
  return Array.from(set).sort();
}

function difficultyLabel(d: LickDifficulty): string {
  return ["", "Beginner", "Intermediate", "Stretch"][d] ?? String(d);
}

function tagLabel(t: LickTag): string {
  return t.replace(/-/g, " ");
}

export function LickLibraryClient({
  licks,
  initialLearned,
}: {
  licks: Lick[];
  initialLearned: string[];
}) {
  const [learned] = useState<Set<string>>(() => new Set(initialLearned));
  const [filter, setFilter] = useState<Filter>("all");
  const [difficulty, setDifficulty] = useState<DifficultyFilter>(0);
  const [activeTag, setActiveTag] = useState<LickTag | null>(null);

  const allTags = useMemo(() => uniqueTags(licks), [licks]);

  const visible = useMemo(() => {
    return licks.filter((l) => {
      if (filter === "learned" && !learned.has(l.id)) return false;
      if (filter === "unlearned" && learned.has(l.id)) return false;
      if (difficulty !== 0 && l.difficulty !== difficulty) return false;
      if (activeTag && !l.teaches.includes(activeTag)) return false;
      return true;
    });
  }, [licks, filter, difficulty, activeTag, learned]);

  return (
    <article className="mx-auto max-w-[900px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
          Practice · Licks
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">
          A-minor pentatonic vocabulary
        </h1>
        <p className="mt-1 text-sm text-cream-dim">
          {learned.size} of {licks.length} learned · box 1 focus for v1.
        </p>
      </header>

      <div className="mb-5 space-y-3">
        <div
          role="tablist"
          aria-label="Learned filter"
          className="flex gap-0 border-b border-rule/60"
        >
          {FILTERS.map((f) => {
            const active = f.value === filter;
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.value)}
                className={[
                  "relative whitespace-nowrap px-4 py-2 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
                  active
                    ? "text-cream"
                    : "text-cream-dim hover:text-cream",
                ].join(" ")}
              >
                {f.label}
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-4 -bottom-px h-px bg-cat-practice"
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
            Difficulty
          </span>
          {[0, 1, 2, 3].map((d) => {
            const active = d === difficulty;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDifficulty(d as DifficultyFilter)}
                aria-pressed={active}
                className={[
                  "rounded-sm border px-2.5 py-1 font-mono text-[0.7rem] transition-colors",
                  active
                    ? "border-cat-practice bg-cat-practice/15 text-cream"
                    : "border-rule/60 bg-ink-raised/30 text-cream-dim hover:border-cat-practice/60",
                ].join(" ")}
              >
                {d === 0 ? "Any" : difficultyLabel(d as LickDifficulty)}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer mr-1">
            Teaches
          </span>
          <button
            type="button"
            onClick={() => setActiveTag(null)}
            aria-pressed={activeTag === null}
            className={[
              "rounded-sm border px-2 py-0.5 font-mono text-[0.65rem] transition-colors",
              activeTag === null
                ? "border-cat-practice bg-cat-practice/15 text-cream"
                : "border-rule/60 bg-ink-raised/30 text-cream-dim hover:border-cat-practice/60",
            ].join(" ")}
          >
            any
          </button>
          {allTags.map((t) => {
            const active = t === activeTag;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setActiveTag(active ? null : t)}
                aria-pressed={active}
                className={[
                  "rounded-sm border px-2 py-0.5 font-mono text-[0.65rem] transition-colors",
                  active
                    ? "border-cat-practice bg-cat-practice/15 text-cream"
                    : "border-rule/60 bg-ink-raised/30 text-cream-dim hover:border-cat-practice/60",
                ].join(" ")}
              >
                {tagLabel(t)}
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="py-12 text-center text-sm text-cream-dim">
          No licks match those filters.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visible.map((l) => {
            const isLearned = learned.has(l.id);
            return (
              <li key={l.id}>
                <Link
                  href={`/practice/licks/${l.id}`}
                  className="block h-full border border-rule/60 bg-ink-raised/40 p-4 transition-colors hover:border-cat-practice/60 hover:bg-ink-raised/70"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="font-display text-base text-cream">
                      {l.name}
                    </h2>
                    <span
                      className={[
                        "font-mono text-[0.65rem] uppercase tracking-kicker",
                        isLearned
                          ? "text-cat-practice"
                          : "text-cream-dimmer",
                      ].join(" ")}
                    >
                      {isLearned ? "learned" : difficultyLabel(l.difficulty)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-cream-dim">
                    {l.origin}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {l.teaches.slice(0, 4).map((t) => (
                      <span
                        key={t}
                        className="rounded-sm border border-rule/40 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dim"
                      >
                        {tagLabel(t)}
                      </span>
                    ))}
                    {l.teaches.length > 4 && (
                      <span className="font-mono text-[0.6rem] text-cream-dimmer">
                        +{l.teaches.length - 4}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
