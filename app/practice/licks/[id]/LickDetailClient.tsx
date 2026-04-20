"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { Lick, LickDifficulty, LickTag } from "@/lib/practice/licks";

function difficultyLabel(d: LickDifficulty): string {
  return ["", "Beginner", "Intermediate", "Stretch"][d] ?? String(d);
}

function tagLabel(t: LickTag): string {
  return t.replace(/-/g, " ");
}

export function LickDetailClient({
  lick,
  initiallyLearned,
}: {
  lick: Lick;
  initiallyLearned: boolean;
}) {
  const [learned, setLearned] = useState(initiallyLearned);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = () => {
    const next = !learned;
    setLearned(next); // optimistic
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/practice/${encodeURIComponent(`lick:${lick.id}`)}/done`,
          { method: next ? "POST" : "DELETE" },
        );
        if (!res.ok) throw new Error(`Status ${res.status}`);
      } catch (e) {
        setLearned(!next); // rollback
        setError(
          e instanceof Error ? e.message : "Couldn't save — try again.",
        );
      }
    });
  };

  const youtubeUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    lick.youtubeSearch,
  )}`;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <nav className="mb-4">
        <Link
          href="/practice/licks"
          className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-cream"
        >
          ← All licks
        </Link>
      </nav>

      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
          Practice · Lick
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">{lick.name}</h1>
        <p className="mt-1 text-sm text-cream-dim">{lick.origin}</p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="rounded-sm border border-rule/60 px-2 py-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim">
          {difficultyLabel(lick.difficulty)}
        </span>
        {lick.teaches.map((t) => (
          <span
            key={t}
            className="rounded-sm border border-rule/40 px-2 py-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim"
          >
            {tagLabel(t)}
          </span>
        ))}
      </div>

      {lick.boxExcursion && (
        <aside className="mb-5 rounded-sm border border-cat-practice-chord/60 bg-cat-practice-chord/10 p-3">
          <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cat-practice-chord">
            Box excursion
          </p>
          <p className="mt-1 text-sm text-cream-dim">{lick.boxExcursion}</p>
        </aside>
      )}

      <section className="mb-6">
        <h2 className="mb-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Tab
        </h2>
        <pre className="overflow-x-auto rounded-lg border border-rule/60 bg-ink-raised/40 p-4 font-mono text-[0.8rem] leading-tight text-cream">
          {lick.tab}
        </pre>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Coaching
        </h2>
        <p className="text-sm leading-relaxed text-cream">{lick.coaching}</p>
      </section>

      <section className="mb-8">
        <a
          href={youtubeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-sm border border-rule/60 bg-ink-raised/40 px-3 py-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream"
        >
          Search YouTube →
        </a>
        <p className="mt-2 font-mono text-[0.65rem] text-cream-dimmer">
          {lick.youtubeSearch}
        </p>
      </section>

      <div className="sticky bottom-0 -mx-4 border-t border-rule/60 bg-ink/90 px-4 pb-[env(safe-area-inset-bottom)] pt-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <button
          type="button"
          onClick={toggle}
          disabled={isPending}
          aria-pressed={learned}
          className={[
            "w-full rounded-sm border px-4 py-3 font-mono text-sm uppercase tracking-kicker transition-colors disabled:opacity-60",
            learned
              ? "border-cat-practice bg-cat-practice/20 text-cream"
              : "border-cat-practice bg-cat-practice text-ink hover:bg-cat-practice-root",
          ].join(" ")}
        >
          {learned ? "✓ Learned · tap to unmark" : "Mark as learned"}
        </button>
        {error && (
          <p className="mt-2 font-mono text-[0.65rem] text-accent">{error}</p>
        )}
      </div>
    </article>
  );
}
