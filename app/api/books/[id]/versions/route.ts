import { NextRequest, NextResponse } from "next/server";
import { ReplaceError, getBook, listVersions, restoreVersion } from "@/lib/books/store";
import { aliasesOf } from "@/lib/books/kosync";

export const dynamic = "force-dynamic";

// The files a book has replaced (newest first), and the way back.
//   GET              → { current: {sha256, partialMd5}, versions, aliases }
//   POST {sha256}    → restore that file (itself a replacement, so the
//                      current file is archived and progress follows). The
//                      row's title/author/series come back from the restored
//                      OPF too — it's an undo — unless {metadata: "keep"}.
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const book = getBook(params.id);
  if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    current: { sha256: book.sha256, partialMd5: book.partialMd5 },
    versions: listVersions(book.id),
    aliases: aliasesOf(book.partialMd5),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const sha256 = typeof body?.sha256 === "string" ? body.sha256 : "";
  try {
    return NextResponse.json(restoreVersion(params.id, sha256, { metadataFromFile: body?.metadata !== "keep" }));
  } catch (err) {
    if (err instanceof ReplaceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === "not-found" ? 404 : 422 });
    }
    console.error("[api/books/versions POST] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
