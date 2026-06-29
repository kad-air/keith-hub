import { NextRequest, NextResponse } from "next/server";
import { createCharts, type ChartInput } from "@/lib/charts";

export const dynamic = "force-dynamic";

// Bulk-create charts from a batch of uploaded .txt files. Body is
// { charts: [{ title, content, artist? }, ...] }. Each entry needs a
// non-empty title and content; entries that fail validation are reported
// back so the client can tell the user which files were skipped.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const raw = Array.isArray(body?.charts) ? body.charts : null;
    if (!raw) {
      return NextResponse.json(
        { error: "charts array is required" },
        { status: 400 },
      );
    }

    const valid: ChartInput[] = [];
    const skipped: string[] = [];
    for (const entry of raw) {
      const title = typeof entry?.title === "string" ? entry.title.trim() : "";
      const content = typeof entry?.content === "string" ? entry.content : "";
      if (!title || !content.trim()) {
        skipped.push(title || "(untitled)");
        continue;
      }
      valid.push({
        title,
        artist: typeof entry?.artist === "string" ? entry.artist : null,
        content,
      });
    }

    const charts = createCharts(valid);
    return NextResponse.json({ charts, skipped }, { status: 201 });
  } catch (err) {
    console.error("[api/charts/bulk POST] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
