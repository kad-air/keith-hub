"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { DayCell, NowReading, ReadingStats } from "@/lib/books/stats";
import { READING_TIMEZONE } from "@/lib/books/stats";

// The reading-statistics page. Everything on it comes from the kosync sync
// log; nothing is entered by hand and nothing is awarded for opening the app.
//
// Tone is deliberate — a streak, a set of badges and a "you'll finish this on
// Thursday" projection are there to make picking the book back up the obvious
// move. The honesty carries are equally deliberate: what is estimated says so
// ON SCREEN, next to the number, not in a tooltip nobody opens.

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Format a YYYY-MM-DD civil date. Deliberately does NOT go through Date —
 *  a day key is a wall-calendar date, and parsing it as an instant would
 *  shift it a day west of UTC. */
function fmtDay(day: string, withYear = false): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ""}`;
}

/** Format a unix-seconds instant in the reading timezone. */
function fmtTs(ts: number, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: READING_TIMEZONE,
    month: "short",
    day: "numeric",
    ...opts,
  }).format(new Date(ts * 1000));
}

/** A duration, for "quiet for ~" — not a point in time. */
function relSpan(days: number): string {
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

function fmtHour(h: number): string {
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export default function BooksStatsClient({ stats }: { stats: ReadingStats }) {
  if (!stats.hasHistory) return <EmptyState />;

  return (
    <article className="mx-auto max-w-[900px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-8">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
              Books
            </p>
            <h1 className="mt-1 font-display text-2xl text-cream">Reading stats</h1>
          </div>
          <Link
            href="/books"
            className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
          >
            ← Library
          </Link>
        </div>
      </header>

      <StreakHero stats={stats} />
      <TodayRow stats={stats} />
      <Heatmap calendar={stats.calendar} />
      <NowReadingSection items={stats.nowReading} />
      <RecordsRow stats={stats} />
      <FinishedShelf stats={stats} />
      <Badges stats={stats} />
      <WhenYouRead stats={stats} />
      <Provenance stats={stats} />
    </article>
  );
}

// ── empty ──────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <article className="mx-auto max-w-[640px] px-4 pb-24 pt-6 sm:px-6">
      <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">Books</p>
      <h1 className="mt-1 font-display text-2xl text-cream">Reading stats</h1>
      <div className="mt-8 border border-rule/60 bg-ink-raised/40 px-5 py-6">
        <p className="font-display text-lg text-cream">Nothing to count yet.</p>
        <p className="mt-2 text-sm text-cream-dim">
          Every page you turn on the X3 or in Readest syncs a position here, and everything on this
          page is built from those. Open a book, read a few pages, and let it sync — the first
          numbers show up within a chapter.
        </p>
        <p className="mt-3 text-sm text-cream-dimmer">
          If a device is reading but nothing lands here, the sync settings are the usual culprit —
          see <span className="text-accent">Device setup</span> on the library page.
        </p>
        <Link
          href="/books"
          className="mt-5 inline-block border border-accent/60 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:bg-accent/10"
        >
          Back to the library
        </Link>
      </div>
    </article>
  );
}

// ── the streak ─────────────────────────────────────────────────────────────

function StreakHero({ stats }: { stats: ReadingStats }) {
  const { current, longest, bankedToday, atRisk } = stats.streak;
  const isRecord = current > 0 && current >= longest;

  let headline: string;
  let sub: string;
  if (current === 0) {
    headline = "No streak going";
    sub = "Read anything today and it starts at one.";
  } else if (bankedToday) {
    headline = `${plural(current, "day")} running`;
    sub = isRecord
      ? "That is your longest run yet. Keep it."
      : `Banked today. Your record is ${longest}.`;
  } else {
    headline = `${plural(current, "day")} running`;
    sub = "Not read today yet — a few pages keeps it alive.";
  }

  return (
    <section
      className={`mb-6 border px-5 py-5 ${
        atRisk ? "border-accent/50 bg-accent/[0.06]" : "border-rule/60 bg-ink-raised/40"
      }`}
    >
      <div className="flex items-center gap-4">
        <div
          className={`font-display text-5xl leading-none tabular-nums ${
            current > 0 ? "text-accent" : "text-cream-dimmer"
          }`}
        >
          {current}
        </div>
        <div className="min-w-0">
          <p className="font-display text-lg leading-tight text-cream">{headline}</p>
          <p className="mt-0.5 text-sm text-cream-dim">{sub}</p>
        </div>
      </div>
      {/* The last fortnight as a row of marks — the chain, at a glance. A
          fixed window rather than one scaled to the streak, so the gaps stay
          visible and the widget doesn't change shape as the number moves. */}
      <div className="mt-4 flex gap-1" aria-hidden>
        {stats.calendar.slice(-14).map((cell) => (
          <span
            key={cell.day}
            className={`h-1.5 flex-1 ${cell.syncs > 0 ? "bg-accent" : "bg-rule/50"}`}
          />
        ))}
      </div>
    </section>
  );
}

function TodayRow({ stats }: { stats: ReadingStats }) {
  const t = stats.today;
  return (
    <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile label="Today" value={t.pages} unit={t.pages === 1 ? "page" : "pages"} accent />
      <Tile label="Last 7 days" value={stats.pace.last7} unit="pages/day" />
      <Tile label="This year" value={stats.totals.pagesThisYear} unit="pages" />
      <Tile
        label="Finished"
        value={stats.totals.booksFinishedThisYear}
        unit={`book${stats.totals.booksFinishedThisYear === 1 ? "" : "s"} this year`}
      />
    </section>
  );
}

function Tile({
  label,
  value,
  unit,
  accent = false,
}: {
  label: string;
  value: number | string;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className="border border-rule/60 bg-ink-raised/40 px-3 py-3">
      <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
        {label}
      </p>
      <p
        className={`mt-1 font-display text-2xl leading-none tabular-nums ${
          accent ? "text-accent" : "text-cream"
        }`}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {unit && <p className="mt-0.5 font-mono text-[0.65rem] text-cream-dimmer">{unit}</p>}
    </div>
  );
}

// ── the calendar ───────────────────────────────────────────────────────────

function Heatmap({ calendar }: { calendar: DayCell[] }) {
  const [hover, setHover] = useState<DayCell | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  // Intensity is scaled against a typical good day, not the single best one —
  // one 400-page Sunday would otherwise flatten every other day to the palest
  // shade and make the year look empty.
  const scale = useMemo(() => {
    const nonzero = calendar.filter((c) => c.pages > 0).map((c) => c.pages).sort((a, b) => a - b);
    if (nonzero.length === 0) return 1;
    return Math.max(1, nonzero[Math.floor(nonzero.length * 0.75)]);
  }, [calendar]);

  const level = (pages: number, syncs: number): number => {
    if (pages <= 0) return syncs > 0 ? 1 : 0; // read, but nothing measurable
    return Math.min(4, 1 + Math.floor((pages / scale) * 3));
  };

  const SHADES = [
    "bg-rule/30",
    "bg-accent/25",
    "bg-accent/50",
    "bg-accent/75",
    "bg-accent",
  ];

  // Pad the front so the grid starts on a Sunday column.
  const first = calendar[0];
  const [fy, fm, fd] = first.day.split("-").map(Number);
  const lead = new Date(Date.UTC(fy, fm - 1, fd)).getUTCDay();
  const cells: (DayCell | null)[] = [...Array(lead).fill(null), ...calendar];

  const weeks: (DayCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const totalDays = calendar.filter((c) => c.syncs > 0).length;

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg text-cream">The last year</h2>
        <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          {totalDays} day{totalDays === 1 ? "" : "s"} read
        </p>
      </div>

      {/* Scrolls horizontally on a phone; the newest weeks are on the right,
          so start it scrolled to the end where the action is.

          🔴 Once, on mount — NOT in an inline ref callback. An inline callback
          gets a new identity every render, so React re-runs it on every hover,
          and the strip would yank itself back to the right the moment you
          reached for a square in the middle. */}
      <div className="overflow-x-auto pb-1" ref={scrollerRef}>
        <div className="flex gap-[3px]" style={{ minWidth: "min-content" }}>
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {week.map((cell, di) =>
                cell == null ? (
                  <span key={di} className="h-[11px] w-[11px]" />
                ) : (
                  <button
                    key={cell.day}
                    type="button"
                    onMouseEnter={() => setHover(cell)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(cell)}
                    onClick={() => setHover(cell)}
                    aria-label={`${fmtDay(cell.day, true)}: ${cell.pages} pages`}
                    className={`h-[11px] w-[11px] ${SHADES[level(cell.pages, cell.syncs)]} transition-transform hover:scale-125`}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="min-h-[1.25rem] font-mono text-[0.7rem] text-cream-dim">
          {hover ? (
            hover.syncs === 0 ? (
              <span className="text-cream-dimmer">{fmtDay(hover.day, true)} — nothing</span>
            ) : (
              <>
                <span className="text-accent">{fmtDay(hover.day, true)}</span> —{" "}
                {hover.pages > 0 ? plural(hover.pages, "page") : "read, pages not measurable"}
                {hover.books > 1 && ` across ${hover.books} books`}
              </>
            )
          ) : (
            <span className="text-cream-dimmer">Tap a square for the day.</span>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <span className="font-mono text-[0.6rem] text-cream-dimmer">less</span>
          {SHADES.map((s, i) => (
            <span key={i} className={`h-[9px] w-[9px] ${s}`} />
          ))}
          <span className="font-mono text-[0.6rem] text-cream-dimmer">more</span>
        </div>
      </div>
    </section>
  );
}

// ── now reading ────────────────────────────────────────────────────────────

function NowReadingSection({ items }: { items: NowReading[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-3 border-b border-rule/40 pb-1 font-display text-lg text-cream">
        On the go
      </h2>
      <ul className="space-y-3">
        {items.map((item) => (
          <NowReadingRow key={item.document} item={item} />
        ))}
      </ul>
    </section>
  );
}

function NowReadingRow({ item }: { item: NowReading }) {
  const pct = Math.round(item.percentage * 100);
  const measurable = item.book?.wordCount ? item.book.wordCount > 0 : false;

  // The nudge. A stalled book gets called out by name — that is the entire
  // point of noticing, and a gentle line beats a silent progress bar.
  let line: React.ReactNode;
  if (item.stalled) {
    line = (
      <span className="text-cream-dim">
        Quiet for {relSpan(item.daysIdle)}
        {measurable && item.pagesLeft > 0 && ` · ${plural(item.pagesLeft, "page")} still to go`}
      </span>
    );
  } else if (item.daysToFinish != null && item.pace != null) {
    const finish = new Date(Date.now() + item.daysToFinish * 86400000);
    line = (
      <span className="text-cream-dim">
        {plural(item.pagesLeft, "page")} to go · at {item.pace}/day you finish around{" "}
        <span className="text-accent">
          {new Intl.DateTimeFormat("en-US", {
            timeZone: READING_TIMEZONE,
            month: "short",
            day: "numeric",
          }).format(finish)}
        </span>
      </span>
    );
  } else if (measurable) {
    line = (
      <span className="text-cream-dim">
        {plural(item.pagesLeft, "page")} to go · read a few more days for a forecast
      </span>
    );
  } else {
    line = <span className="text-cream-dimmer">Not in the library — pages can&apos;t be counted</span>;
  }

  const body = (
    <div
      className={`flex gap-3 border px-3 py-3 ${
        item.stalled ? "border-rule/60 bg-ink-raised/20" : "border-rule/60 bg-ink-raised/40"
      }`}
    >
      <div className="h-[72px] w-12 shrink-0 overflow-hidden bg-ink-raised">
        {item.book?.coverName ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/books/${item.book.id}/cover`}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[0.55rem] text-cream-dimmer">
            {pct}%
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-base text-cream">
          {item.book?.title ?? "A book not in the library"}
        </p>
        {item.book?.author && (
          <p className="truncate font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
            {item.book.author}
          </p>
        )}
        <div className="mt-2 h-1 bg-ink/70">
          <div className="h-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <p className="mt-1.5 text-[0.8rem]">
          <span className="font-mono tabular-nums text-cream">{pct}%</span> · {line}
        </p>
      </div>
    </div>
  );

  return <li>{item.book ? <Link href={`/books/${item.book.id}`}>{body}</Link> : body}</li>;
}

