import { NextResponse } from "next/server";
import { listBooks } from "@/lib/books/store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ books: listBooks() });
  } catch (err) {
    console.error("[api/books GET] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
