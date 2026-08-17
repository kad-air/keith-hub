// 🔴 PAGE_WORDS comes from pages.ts, NOT epubText.ts. This module is imported
// by client components, and epubText pulls in AdmZip — routing the constant
// through it shipped 182 kB of zip library to the browser. The ReadingEvent
// import is type-only for the same reason (readingEvents.ts reaches SQLite).
import { PAGE_WORDS } from "./pages.ts";
import type { ReadingEvent } from "./readingEvents.ts";

// Reading statistics, derived entirely from the reading_events log.
//
// 🔴 This module is PURE — no DB, no fs, no `new Date()` without an explicit
// `now`. Everything enters through computeReadingStats(input). That is what
// lets check:books:stats drive it with hand-built event streams whose correct
// answer is known independently (a calendar, a word count verified against
// Python), instead of asserting the code agrees with itself. Same discipline
// as lib/hoops/rating.ts and matchup.ts. Keep it that way.
//
// ── 🔴 What a sync timestamp actually is ──────────────────────────────────
//
// A reading_events row records WHEN THE DEVICE PUSHED, not when the reading
// happened. On the Xteink X3 — where the overwhelming majority of this
// library's reading is done — pushing progress is a MANUAL action, tapped
// roughly once a day, typically in the evening when handing off to Readest on
// the phone. Readest's own syncs are closer to the moment, but they are the
// minority.
//
// Everything below follows from that one fact, and it is the reason several
// obvious-looking statistics are deliberately absent rather than merely
// unbuilt:
//
// MEASURED, and safe to state plainly:
//   · WHICH DAY progress arrived (to the day, in READING_TIMEZONE)
//   · WHERE in the book it landed (the device's own percentage)
//   · therefore: how much of a book was covered, and pages once a word count
//     is known — see epubText.ts
//
// 🔴 NOT DERIVABLE, and therefore NEVER SHOWN. Each of these was built, found
// to be measuring the push rather than the reading, and removed:
//   · TIME SPENT / sittings. Clustering syncs into sessions reconstructs the
//     shape of the PUSHES. One manual push a day means every "sitting" spans
//     zero minutes, and a "longest sitting" is noise. There is no duration
//     signal in this data at all — not a weak one, none.
//   · TIME OF DAY. An hour histogram plots when the reader taps sync, which
//     is the evening handoff, and would read as "you read most at 8pm" no
//     matter when the reading happened. Same for any badge keyed on the clock
//     (a "night owl" award for pushing after midnight).
//   · anything before the first event. kosync_progress upserts, so the era
//     before this log existed left no history to mine. Baselines carry the
//     current position with delta 0 and the UI dates the record honestly.
//
// KNOWN DISTORTION, stated on screen rather than smoothed away: a day's
// progress lands on the day it was PUSHED. Read Monday and Tuesday, push
// Tuesday evening, and Monday shows empty while Tuesday shows double. Spreading
// a delta backwards across the days it "probably" covers would be inventing
// data, so the page reports what it knows and says what that means.

/** A book crosses into "finished" here. KOReader/CrossPoint routinely stop
 *  reporting a hair under 1.0 at the true end of a book — back matter, the
 *  final page never being "turned" — so demanding 100% would mean almost
 *  nothing ever finishes. */
export const FINISH_THRESHOLD = 0.97;

/** A book with no sync for this long has gone quiet, and gets a nudge. */
export const STALLED_DAYS = 10;

/** Trailing window for the "recent pace" figures and finish projections. */
export const PACE_WINDOW_DAYS = 21;

/** Reading days needed inside that window before ANY forecast is shown. The
 *  bar is cleared by the reader, once, not by each book separately — see the
 *  reading-rate block in computeReadingStats for why that distinction is the
 *  whole feature. */
export const MIN_RATE_DAYS = 3;

export const READING_TIMEZONE = "America/Denver";

