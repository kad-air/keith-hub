import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getBook } from "@/lib/books/store";
import { listProgress } from "@/lib/books/kosync";
import { getBookHistory } from "@/lib/books/statsData";
import BookDetailClient from "@/components/BookDetailClient";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  const book = getBook(params.id);
  return { title: `${book?.title ?? "Book"} — hub` };
}

export default function BookDetailPage({ params }: { params: { id: string } }) {
  const book = getBook(params.id);
  if (!book) notFound();

  const sync =
    listProgress().find((p) => p.document === book.partialMd5) ?? null;

  return (
    <BookDetailClient
      book={book}
      sync={
        sync
          ? {
              progress: sync.progress,
              percentage: sync.percentage,
              device: sync.device,
              timestamp: sync.timestamp,
            }
          : null
      }
      history={getBookHistory(book.partialMd5)}
    />
  );
}
