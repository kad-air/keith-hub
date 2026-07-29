import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getMainFeedItems } from "@/lib/queries";
import { getAlgorithm, type ResolvedAlgorithm } from "@/lib/config";

export const dynamic = "force-dynamic";

interface PreviewBody {
  priority?: Record<string, number>;
  bsky_ratio?: number;
  surprise?: number;
  surprise_pool?: number;
  jitter?: number;
}

// Dry-run of the All view with draft knob values. Read-only despite the
// POST (a knob object is too awkward as query params) — nothing is
// persisted; the overrides live only for this one getMainFeedItems call.
// Returns just the category sequence: enough to render the composition
// strip without shipping hundreds of full items.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as PreviewBody;
    const base = getAlgorithm();
    const overrides: Partial<ResolvedAlgorithm> = {};
    if (body.priority) overrides.priority = { ...base.priority, ...body.priority };
    if (typeof body.bsky_ratio === "number" && body.bsky_ratio >= 1) {
      overrides.bskyRatio = body.bsky_ratio;
    }
    if (typeof body.surprise === "number" && body.surprise >= 0) {
      overrides.surprise = body.surprise;
    }
    if (typeof body.surprise_pool === "number" && body.surprise_pool >= 1) {
      overrides.surprisePool = body.surprise_pool;
    }
    if (typeof body.jitter === "number" && body.jitter >= 0 && body.jitter <= 1) {
      overrides.jitter = body.jitter;
    }

    const items = getMainFeedItems(getDb(), 2000, overrides);
    const sequence = items.map((i) => i.source_category ?? "reading");
    const counts: Record<string, number> = {};
    for (const cat of sequence) counts[cat] = (counts[cat] ?? 0) + 1;

    return NextResponse.json({ sequence, counts, total: sequence.length });
  } catch (err) {
    console.error("[api/tune/preview] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
