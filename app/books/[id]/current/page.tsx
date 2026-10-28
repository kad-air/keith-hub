import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getBook } from "@/lib/books/store";
import CurrentPageClient from "@/components/CurrentPageClient";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  const book = getBook(params.id);
  return { title: `${book?.title ?? "Book"} — current page — hub` };
}

export default function CurrentPage({ params }: { params: { id: string } }) {
  const book = getBook(params.id);
  if (!book) notFound();
  return <CurrentPageClient bookId={book.id} title={book.title} author={book.author} />;
}