export type StatsBook = {
  id: string;
  title: string;
  author: string | null;
  series: string | null;
  seriesIndex: number | null;
  partialMd5: string;
  wordCount: number | null;
  coverName: string | null;
};

export type StatsInput = {
  events: ReadingEvent[];
  books: StatsBook[];
  /** Unix seconds. Explicit so the whole model is testable. */
  now: number;
  timeZone?: string;
};

export type DayCell = { day: string; pages: number; syncs: number; books: number };

export type NowReading = {
  book: StatsBook | null;
  document: string;
  percentage: number;
  pagesRead: number;
  pagesLeft: number;
  lastReadAt: number;
  daysIdle: number;
  /** Days of READING left at the reader's global per-reading-day rate. */
  readingDaysToFinish: number | null;
  /** Calendar days left at the global per-calendar-day rate — this is the one
   *  that becomes a finish DATE. Both are null together: null when the reader
   *  hasn't cleared MIN_RATE_DAYS, or the book has no measurable length. */
  daysToFinish: number | null;
  stalled: boolean;
};

/**
 * The reader's own rate, measured across every book in the window.
 *
 * Two denominators, deliberately, because they answer different questions and
 * each is wrong for the other's:
 *
 *  · perCalendarDay divides by the FIXED window, so days off count against it.
 *    That is what makes it a real calendar date — and what makes it immune to
 *    the push distortion documented at the top of this file, since a weekend of
 *    reading arriving in one Sunday push moves only the numerator.
 *  · perReadingDay divides by days actually read, so it answers "how many more
 *    evenings" and makes no calendar claim it can't back. It IS exposed to that
 *    distortion: two days of reading in one push reads as one very good day.
 */
export type ReadingRate = {
  perCalendarDay: number;
  perReadingDay: number;
  /** Distinct days with measurable progress in the window — the evidence. */
  readingDays: number;
  pages: number;
  windowDays: number;
};

/**
 * What a stack of pages costs, at a rate measured elsewhere.
 *
 * Split out and exported because the rate is a property of the READER: these
 * answer for any number of pages, including a book that has never been opened
 * (there is nothing to project from in the book itself, and nothing needed).
 * One implementation, so a shelf estimate and a Now Reading estimate cannot
 * disagree about the same remaining pages.
 */
export function readingDaysFor(pages: number, rate: ReadingRate | null): number | null {
  if (!rate || pages <= 0) return null;
  return Math.ceil(pages / rate.perReadingDay);
}

export function calendarDaysFor(pages: number, rate: ReadingRate | null): number | null {
  if (!rate || pages <= 0) return null;
  return Math.ceil(pages / rate.perCalendarDay);
}

/**
 * A calendar-days count rendered as the day it lands on ("Sep 2").
 *
 * `nowMs` is required rather than defaulted to Date.now() to keep this module
 * free of ambient time — the same rule the rest of the model follows, and what
 * lets the gate drive it at a chosen instant.
 */
export function finishLabel(
  days: number,
  nowMs: number,
  timeZone: string = READING_TIMEZONE,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(new Date(nowMs + days * 86400000));
}

export type Finish = {
  book: StatsBook | null;
  document: string;
  finishedAt: number;
  day: string;
  words: number | null;
  /** Days from the first recorded page to the finish, when the start was seen
   *  here rather than inherited as a baseline. */
  daysTaken: number | null;
};

export type Badge = {
  key: string;
  name: string;
  blurb: string;
  earnedAt: number | null;
  /** 0..1 toward earning it — drives the progress bar on unearned badges. */
  progress: number;
};

