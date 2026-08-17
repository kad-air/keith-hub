import { backfillWordCounts, listBooks } from "./store.ts";
import { pagesFromWords } from "./pages.ts";
import { listReadingEvents, seedBaselinesFromProgress } from "./readingEvents.ts";
import { computeReadingStats, type ReadingStats, type StatsBook } from "./stats.ts";

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
  daysRead: number;
  pages: number;
  sessions: number;
  estimatedMinutes: number;
  firstSeen: number | null;
  lastRead: number | null;
  finishes: Array<{ finishedAt: number; daysTaken: number | null }>;
  pace: number | null;
  daysToFinish: number | null;
  pagesLeft: number | null;
  totalPages: number | null;
};

/**
 * One book's own history. Deliberately computed by running the SAME model over
 * just this document's events rather than by a second, parallel set of rules —
 * so the per-book numbers cannot drift from the ones on the stats page, and
 * everything check:books:stats proves about the model holds here too.
 */
export function getBookHistory(
  partialMd5: string,
  now: number = Math.floor(Date.now() / 1000),
): BookHistory | null {
  seedBaselinesFromProgress();
  backfillWordCounts();

  const book = listBooks().find((b) => b.partialMd5 === partialMd5);
  if (!book) return null;

  const events = listReadingEvents().filter((e) => e.document === partialMd5);
  if (events.length === 0) return null;

  const stats = computeReadingStats({
    events,
    books: [
      {
        id: book.id,
        title: book.title,
        author: book.author,
        series: book.series,
        seriesIndex: book.seriesIndex,
        partialMd5: book.partialMd5,
        wordCount: book.wordCount,
        coverName: book.coverName,
      },
    ],
    now,
  });

  const current = stats.nowReading[0] ?? null;
  return {
    daysRead: stats.totals.daysRead,
    pages: stats.totals.pages,
    sessions: stats.sessions.count,
    estimatedMinutes: stats.sessions.estimatedMinutes,
    firstSeen: stats.since,
    lastRead: current?.lastReadAt ?? stats.finished[0]?.finishedAt ?? null,
    finishes: stats.finished.map((f) => ({ finishedAt: f.finishedAt, daysTaken: f.daysTaken })),
    pace: current?.pace ?? null,
    daysToFinish: current?.daysToFinish ?? null,
    pagesLeft: current?.pagesLeft ?? null,
    totalPages: book.wordCount ? pagesFromWords(book.wordCount) : null,
  };
}
