import { NextRequest, NextResponse } from "next/server";
import {
  BlueskyActionError,
  loadBlueskyItem,
  saveBlueskyMetadata,
} from "@/lib/bsky-actions";
import { getBlueskyAgent, resetBlueskyAgent } from "@/lib/bluesky";

export const dynamic = "force-dynamic";

// Toggle a like on a Bluesky post. If already liked, deletes the like record;
// otherwise creates one. Returns the new viewer state + like count so the
// client can update in place without a refetch.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { db, meta } = loadBlueskyItem(params.id);
    const agent = await getBlueskyAgent();

    if (meta.viewer?.like_uri) {
      await agent.deleteLike(meta.viewer.like_uri);
      meta.viewer = { ...meta.viewer, like_uri: undefined };
      meta.like_count = Math.max(0, meta.like_count - 1);
    } else {
      const res = await agent.like(meta.uri!, meta.cid!);
      meta.viewer = { ...(meta.viewer ?? {}), like_uri: res.uri };
      meta.like_count += 1;
    }

    saveBlueskyMetadata(db, params.id, meta);
    return NextResponse.json({
      liked: Boolean(meta.viewer?.like_uri),
      like_count: meta.like_count,
    });
  } catch (err) {
    if (err instanceof BlueskyActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[api/items/bsky-like] Error:", err);
    // Force a re-auth on next call in case the session expired.
    resetBlueskyAgent();
    return NextResponse.json({ error: "Bluesky like failed" }, { status: 500 });
  }
}
