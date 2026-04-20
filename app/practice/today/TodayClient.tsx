"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Lick, LickDifficulty } from "@/lib/practice/licks";
import type {
  PracticeDay,
  PracticePreCheck,
  TodayCard,
} from "@/lib/practice/config";

function dayIdOf(day: number): string {
  return `day:${String(day).padStart(2, "0")}`;
}

function difficultyLabel(d: LickDifficulty): string {
  return ["", "Beginner", "Intermediate", "Stretch"][d] ?? String(d);
}

type Props = {
  card: TodayCard;
  preCheck: PracticePreCheck;
  licksForDay: Lick[];
  learnedLickIds: string[];
  streak: number;
  doneToday: boolean;
  dayIsDone: boolean;
};

export function TodayClient({
  card,
  preCheck,
  licksForDay,
  learnedLickIds,
  streak,
  doneToday,
  dayIsDone,
}: Props) {
  const [optimisticDone, setOptimisticDone] = useState<boolean>(dayIsDone);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const learned = new Set(learnedLickIds);

  const toggleDone = () => {
    if (card.kind !== "next") return;
    const id = dayIdOf(card.day.day);
    const next = !optimisticDone;
    setOptimisticDone(next);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/practice/${encodeURIComponent(id)}/done`,
          { method: next ? "POST" : "DELETE" },
        );
        if (!res.ok) throw new Error(`Status ${res.status}`);
        router.refresh();
      } catch (e) {
        setOptimisticDone(!next);
        setError(
          e instanceof Error ? e.message : "Couldn't save — try again.",
        );
      }
    });
  };

  if (card.kind === "complete") {
    return (
      <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
        <nav className="mb-4">
          <Link
            href="/practice"
            className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-cream"
          >
            ← Practice
          </Link>
        </nav>
        <header className="mb-6">
          <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
            Practice · Today
          </p>
          <h1 className="mt-1 font-display text-3xl text-cream">
            14 days done.
          </h1>
          <p className="mt-2 text-sm text-cream-dim">
            You've played through the whole v1 curriculum. Extensions — box 2,
            other keys, lick library expansions — land in v2. Until then:
            revisit any lick from the{" "}
            <Link
              href="/practice/licks"
              className="text-cat-practice hover:underline"
            >
              library
            </Link>
            .
          </p>
        </header>
      </article>
    );
  }

  const { day } = card;
  const displayedAsDone = optimisticDone;
  const isDay1 = day.day === 1;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-32 pt-6 sm:px-6">
      <nav className="mb-4">
        <Link
          href="/practice"
          className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-cream"
        >
          ← Practice
        </Link>
      </nav>

      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
          Day {day.day} of 14 · {streak}-day streak
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">{day.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-cream-dim">
          {day.focus}
        </p>
      </header>

      {doneToday && !displayedAsDone && (
        <aside className="mb-5 rounded-sm border border-cat-practice/60 bg-cat-practice/10 p-3">
          <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cat-practice">
            Already done today
          </p>
          <p className="mt-1 text-sm text-cream-dim">
            You've already marked a day done today. Feel free to work ahead, or
            come back tomorrow to keep the pace.
          </p>
        </aside>
      )}

      {isDay1 && (
        <section className="mb-6 rounded-sm border border-rule/60 bg-ink-raised/30 p-4">
          <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
            Pre-check · {preCheck.title}
          </p>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-cream">
            {preCheck.prompt}
          </p>
          <p className="mt-3 whitespace-pre-line text-xs leading-relaxed text-cream-dim">
            {preCheck.why}
          </p>
        </section>
      )}

      <section className="mb-6">
        <h2 className="mb-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          {licksForDay.length > 1 ? "Licks today" : "Lick today"}
        </h2>
        <ul className="grid grid-cols-1 gap-2">
          {licksForDay.map((l) => {
            const isLearned = learned.has(l.id);
            return (
              <li key={l.id}>
                <Link
                  href={`/practice/licks/${l.id}`}
                  className="block border border-rule/60 bg-ink-raised/40 px-4 py-3 transition-colors hover:border-cat-practice/60 hover:bg-ink-raised/70"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-display text-base text-cream">
                      {l.name}
                    </span>
                    <span
                      className={[
                        "font-mono text-[0.65rem] uppercase tracking-kicker",
                        isLearned ? "text-cat-practice" : "text-cream-dimmer",
                      ].join(" ")}
                    >
                      {isLearned ? "learned" : difficultyLabel(l.difficulty)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-cream-dim">
                    {l.origin}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Prompt
        </h2>
        <p className="whitespace-pre-line text-sm leading-relaxed text-cream">
          {day.prompt}
        </p>
        {day.backingTrackSearch && (
          <a
            href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
              day.backingTrackSearch,
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-2 rounded-sm border border-rule/60 bg-ink-raised/40 px-3 py-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream"
          >
            Backing track on YouTube →
          </a>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Why today
        </h2>
        <p className="text-sm leading-relaxed text-cream-dim">{day.why}</p>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-rule/60 bg-ink/90 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md sm:px-6">
        <div className="mx-auto max-w-[720px]">
          <button
            type="button"
            onClick={toggleDone}
            disabled={isPending}
            aria-pressed={displayedAsDone}
            className={[
              "w-full rounded-sm border px-4 py-3 font-mono text-sm uppercase tracking-kicker transition-colors disabled:opacity-60",
              displayedAsDone
                ? "border-cat-practice bg-cat-practice/20 text-cream"
                : "border-cat-practice bg-cat-practice text-ink hover:bg-cat-practice-root",
            ].join(" ")}
          >
            {displayedAsDone
              ? `✓ Day ${day.day} done · tap to unmark`
              : `Mark Day ${day.day} done`}
          </button>
          {error && (
            <p className="mt-2 font-mono text-[0.65rem] text-accent">
              {error}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
