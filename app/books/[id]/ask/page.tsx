import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getBook } from "@/lib/books/store";
import { listTurns } from "@/lib/books/askStore";
import BookAskClient from "@/components/BookAskClient";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  const book = getBook(params.id);
  return { title: `${book?.title ?? "Book"} — ask — hub` };
}

export default function BookAskPage({ params }: { params: { id: string } }) {
  const book = getBook(params.id);
  if (!book) notFound();
  return (
    <BookAskClient bookId={book.id} title={book.title} author={book.author} initialTurns={listTurns(book.id)} />
  );
}