export type ReadingStats = {
  hasHistory: boolean;
  /** First event ever — every "all time" figure is really "since this". */
  since: number | null;
  today: { day: string; pages: number; syncs: number; books: number };
  streak: {
    current: number;
    longest: number;
    /** True once today is banked, so the UI can nudge instead of scold. */
    bankedToday: boolean;
    /** The streak survives until a whole day is missed. */
    atRisk: boolean;
  };
  calendar: DayCell[];
  /** Null until the reader has MIN_RATE_DAYS of measurable days in the window. */
  rate: ReadingRate | null;
  nowReading: NowReading[];
  finished: Finish[];
  records: {
    bestDay: { day: string; pages: number } | null;
    longestStreak: number;
  };
  totals: {
    pages: number;
    words: number;
    booksFinished: number;
    daysRead: number;
    pagesThisYear: number;
    booksFinishedThisYear: number;
  };
  pace: { last7: number; last30: number; window: number };
  devices: Array<{ device: string; pages: number; syncs: number }>;
  badges: Badge[];
  /** Documents synced that no catalog book matches, so their pages can't be
   *  counted. Surfaced, never silently dropped. */
  unmeasured: { documents: number; syncs: number };
};

// ── calendar helpers ───────────────────────────────────────────────────────
//
// 🔴 Day bucketing goes through Intl with an EXPLICIT time zone, never
// floor(ts / 86400) and never the server's local time. Two reasons, both of
// which produce a wrong streak rather than an obvious crash:
//   · Railway runs UTC. An 9pm-Denver page turn is already tomorrow in UTC,
//     so evening reading would land on the next day and a nightly reader's
//     streak would show gaps on the days they actually read.
//   · DST days are 23 and 25 hours long. Fixed-width bucketing drifts across
//     them and eventually splits or merges a day outright.
// check:books:stats anchors this on the real 2026 US DST transitions.

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    // en-CA renders YYYY-MM-DD, which sorts lexicographically.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timeZone, f);
  }
  return f;
}

/** Local calendar day (YYYY-MM-DD) of a unix-seconds instant. */
export function dayKey(ts: number, timeZone: string = READING_TIMEZONE): string {
  return dayFormatter(timeZone).format(new Date(ts * 1000));
}

