import type { Metadata } from "next";
import { listBooks } from "@/lib/books/store";
import { listProgress } from "@/lib/books/kosync";
import { getReadingStats } from "@/lib/books/statsData";
import BooksClient from "@/components/BooksClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Books — hub" };

export default function BooksPage() {
  const books = listBooks();
  const progress = listProgress();

  // Join sync positions to books on the content hash (BOOKS_PLAN §6): the
  // sync table has no FK, but a matching partial_md5 means "this is the same
  // bytes the device is reading".
  const progressByHash = new Map(progress.map((p) => [p.document, p]));
  const withProgress = books.map((b) => {
    const p = progressByHash.get(b.partialMd5);
    return {
      book: b,
      sync: p
        ? { percentage: p.percentage, device: p.device, timestamp: p.timestamp }
        : null,
    };
  });
  // Positions with no catalog book — sideloaded documents. Shown, not hidden:
  // they're evidence the sync works (BOOKS_PLAN §12).
  const catalogHashes = new Set(books.map((b) => b.partialMd5));
  const unmatched = progress.filter((p) => !catalogHashes.has(p.document)).length;

  // Device setup values (BOOKS_PLAN §9): rendered ON SCREEN because the two
  // silent-failure settings deserve visibility, not a tooltip. The key itself
  // is only shown when configured; this page is behind the hub-auth cookie.
  const key = process.env.BOOKS_API_KEY ?? null;

  // The streak strip. Rendered here rather than on /books/stats alone because
  // the incentive only works if it's on the page you already open — a number
  // you have to navigate to is a number you check once.
  const stats = getReadingStats();

  return (
    <BooksClient
      items={withProgress}
      unmatchedCount={unmatched}
      apiKeyConfigured={key != null}
      opdsUrl={key ? `/opds/${key}/v1.2/catalog` : null}
      kosyncUrl={key ? `/kosync/${key}` : null}
      summary={{
        hasHistory: stats.hasHistory,
        streak: stats.streak.current,
        bankedToday: stats.streak.bankedToday,
        atRisk: stats.streak.atRisk,
        pagesToday: stats.today.pages,
        pagesThisYear: stats.totals.pagesThisYear,
        booksFinishedThisYear: stats.totals.booksFinishedThisYear,
      }}
    />
  );
}
