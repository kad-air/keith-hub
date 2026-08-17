import { backfillWordCounts, listBooks } from "./store.ts";
import { pagesFromWords } from "./pages.ts";
import { listReadingEvents, seedBaselinesFromProgress } from "./readingEvents.ts";
import {
  calendarDaysFor,
  computeReadingStats,
  readingDaysFor,
  type ReadingStats,
  type StatsBook,
} from "./stats.ts";

// The only impure edge of the reading-stats feature: pull the log and the
// catalog out of SQLite, hand them to the pure model in stats.ts.

/**
 * Everything the stats page needs, computed fresh.
 *
 * Two idempotent housekeeping steps run first, both cheap after the first
 * call and both safe to repeat:
 *
 *  · seedBaselinesFromProgress() — positions that arrived before the history
 *    log existed get a zero-delta baseline, so a book already in progress
 *    shows its true position without inventing reading days that were never
 *    observed.
 *  · backfillWordCounts() — books ingested before word_count existed get
 *    measured, so their page numbers stop reading as zero.
 *
 * Doing this on read rather than in a migration keeps it out of the boot path
 * and means the page is self-healing after a restore: whatever is missing gets
 * filled the next time the page is opened.
 */
export function getReadingStats(now: number = Math.floor(Date.now() / 1000)): ReadingStats {
  seedBaselinesFromProgress();
  backfillWordCounts();

  const books: StatsBook[] = listBooks().map((b) => ({
    id: b.id,
    title: b.title,
    author: b.author,
    series: b.series,
    seriesIndex: b.seriesIndex,
    partialMd5: b.partialMd5,
    wordCount: b.wordCount,
    coverName: b.coverName,
  }));

  return computeReadingStats({ events: listReadingEvents(), books, now });
}

export type BookHistory = {
  /** False for a book that has never synced: the forecast below is then what
   *  the WHOLE book costs, not what's left of one in progress. */
  started: boolean;
  daysRead: number;
  pages: number;
  firstSeen: number | null;
  lastRead: number | null;
  finishes: Array<{ finishedAt: number; daysTaken: number | null }>;
  readingDaysToFinish: number | null;
  daysToFinish: number | null;
  pagesLeft: number | null;
  totalPages: number | null;
};

const toStatsBook = (b: ReturnType<typeof listBooks>[number]): StatsBook => ({
  id: b.id,
  title: b.title,
  author: b.author,
  series: b.series,
  seriesIndex: b.seriesIndex,
  partialMd5: b.partialMd5,
  wordCount: b.wordCount,
  coverName: b.coverName,
});

/**
 * One book's own history. Computed by running the SAME model as the stats page
 * rather than by a second, parallel set of rules — so the per-book numbers
 * cannot drift, and everything check:books:stats proves about the model holds
 * here too.
 *
 * 🔴 It runs that model TWICE, and the split is load-bearing:
 *
 *  · the FORECAST comes from the full log, because the reading rate is global
 *    (see stats.ts). Measuring it over one document's events would quietly
 *    reinstate the per-book rate this feature exists to replace — and the book
 *    that most needs a forecast, started this morning and finished in two days,
 *    is exactly the one whose own events can never supply one.
 *  · the TOTALS come from this document's events alone, because "pages read"
 *    and "days read" on a book's page mean that book.
 */
export function getBookHistory(
  partialMd5: string,
  now: number = Math.floor(Date.now() / 1000),
): BookHistory | null {
  seedBaselinesFromProgress();
  backfillWordCounts();

  const allBooks = listBooks();
  const book = allBooks.find((b) => b.partialMd5 === partialMd5);
  if (!book) return null;

  const allEvents = listReadingEvents();
  const own = allEvents.filter((e) => e.document === partialMd5);

  const full = computeReadingStats({ events: allEvents, books: allBooks.map(toStatsBook), now });
  const totalPages = book.wordCount ? pagesFromWords(book.wordCount) : null;

  // An unopened book. There is no history to report and none is implied — but
  // the rate is the reader's, so what this book WOULD cost is already known,
  // and "about four evenings" is the useful thing to say about a book on the
  // shelf. Nothing here is measured from the book's own (empty) log.
  if (own.length === 0) {
    return {
      started: false,
      daysRead: 0,
      pages: 0,
      firstSeen: null,
      lastRead: null,
      finishes: [],
      readingDaysToFinish: readingDaysFor(totalPages ?? 0, full.rate),
      daysToFinish: calendarDaysFor(totalPages ?? 0, full.rate),
      pagesLeft: totalPages,
      totalPages,
    };
  }

  const mine = computeReadingStats({ events: own, books: [toStatsBook(book)], now });

  const current = full.nowReading.find((r) => r.document === partialMd5) ?? null;
  return {
    started: true,
    daysRead: mine.totals.daysRead,
    pages: mine.totals.pages,
    firstSeen: mine.since,
    lastRead: current?.lastReadAt ?? mine.finished[0]?.finishedAt ?? null,
    finishes: mine.finished.map((f) => ({ finishedAt: f.finishedAt, daysTaken: f.daysTaken })),
    readingDaysToFinish: current?.readingDaysToFinish ?? null,
    daysToFinish: current?.daysToFinish ?? null,
    pagesLeft: current?.pagesLeft ?? null,
    totalPages,
  };
}
