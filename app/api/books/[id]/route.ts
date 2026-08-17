import { NextRequest, NextResponse } from "next/server";
import { deleteBook, getBook, updateBook, type BookEdit } from "@/lib/books/store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const book = getBook(params.id);
  if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ book });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
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
    const book = updateBook(params.id, edit);
    if (!book) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ book });
  } catch (err) {
    console.error("[api/books PUT] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!deleteBook(params.id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
