import { NextRequest, NextResponse } from "next/server";
import { ReplaceError, getBook, replaceBookFile } from "@/lib/books/store";
import { PrepareError, looksLikeBook, prepareForIngest } from "@/lib/books/prepare";

export const dynamic = "force-dynamic";

// Swap the book's file for one edited elsewhere (Calibre, Sigil, a script),
// keeping its id and everyone's reading position. Cookie-gated via middleware.
//
//   POST multipart/form-data: file (the new epub); metadata=file to take
//        title/author/series from the new OPF instead of keeping the row's
//
// Same upload boundary as /api/books/upload: prepareForIngest first, so a
// DRM'd file can't land. The response's textChanged says whether the
// chapters themselves differ — false means every position is exact on both
// copies; true means progress carries over but may land near, not on, the
// same sentence (a different edition is better uploaded as a new book).
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!getBook(params.id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  let file: File | null = null;
  let metadataFromFile = false;
  try {
    const form = await request.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
    metadataFromFile = form.get("metadata") === "file";
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data with a file" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!looksLikeBook(file.name, bytes)) {
    return NextResponse.json({ error: "not an epub or .acsm" }, { status: 422 });
  }
  try {
    const prepared = await prepareForIngest(bytes, file.name);
    return NextResponse.json(replaceBookFile(params.id, prepared.bytes, { metadataFromFile }));
  } catch (err) {
    if (err instanceof PrepareError || err instanceof ReplaceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    console.error("[api/books/replace-file POST] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
