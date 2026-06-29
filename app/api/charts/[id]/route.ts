import { NextRequest, NextResponse } from "next/server";
import { deleteChart, getChart, updateChart } from "@/lib/charts";

export const dynamic = "force-dynamic";

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    if (!getChart(params.id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = await request.json();
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!title || !content.trim()) {
      return NextResponse.json(
        { error: "title and content are required" },
        { status: 400 },
      );
    }
    const chart = updateChart(params.id, {
      title,
      artist: typeof body.artist === "string" ? body.artist : null,
      content,
    });
    return NextResponse.json({ chart });
  } catch (err) {
    console.error("[api/charts PUT] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    deleteChart(params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/charts DELETE] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
