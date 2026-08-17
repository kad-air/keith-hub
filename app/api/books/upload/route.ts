import { NextRequest, NextResponse } from "next/server";
import { ingestBook } from "@/lib/books/store";

export const dynamic = "force-dynamic";

// Multipart upload; accepts one or more epubs under the "file" field. Gated by
// the normal hub-auth cookie via middleware — this is the manage surface, not
// a device protocol. scripts/push-books.mjs drives it for bulk imports.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const form = await request.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: "no files" }, { status: 400 });
    }

    const results = [];
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".epub")) {
        results.push({ fileName: file.name, error: "not an epub" });
        continue;
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      // "PK" zip magic — reject obviously-not-an-epub payloads before they
      // land on the volume.
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        results.push({ fileName: file.name, error: "not a zip" });
        continue;
      }
      const { book, created } = ingestBook(bytes, file.name);
      results.push({ fileName: file.name, bookId: book.id, title: book.title, created });
    }
    return NextResponse.json({ results }, { status: 201 });
  } catch (err) {
    console.error("[api/books/upload POST] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
