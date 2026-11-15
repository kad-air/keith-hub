import { NextResponse } from "next/server";
import { getReadingStats } from "@/lib/books/statsData";
import { PAGE_WORDS } from "@/lib/books/pages";
import { READING_TIMEZONE } from "@/lib/books/stats";

export const dynamic = "force-dynamic";

// The reading stats as JSON — exactly what /books/stats renders. 🔴 It is the
// SAME call the page makes (getReadingStats, which runs computeReadingStats in
// lib/books/stats.ts), so the page and the app cannot disagree; never compute
// a number here. pageWords and timeZone are the two conventions the numbers
// are in: a page is PAGE_WORDS words, and every `day` is a calendar day in
// READING_TIMEZONE. Cookie-gated like the rest of /api/books, or the Books
// app token.
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(
      { stats: getReadingStats(), pageWords: PAGE_WORDS, timeZone: READING_TIMEZONE },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[api/books/stats GET] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
