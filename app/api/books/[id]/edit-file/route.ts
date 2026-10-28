import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { EpubEditError, editEpub, type EpubEdit } from "@/lib/books/epubEdit";
import { ReplaceError, bookFilePath, getBook, replaceBookFile, type BookEdit } from "@/lib/books/store";

export const dynamic = "force-dynamic";

// Edit the book's OWN file — the title, author, series and cover a reader
// shows once it's on the device (PUT /api/books/[id] only changes the hub's
// row and the OPDS listing). Cookie-gated via middleware like every
// /api/books route; scripts/edit-book.mjs drives it.
//
//   POST multipart/form-data: title, author, series ("" removes it),
//        seriesIndex, cover (an image file) — any subset
//   POST application/json:    the same fields, no cover
//
// The file is rewritten by lib/books/epubEdit.ts (OPF + cover only, never the
// spine) and swapped in by replaceBookFile, which archives the old file and
// moves reading progress to the new sync key — devices holding the old copy
// keep syncing the same position. The DB row gets the same values, so the
// OPDS listing and the file agree.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const book = getBook(params.id);
  if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });

  const fields: Record<string, unknown> = {};
  let cover: Buffer | undefined;
  try {
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await request.formData();
      for (const k of ["title", "author", "series", "seriesIndex"]) {
        const v = form.get(k);
        if (typeof v === "string") fields[k] = v;
      }
      const c = form.get("cover");
      if (c instanceof File && c.size > 0) cover = Buffer.from(await c.arrayBuffer());
    } else {
      Object.assign(fields, await request.json());
    }
  } catch {
    return NextResponse.json({ error: "unreadable request body" }, { status: 400 });
  }

  const edit: EpubEdit = {};
  const row: BookEdit = {};
  if (typeof fields.title === "string" && fields.title.trim()) edit.title = row.title = fields.title.trim();
  if (typeof fields.author === "string" && fields.author.trim()) edit.author = row.author = fields.author.trim();
  if (typeof fields.series === "string" || fields.series === null) {
    const s = typeof fields.series === "string" ? fields.series.trim() || null : null;
    edit.series = row.series = s;
    if (s == null) edit.seriesIndex = row.seriesIndex = null;
  }
  if (fields.seriesIndex != null && fields.seriesIndex !== "") {
    const n = Number(fields.seriesIndex);
    if (!Number.isFinite(n)) return NextResponse.json({ error: "seriesIndex must be a number" }, { status: 400 });
    edit.seriesIndex = row.seriesIndex = n;
  }
  if (cover) edit.cover = cover;
  if (Object.keys(edit).length === 0) {
    return NextResponse.json({ error: "nothing to change: send title, author, series, seriesIndex or cover" }, { status: 400 });
  }

  try {
    const { bytes, changed } = editEpub(fs.readFileSync(bookFilePath(book)), edit);
    const result = replaceBookFile(book.id, bytes, { edit: row });
    return NextResponse.json({ ...result, changed });
  } catch (err) {
    if (err instanceof EpubEditError || err instanceof ReplaceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === "not-found" ? 404 : 422 });
    }
    console.error("[api/books/edit-file POST] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
