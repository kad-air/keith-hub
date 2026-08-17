import { NextRequest, NextResponse } from "next/server";
import { checkBooksAdminToken } from "@/lib/books/adminToken";
import { listBooks } from "@/lib/books/store";
import { ISSUE_DESCRIPTIONS, metadataIssues, needsAttention } from "@/lib/books/quality";

export const dynamic = "force-dynamic";

// Token-gated catalog read for the MCP server (BOOKS_PLAN §9 follow-on).
// Exempt from middleware.ts; auth is the bearer token, fail-closed.
//
//   GET /api/books-admin                  — every book + its metadata issues
//   GET /api/books-admin?needs_attention=1 — only the ones worth fixing
//
// Returns a COMPACT shape on purpose: this is read into an agent's context,
// so it omits the byte-level fields (sha256, file paths) that are irrelevant
// to a metadata decision and would only burn tokens.
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!checkBooksAdminToken(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const only = request.nextUrl.searchParams.get("needs_attention") === "1";
  const books = listBooks()
    .filter((b) => !only || needsAttention(b))
    .map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      series: b.series,
      seriesIndex: b.seriesIndex,
      language: b.language,
      hasDescription: b.description != null,
      fileName: b.fileName,
      issues: metadataIssues(b),
    }));

  return NextResponse.json({
    books,
    total: books.length,
    issueDescriptions: ISSUE_DESCRIPTIONS,
    note:
      "Metadata edits are database-only — they never modify the epub file, so they " +
      "cannot affect reading-progress sync (which keys on a hash of the file bytes).",
  });
}