// ── records ────────────────────────────────────────────────────────────────

function RecordsRow({ stats }: { stats: ReadingStats }) {
  const best = stats.records.bestDay;
  const session = stats.records.longestSession;
  return (
    <section className="mb-8">
      <h2 className="mb-3 border-b border-rule/40 pb-1 font-display text-lg text-cream">
        Personal bests
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Best day"
          value={best?.pages ?? 0}
          unit={best ? `pages · ${fmtDay(best.day)}` : "pages"}
        />
        <Tile label="Longest streak" value={stats.records.longestStreak} unit="days" />
        <Tile
          label="Longest sitting"
          value={session ? `${session.minutes}m` : "—"}
          unit={session ? `est. · ${fmtTs(session.start)}` : "estimated"}
        />
        <Tile label="All time" value={stats.totals.pages} unit="pages read here" />
      </div>
    </section>
  );
}

// ── finished ───────────────────────────────────────────────────────────────

function FinishedShelf({ stats }: { stats: ReadingStats }) {
  if (stats.finished.length === 0) return null;
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-rule/40 pb-1">
        <h2 className="font-display text-lg text-cream">Finished</h2>
        <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          {stats.totals.booksFinished} since tracking began
        </p>
      </div>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        {stats.finished.slice(0, 15).map((f) => {
          const inner = (
            <>
              <div className="relative aspect-[2/3] overflow-hidden border border-rule/60 bg-ink-raised">
                {f.book?.coverName ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/books/${f.book.id}/cover`}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-2 text-center font-display text-[0.7rem] text-cream-dim">
                    {f.book?.title ?? "Unknown"}
                  </div>
                )}
              </div>
              <p className="mt-1 truncate font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                {fmtDay(f.day)}
                {f.daysTaken != null && ` · ${f.daysTaken}d`}
              </p>
            </>
          );
          return (
            <li key={`${f.document}-${f.finishedAt}`}>
              {f.book ? (
                <Link href={`/books/${f.book.id}`} className="group block">
                  {inner}
                </Link>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── badges ─────────────────────────────────────────────────────────────────

function Badges({ stats }: { stats: ReadingStats }) {
  const earned = stats.badges.filter((b) => b.earnedAt != null);
  const locked = stats.badges.filter((b) => b.earnedAt == null);
  // Nearest-first, so the list reads as "what's next" rather than a wall.
  locked.sort((a, b) => b.progress - a.progress);

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-rule/40 pb-1">
        <h2 className="font-display text-lg text-cream">Badges</h2>
        <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          {earned.length} of {stats.badges.length}
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {[...earned, ...locked].map((b) => (
          <li
            key={b.key}
            className={`border px-3 py-2 ${
              b.earnedAt != null
                ? "border-accent/50 bg-accent/[0.07]"
                : "border-rule/50 bg-ink-raised/20"
            }`}
          >
            <p
              className={`font-display text-sm ${
                b.earnedAt != null ? "text-accent" : "text-cream-dim"
              }`}
            >
              {b.name}
            </p>
            <p className="mt-0.5 text-[0.72rem] leading-snug text-cream-dimmer">{b.blurb}</p>
            {b.earnedAt != null ? (
              <p className="mt-1 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                Earned
              </p>
            ) : b.progress > 0 ? (
              <div className="mt-1.5 h-[3px] bg-ink/70">
                <div
                  className="h-full bg-cream-dimmer"
                  style={{ width: `${Math.round(b.progress * 100)}%` }}
                />
              </div>
            ) : (
              <p className="mt-1 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                Locked
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── when ───────────────────────────────────────────────────────────────────

function WhenYouRead({ stats }: { stats: ReadingStats }) {
  const max = Math.max(...stats.byHour, 1);
  const total = stats.byHour.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const peak = stats.byHour.indexOf(max);

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-rule/40 pb-1">
        <h2 className="font-display text-lg text-cream">When you read</h2>
        <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          peak {fmtHour(peak)}
        </p>
      </div>
      <div className="flex h-20 items-end gap-[3px]">
        {stats.byHour.map((n, h) => (
          <div key={h} className="flex flex-1 flex-col items-center gap-1" title={`${fmtHour(h)} — ${n} syncs`}>
            <div
              className={`w-full ${h === peak ? "bg-accent" : "bg-rule"}`}
              style={{ height: `${Math.max(2, (n / max) * 64)}px` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[0.6rem] text-cream-dimmer">
        <span>12am</span>
        <span>6am</span>
        <span>noon</span>
        <span>6pm</span>
        <span>11pm</span>
      </div>
    </section>
  );
}

// ── honesty ────────────────────────────────────────────────────────────────

function Provenance({ stats }: { stats: ReadingStats }) {
  return (
    <section className="mt-10 border-t border-rule/40 pt-4">
      <h2 className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
        Where these numbers come from
      </h2>
      <div className="mt-2 space-y-2 text-[0.8rem] leading-relaxed text-cream-dim">
        <p>
          Every figure here is derived from reading positions your devices synced — nothing is
          entered by hand, and nothing counts for opening this app. A page is{" "}
          <span className="text-cream">250 words</span> of the book&apos;s own text, so page counts
          are comparable between books rather than tied to a font size.
        </p>
        <p>
          {/* The one genuinely inferred quantity, said plainly rather than
              buried — a sitting that synced once has no measurable span. */}
          <span className="text-cream">Sitting lengths are estimated</span> from the gaps between
          syncs, so a session your device only reported once counts as zero minutes. Treat those as
          a floor, not a measurement. Everything else — days, positions, pages — is measured.
        </p>
        {stats.since != null && (
          <p>
            History starts{" "}
            <span className="text-cream">{fmtTs(stats.since, { year: "numeric" })}</span>, when this
            server began keeping one. Reading before that isn&apos;t recoverable: the sync protocol
            only ever stores your current position, so books already in progress show where they
            stand without claiming when they got there.
          </p>
        )}
        {stats.unmeasured.documents > 0 && (
          <p>
            {plural(stats.unmeasured.documents, "synced document")} don&apos;t match a book in this
            library, so their pages aren&apos;t counted — they still count toward your streak.
            Downloading books from this library keeps them measurable.
          </p>
        )}
      </div>
    </section>
  );
}
