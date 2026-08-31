import { NextRequest, NextResponse } from "next/server";
import { DISCWORLD_NODES } from "@/lib/books/discworld";
import { clearManualMark, isManualStatus, setManualMark } from "@/lib/books/discworldData";

export const dynamic = "force-dynamic";

const KNOWN_NODES = new Set(DISCWORLD_NODES.map((n) => n.id));

/** Set the reader's own mark on a node. Body: { status: "read" | "reading" | "skipped" }. */
export async function POST(
  request: NextRequest,
  { params }: { params: { nodeId: string } },
): Promise<NextResponse> {
  try {
    if (!KNOWN_NODES.has(params.nodeId)) {
      return NextResponse.json({ error: "Unknown node" }, { status: 404 });
    }
    const body = (await request.json()) as { status?: unknown };
    if (!isManualStatus(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    setManualMark(params.nodeId, body.status);
    return NextResponse.json({ ok: true, status: body.status });
  } catch (err) {
    console.error("[api/books/discworld] POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Clear the mark — the node goes back to whatever the sync says. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { nodeId: string } },
): Promise<NextResponse> {
  try {
    if (!KNOWN_NODES.has(params.nodeId)) {
      return NextResponse.json({ error: "Unknown node" }, { status: 404 });
    }
    clearManualMark(params.nodeId);
    return NextResponse.json({ ok: true, status: null });
  } catch (err) {
    console.error("[api/books/discworld] DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
