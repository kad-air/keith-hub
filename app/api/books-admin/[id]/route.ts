import { NextRequest, NextResponse } from "next/server";
import { checkBooksAdminToken } from "@/lib/books/adminToken";
import { getBook, updateBook, type BookEdit } from "@/lib/books/store";
import { metadataIssues } from "@/lib/books/quality";

export const dynamic = "force-dynamic";

// Token-gated metadata write for the MCP server.
//
// 🔴 The writable surface is metadata ONLY — BookEdit cannot express a change
// to sha256, partial_md5, or the stored file. That is what makes it safe to
// let an agent write here: the worst case is a wrong series number, never a
// book that silently stops syncing. check:books:metadata pins this.
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!checkBooksAdminToken(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const edit: BookEdit = {};
    if (typeof body.title === "string" && body.title.trim()) edit.title = body.title.trim();
    for (const key of ["author", "series", "language", "description"] as const) {
      if (typeof body[key] === "string") edit[key] = body[key].trim() || null;
      else if (body[key] === null) edit[key] = null;
    }
    if (typeof body.seriesIndex === "number" && Number.isFinite(body.seriesIndex)) {
      edit.seriesIndex = body.seriesIndex;
    } else if (body.seriesIndex === null) {
      edit.seriesIndex = null;
    }

    if (Object.keys(edit).length === 0) {
      return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
    }

    const before = getBook(params.id);
    if (!before) return NextResponse.json({ error: "not found" }, { status: 404 });
    const book = updateBook(params.id, edit);
    if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });

    return NextResponse.json({
      book: {
        id: book.id,
        title: book.title,
        author: book.author,
        series: book.series,
        seriesIndex: book.seriesIndex,
        issues: metadataIssues(book),
      },
      // Echoed back so an agent can SEE that the sync identity was untouched
      // by its own write, rather than being told so.
      syncIdentityUnchanged: book.partialMd5 === before.partialMd5 && book.sha256 === before.sha256,
    });
  } catch (err) {
    console.error("[api/books-admin PUT] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
