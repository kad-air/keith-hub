import { NextRequest, NextResponse } from "next/server";
import {
  BlueskyActionError,
  loadBlueskyItem,
  propagateFollowToSiblings,
  saveBlueskyMetadata,
} from "@/lib/bsky-actions";
import { getBlueskyAgent, resetBlueskyAgent } from "@/lib/bluesky";

export const dynamic = "force-dynamic";

// One-way follow. We deliberately do NOT unfollow from here — if the user
// wants to unfollow they can do it in the real Bluesky app. If the viewer
// already follows the author, this is a no-op that still returns success so
// the client can reconcile state without a visible error.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { db, meta } = loadBlueskyItem(params.id);
    if (!meta.did) {
      throw new BlueskyActionError("Author DID not available yet", 409);
    }

    if (meta.viewer?.following_uri) {
      return NextResponse.json({ following: true, already: true });
    }

    const agent = await getBlueskyAgent();
    const res = await agent.follow(meta.did);

    meta.viewer = { ...(meta.viewer ?? {}), following_uri: res.uri };
    saveBlueskyMetadata(db, params.id, meta);
    propagateFollowToSiblings(db, meta.did, res.uri);

    return NextResponse.json({ following: true });
  } catch (err) {
    if (err instanceof BlueskyActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[api/items/bsky-follow] Error:", err);
    resetBlueskyAgent();
    return NextResponse.json({ error: "Bluesky follow failed" }, { status: 500 });
  }
}