/**
 * Shift a YYYY-MM-DD day by n calendar days.
 *
 * Deliberately pure civil-date arithmetic through UTC: a day key is a date on
 * a wall calendar, not an instant, so this never meets a DST offset and cannot
 * skip or repeat a day the way adding 86400 seconds to a local timestamp does.
 */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** Whole calendar days between two day keys (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ── the model ──────────────────────────────────────────────────────────────

export function computeReadingStats(input: StatsInput): ReadingStats {
  const tz = input.timeZone ?? READING_TIMEZONE;
  const { events, books, now } = input;
  const today = dayKey(now, tz);

  const bookByHash = new Map(books.map((b) => [b.partialMd5, b]));

  /** Pages a delta represents, or null when the book's length is unknown. */
  const pagesFor = (document: string, delta: number): number | null => {
    const book = bookByHash.get(document);
    if (!book || !book.wordCount) return null;
    return (delta * book.wordCount) / PAGE_WORDS;
  };

  // 🔴 Only 'read' events count as reading. A baseline is the device telling
  // us where it already is — seeded rows from the pre-history migration carry
  // real past timestamps, and counting them would scatter fake activity across
  // a calendar nobody read on.
  const reads = events.filter((e) => e.kind === "read");

  // ── per-day rollup ───────────────────────────────────────────────────────
  const dayMap = new Map<string, { pages: number; syncs: number; docs: Set<string> }>();
  const deviceMap = new Map<string, { pages: number; syncs: number }>();
  const unmeasuredDocs = new Set<string>();
  let unmeasuredSyncs = 0;
  let totalPages = 0;
  let totalWords = 0;

  for (const e of reads) {
    const day = dayKey(e.timestamp, tz);
    let cell = dayMap.get(day);
    if (!cell) {
      cell = { pages: 0, syncs: 0, docs: new Set() };
      dayMap.set(day, cell);
    }
    cell.syncs++;
    cell.docs.add(e.document);

    // 🔴 Backwards movement never subtracts. A reader flipping back a chapter,
    // or a second device syncing a position it hadn't caught up from, has not
    // un-read anything — and letting it net out would let a day of real
    // reading render as zero.
    const forward = Math.max(0, e.delta);
    const pages = pagesFor(e.document, forward);
    if (pages == null) {
      if (!bookByHash.has(e.document)) {
        unmeasuredDocs.add(e.document);
        unmeasuredSyncs++;
      }
    } else {
      cell.pages += pages;
      totalPages += pages;
      const book = bookByHash.get(e.document)!;
      totalWords += forward * (book.wordCount ?? 0);
    }

    const dev = e.device?.trim() || "Unknown device";
    const d = deviceMap.get(dev) ?? { pages: 0, syncs: 0 };
    d.syncs++;
    d.pages += pages ?? 0;
    deviceMap.set(dev, d);
  }

  const activeDays = [...dayMap.keys()].sort();

  // ── streak ───────────────────────────────────────────────────────────────
  // A day counts if it saw any movement, pages measurable or not — a
  // sideloaded book is still reading.
  const activeSet = new Set(activeDays);
  const bankedToday = activeSet.has(today);
  const yesterday = addDays(today, -1);

  // 🔴 The streak survives until a whole day is missed. Counting from today
  // alone would show "0 days" every morning to a reader on a 40-day run, which
  // is both wrong and precisely the moment a streak most needs to motivate.
  let current = 0;
  const anchor = bankedToday ? today : activeSet.has(yesterday) ? yesterday : null;
  if (anchor) {
    let cursor = anchor;
    while (activeSet.has(cursor)) {
      current++;
      cursor = addDays(cursor, -1);
    }
  }

  let longest = 0;
  let run = 0;
  for (let i = 0; i < activeDays.length; i++) {
    run = i > 0 && daysBetween(activeDays[i - 1], activeDays[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  // ── calendar (53 weeks back, inclusive of today) ─────────────────────────
  const calendar: DayCell[] = [];
  const firstCell = addDays(today, -370);
  for (let day = firstCell; daysBetween(day, today) >= 0; day = addDays(day, 1)) {
    const cell = dayMap.get(day);
    calendar.push({
      day,
      pages: cell ? Math.round(cell.pages) : 0,
      syncs: cell?.syncs ?? 0,
      books: cell?.docs.size ?? 0,
    });
  }

  // ── finishes ─────────────────────────────────────────────────────────────
  // A finish is a CROSSING: the first read event to land at or above the
  // threshold from below. Re-syncing at 99% must not re-finish a book every
  // time the device checks in, and a re-read that drops to 0 and climbs back
  // genuinely does finish it a second time.
  const finished: Finish[] = [];
  const positionSeen = new Map<string, number>();
  const firstReadDay = new Map<string, string>();
  for (const e of events) {
    const prior = positionSeen.get(e.document);
    if (e.kind === "read") {
      if (!firstReadDay.has(e.document)) firstReadDay.set(e.document, dayKey(e.timestamp, tz));
      if (
        e.percentage >= FINISH_THRESHOLD &&
        (prior == null || prior < FINISH_THRESHOLD)
      ) {
        const book = bookByHash.get(e.document) ?? null;
        const started = firstReadDay.get(e.document)!;
        const day = dayKey(e.timestamp, tz);
        // Only claim a duration when the start was actually observed. A book
        // inherited mid-read as a baseline has no honest start date.
        const sawStart = events.some(
          (x) => x.document === e.document && x.kind === "read" && x.percentage < 0.2,
        );
        finished.push({
          book,
          document: e.document,
          finishedAt: e.timestamp,
          day,
          words: book?.wordCount ?? null,
          daysTaken: sawStart ? Math.max(1, daysBetween(started, day) + 1) : null,
        });
      }
    }
    positionSeen.set(e.document, e.percentage);
  }
  finished.sort((a, b) => b.finishedAt - a.finishedAt);

  // ── now reading ──────────────────────────────────────────────────────────
  const latestByDoc = new Map<string, ReadingEvent>();
  for (const e of events) latestByDoc.set(e.document, e);

  // ── the reader's rate ────────────────────────────────────────────────────
  //
  // 🔴 The rate is GLOBAL: one figure measured across every book in the window,
  // then divided into each book's remaining pages. It used to be per-book,
  // which sounds more precise and was in practice useless — a book had to
  // survive MIN_RATE_DAYS separate days inside the window to earn a forecast,
  // so the feature could only ever fire on the books being read SLOWLY.
  // Anything finished in a weekend was done before it qualified, and this
  // reader puts a Discworld away in two days. The evidence belongs to the
  // reader, not the book, so a book started this morning is forecast on its
  // first sync.
  //
  // What that costs, and it is a real cost: a dense book is projected at the
  // same rate as an easy one. Pages are word-normalised (PAGE_WORDS), so prose
  // density partly washes out; how fast this reader moves through a particular
  // author does not — and no arithmetic recovers it from a log where the fast
  // books never accumulate evidence of their own.
  //
  // Read as "if this book got all of your reading". With several on the go the
  // per-book numbers are each optimistic, while their SUM is right — total
  // pages left ÷ the same rate is exactly what finishing all of them takes.
  const windowStart = now - PACE_WINDOW_DAYS * 86400;
  const windowDayPages = new Map<string, number>();
  for (const e of reads) {
    if (e.timestamp < windowStart) continue;
    const pages = pagesFor(e.document, Math.max(0, e.delta));
    // Days are counted only where they produced MEASURABLE pages, so the
    // per-reading-day rate stays self-consistent: an evening whose only sync
    // was a sideloaded book contributes nothing to the numerator and must not
    // dilute the divisor either.
    if (!pages) continue;
    const day = dayKey(e.timestamp, tz);
    windowDayPages.set(day, (windowDayPages.get(day) ?? 0) + pages);
  }
  let windowPages = 0;
  for (const p of windowDayPages.values()) windowPages += p;
  const readingDaysInWindow = windowDayPages.size;

  // A projection needs evidence. Two days of reading and a rate figure is a
  // horoscope; below the bar the UI shows no forecast at all rather than a
  // confident wrong date.
  const rate: ReadingRate | null =
    readingDaysInWindow >= MIN_RATE_DAYS && windowPages > 0
      ? {
          // One decimal — a rate derived from three weeks of page turns does
          // not have two significant decimals in it, and printing them implies
          // a precision the estimate doesn't have.
          perCalendarDay: Number((windowPages / PACE_WINDOW_DAYS).toFixed(1)),
          perReadingDay: Number((windowPages / readingDaysInWindow).toFixed(1)),
          readingDays: readingDaysInWindow,
          pages: Math.round(windowPages),
          windowDays: PACE_WINDOW_DAYS,
        }
      : null;

  const nowReading: NowReading[] = [];
  for (const [document, latest] of latestByDoc) {
    if (latest.percentage >= FINISH_THRESHOLD) continue;
    const book = bookByHash.get(document) ?? null;
    const words = book?.wordCount ?? null;
    const totalPagesInBook = words ? words / PAGE_WORDS : 0;

    const pagesRead = totalPagesInBook * latest.percentage;
    const pagesLeft = Math.max(0, totalPagesInBook - pagesRead);
    const daysIdle = daysBetween(dayKey(latest.timestamp, tz), today);

    nowReading.push({
      book,
      document,
      percentage: latest.percentage,
      pagesRead: Math.round(pagesRead),
      pagesLeft: Math.round(pagesLeft),
      lastReadAt: latest.timestamp,
      daysIdle,
      // A book with no measurable length has pagesLeft 0 and gets no forecast —
      // the page says so rather than projecting a book it cannot count.
      readingDaysToFinish: readingDaysFor(pagesLeft, rate),
      daysToFinish: calendarDaysFor(pagesLeft, rate),
      stalled: daysIdle >= STALLED_DAYS,
    });
  }
  nowReading.sort((a, b) => b.lastReadAt - a.lastReadAt);

  // ── pace + totals ────────────────────────────────────────────────────────
  const pagesSince = (days: number): number => {
    const cutoff = addDays(today, -(days - 1));
    let sum = 0;
    for (const [day, cell] of dayMap) if (day >= cutoff) sum += cell.pages;
    return sum;
  };
  const year = today.slice(0, 4);
  let pagesThisYear = 0;
  for (const [day, cell] of dayMap) if (day.startsWith(year)) pagesThisYear += cell.pages;

  const bestDayEntry = [...dayMap.entries()].reduce<{ day: string; pages: number } | null>(
    (best, [day, cell]) =>
      best == null || cell.pages > best.pages ? { day, pages: Math.round(cell.pages) } : best,
    null,
  );

  const stats: ReadingStats = {
    hasHistory: events.length > 0,
    since: events.length > 0 ? events[0].timestamp : null,
    today: {
      day: today,
      pages: Math.round(dayMap.get(today)?.pages ?? 0),
      syncs: dayMap.get(today)?.syncs ?? 0,
      books: dayMap.get(today)?.docs.size ?? 0,
    },
    streak: {
      current,
      longest,
      bankedToday,
      atRisk: current > 0 && !bankedToday,
    },
    calendar,
    rate,
    nowReading,
    finished,
    records: {
      bestDay: bestDayEntry,
      longestStreak: longest,
    },
    totals: {
      pages: Math.round(totalPages),
      words: Math.round(totalWords),
      booksFinished: finished.length,
      daysRead: activeDays.length,
      pagesThisYear: Math.round(pagesThisYear),
      booksFinishedThisYear: finished.filter((f) => f.day.startsWith(year)).length,
    },
    pace: {
      last7: Number((pagesSince(7) / 7).toFixed(1)),
      last30: Number((pagesSince(30) / 30).toFixed(1)),
      window: PACE_WINDOW_DAYS,
    },
    devices: [...deviceMap.entries()]
      .map(([device, d]) => ({ device, pages: Math.round(d.pages), syncs: d.syncs }))
      .sort((a, b) => b.syncs - a.syncs),
    badges: [],
    unmeasured: { documents: unmeasuredDocs.size, syncs: unmeasuredSyncs },
  };

  stats.badges = computeBadges(stats, reads);
  return stats;
}

// ── badges ─────────────────────────────────────────────────────────────────
//
// The incentive layer. Each one is earned from the same event log as
// everything else — nothing here is awarded for opening the app, and every
// unearned badge reports honest progress toward itself so the list reads as a
// set of goals rather than a wall of locked boxes.

function computeBadges(stats: ReadingStats, reads: ReadingEvent[]): Badge[] {
  const streakBadge = (days: number, key: string, name: string, blurb: string): Badge => ({
    key,
    name,
    blurb,
    earnedAt: stats.records.longestStreak >= days ? (stats.since ?? null) : null,
    progress: Math.min(1, stats.records.longestStreak / days),
  });

  const finishes = stats.finished;
  const bestDayPages = stats.records.bestDay?.pages ?? 0;

  // Days on which two or more distinct books moved.
  const multiBookDay = stats.calendar.find((c) => c.books >= 2) ?? null;

  const doorstopper = finishes.find((f) => (f.words ?? 0) >= 200_000) ?? null;
  const sprint = finishes.find((f) => f.daysTaken != null && f.daysTaken <= 3) ?? null;

  // Picking a quiet book back up — the thing the "quiet for 3 weeks" nudge is
  // asking for, so it gets rewarded. A gap between consecutive syncs of the
  // same document is measurable in days, which survives the manual-push
  // caveat that killed the clock-based badges.
  const lastSeen = new Map<string, number>();
  let comebackAt: number | null = null;
  for (const e of reads) {
    const prev = lastSeen.get(e.document);
    if (comebackAt == null && prev != null && e.timestamp - prev >= 30 * 86400) {
      comebackAt = e.timestamp;
    }
    lastSeen.set(e.document, e.timestamp);
  }

  // Two books from one series, finished. Series comes off the catalog row.
  const seriesFinishes = new Map<string, number>();
  let seriesSweepAt: number | null = null;
  for (const f of [...finishes].reverse()) {
    const series = f.book?.series;
    if (!series) continue;
    const n = (seriesFinishes.get(series) ?? 0) + 1;
    seriesFinishes.set(series, n);
    if (n === 2 && seriesSweepAt == null) seriesSweepAt = f.finishedAt;
  }

  return [
    {
      key: "first-light",
      name: "First Light",
      blurb: "Sync your first page turn.",
      earnedAt: reads.length > 0 ? reads[0].timestamp : null,
      progress: reads.length > 0 ? 1 : 0,
    },
    streakBadge(3, "kindling", "Kindling", "Read three days running."),
    streakBadge(7, "week-one", "Week One", "A full week without missing a day."),
    streakBadge(14, "fortnight", "Fortnight", "Fourteen days in a row."),
    streakBadge(30, "the-long-haul", "The Long Haul", "Thirty consecutive days."),
    streakBadge(100, "centurion", "Centurion", "A hundred days. Genuinely absurd."),
    {
      key: "century",
      name: "Century",
      blurb: "A hundred pages in one day.",
      earnedAt: bestDayPages >= 100 ? (stats.since ?? null) : null,
      progress: Math.min(1, bestDayPages / 100),
    },
    {
      key: "double-century",
      name: "Double Century",
      blurb: "Two hundred pages in a single day.",
      earnedAt: bestDayPages >= 200 ? (stats.since ?? null) : null,
      progress: Math.min(1, bestDayPages / 200),
    },
    {
      key: "the-end",
      name: "The End",
      blurb: "Finish a book.",
      earnedAt: finishes.length > 0 ? finishes[finishes.length - 1].finishedAt : null,
      progress: finishes.length > 0 ? 1 : 0,
    },
    {
      key: "shelf-of-five",
      name: "Shelf of Five",
      blurb: "Finish five books.",
      earnedAt: finishes.length >= 5 ? finishes[finishes.length - 5].finishedAt : null,
      progress: Math.min(1, finishes.length / 5),
    },
    {
      key: "doorstopper",
      name: "Doorstopper",
      blurb: "Finish something over 200,000 words.",
      earnedAt: doorstopper?.finishedAt ?? null,
      progress: doorstopper ? 1 : 0,
    },
    {
      key: "devoured",
      name: "Devoured",
      blurb: "Finish a book within three days of starting it.",
      earnedAt: sprint?.finishedAt ?? null,
      progress: sprint ? 1 : 0,
    },
    {
      key: "comeback",
      name: "Comeback",
      blurb: "Pick a book back up after a month away.",
      earnedAt: comebackAt,
      progress: comebackAt != null ? 1 : 0,
    },
    {
      key: "series-sweep",
      name: "Series Sweep",
      blurb: "Finish two books from the same series.",
      earnedAt: seriesSweepAt,
      progress: Math.min(1, Math.max(0, ...[...seriesFinishes.values()], 0) / 2),
    },
    {
      key: "two-timer",
      name: "Two-Timer",
      blurb: "Read two different books in one day.",
      earnedAt: multiBookDay ? (stats.since ?? null) : null,
      progress: multiBookDay ? 1 : 0,
    },
    {
      key: "ambidextrous",
      name: "Ambidextrous",
      blurb: "Read on both the X3 and Readest.",
      earnedAt: stats.devices.filter((d) => d.device !== "Unknown device").length >= 2
        ? (stats.since ?? null)
        : null,
      progress: Math.min(1, stats.devices.filter((d) => d.device !== "Unknown device").length / 2),
    },
  ];
}
