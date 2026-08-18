import { NextRequest, NextResponse } from "next/server";
import { ingestBook } from "@/lib/books/store";
import { PrepareError, prepareForIngest } from "@/lib/books/prepare";

export const dynamic = "force-dynamic";

// Multipart upload; accepts one or more books under the "file" field. Gated by
// the normal hub-auth cookie via middleware — this is the manage surface, not
// a device protocol. scripts/push-books.mjs drives it for bulk imports.
//
// 🔴 Every uploaded file goes through `prepareForIngest` FIRST, so what lands
// on the volume is always a clean epub — see lib/books/prepare.ts. The route
// deliberately does not branch on file type: that is the whole point of the
// seam, and it is what will make an .acsm upload indistinguishable from an
// .epub upload once fulfilment lands.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const form = await request.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: "no files" }, { status: 400 });
    }

    const results = [];
    for (const file of files) {
      if (!/\.(epub|acsm)$/i.test(file.name)) {
        results.push({ fileName: file.name, error: "not an epub" });
        continue;
      }
      try {
        const prepared = await prepareForIngest(Buffer.from(await file.arrayBuffer()), file.name);
        const { book, created } = ingestBook(prepared.bytes, prepared.fileName);
        results.push({
          fileName: file.name,
          bookId: book.id,
          title: book.title,
          created,
          origin: prepared.origin,
        });
      } catch (err) {
        if (err instanceof PrepareError) {
          results.push({ fileName: file.name, error: err.message, code: err.code });
          continue;
        }
        throw err;
      }
    }
    return NextResponse.json({ results }, { status: 201 });
  } catch (err) {
    console.error("[api/books/upload POST] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
