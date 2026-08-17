import type { Metadata } from "next";
import { getReadingStats } from "@/lib/books/statsData";
import BooksStatsClient from "@/components/BooksStatsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reading stats — hub" };

export default function BooksStatsPage() {
  // getReadingStats does its own idempotent housekeeping (baseline seeding,
  // word-count backfill) before computing, so the page is self-healing after
  // a restore rather than depending on a migration having run.
  return <BooksStatsClient stats={getReadingStats()} />;
}
