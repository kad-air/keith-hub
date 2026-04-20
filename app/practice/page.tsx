import type { Metadata } from "next";
import Link from "next/link";
import {
  anyDayDoneToday,
  getCurriculum,
  resolveToday,
} from "@/lib/practice/config";
import {
  getDoneDayIds,
  getLearnedLickIds,
  getStreak,
} from "@/lib/practice/progress";
import { LICKS } from "@/lib/practice/licks";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Practice — hub" };

type Tile = {
  key: string;
  title: string;
  desc: string;
  href: string;
  available: boolean;
};

const TILES: Tile[] = [
  {
    key: "today",
    title: "Today",
    desc: "Daily session from the 14-day curriculum.",
    href: "/practice/today",
    available: true,
  },
  {
    key: "fretboard",
    title: "Fretboard",
    desc: "Chords, scales, and CAGED shapes across the neck.",
    href: "/practice/fretboard",
    available: true,
  },
  {
    key: "licks",
    title: "Licks",
    desc: "A-minor pentatonic vocabulary — browse and mark learned.",
    href: "/practice/licks",
    available: true,
  },
];

export default function PracticeLandingPage() {
  const curriculum = getCurriculum();
  const doneDayIds = getDoneDayIds();
  const card = resolveToday(curriculum, doneDayIds);
  const doneToday = anyDayDoneToday();
  const streak = getStreak();
  const learnedLicks = getLearnedLickIds();

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-8">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
          Section
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">Practice</h1>
        <p className="mt-1 text-sm text-cream-dim">
          Breaking the rhythm-to-lead plateau in A minor pentatonic, one box at
          a time.
        </p>
      </header>

      <TodayCard
        card={card}
        streak={streak}
        doneToday={doneToday}
        learnedLicksCount={learnedLicks.size}
        totalLicks={LICKS.length}
      />

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {TILES.map((t) => {
          const Body = (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-lg text-cream">{t.title}</h2>
                {!t.available && (
                  <span className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                    Soon
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-cream-dim">{t.desc}</p>
            </>
          );
          if (!t.available) {
            return (
              <li key={t.key}>
                <div
                  aria-disabled="true"
                  className="block cursor-not-allowed border border-rule/40 bg-ink-raised/20 px-4 py-3 opacity-70"
                >
                  {Body}
                </div>
              </li>
            );
          }
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                className="block border border-rule/60 bg-ink-raised/40 px-4 py-3 transition-colors hover:border-cat-practice/60 hover:bg-ink-raised/70"
              >
                {Body}
              </Link>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function TodayCard({
  card,
  streak,
  doneToday,
  learnedLicksCount,
  totalLicks,
}: {
  card: ReturnType<typeof resolveToday>;
  streak: number;
  doneToday: boolean;
  learnedLicksCount: number;
  totalLicks: number;
}) {
  if (card.kind === "complete") {
    return (
      <section className="mb-10 rounded-lg border border-cat-practice/60 bg-cat-practice/10 p-5">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
          Curriculum complete
        </p>
        <p className="mt-2 font-display text-lg text-cream">14 / 14 days.</p>
        <p className="mt-1 text-sm text-cream-dim">
          Revisit any lick, or wait for v2. {learnedLicksCount} / {totalLicks}{" "}
          licks marked learned.
        </p>
      </section>
    );
  }

  return (
    <Link
      href="/practice/today"
      className="mb-10 block rounded-lg border border-rule/60 bg-ink-raised/30 p-5 transition-colors hover:border-cat-practice/60 hover:bg-ink-raised/60"
    >
      <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
        Day {card.day.day} of 14
        {streak > 0 ? ` · ${streak}-day streak` : ""}
        {doneToday ? " · done today" : ""}
      </p>
      <p className="mt-2 font-display text-lg text-cream">{card.day.title}</p>
      <p className="mt-1 text-sm text-cream-dim">{card.day.focus}</p>
    </Link>
  );
}
