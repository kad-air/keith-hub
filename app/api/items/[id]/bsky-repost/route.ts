import { NextRequest, NextResponse } from "next/server";
import {
  BlueskyActionError,
  loadBlueskyItem,
  saveBlueskyMetadata,
} from "@/lib/bsky-actions";
import { getBlueskyAgent, resetBlueskyAgent } from "@/lib/bluesky";

export const dynamic = "force-dynamic";

// Toggle a repost. Mirrors /bsky-like with different AT Protocol methods.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { db, meta } = loadBlueskyItem(params.id);
    const agent = await getBlueskyAgent();

    if (meta.viewer?.repost_uri) {
      await agent.deleteRepost(meta.viewer.repost_uri);
      meta.viewer = { ...meta.viewer, repost_uri: undefined };
      meta.repost_count = Math.max(0, meta.repost_count - 1);
    } else {
      const res = await agent.repost(meta.uri!, meta.cid!);
      meta.viewer = { ...(meta.viewer ?? {}), repost_uri: res.uri };
      meta.repost_count += 1;
    }

    saveBlueskyMetadata(db, params.id, meta);
    return NextResponse.json({
      reposted: Boolean(meta.viewer?.repost_uri),
      repost_count: meta.repost_count,
    });
  } catch (err) {
    if (err instanceof BlueskyActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[api/items/bsky-repost] Error:", err);
    resetBlueskyAgent();
    return NextResponse.json({ error: "Bluesky repost failed" }, { status: 500 });
  }
}
