import { NextRequest, NextResponse } from "next/server";
import { createChart, listCharts } from "@/lib/charts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ charts: listCharts() });
  } catch (err) {
    console.error("[api/charts GET] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!title || !content.trim()) {
      return NextResponse.json(
        { error: "title and content are required" },
        { status: 400 },
      );
    }
    const chart = createChart({
      title,
      artist: typeof body.artist === "string" ? body.artist : null,
      content,
    });
    return NextResponse.json({ chart }, { status: 201 });
  } catch (err) {
    console.error("[api/charts POST] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
