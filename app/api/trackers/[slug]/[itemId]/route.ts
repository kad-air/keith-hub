import { NextResponse } from "next/server";
import { getTrackerConfig } from "@/lib/tracker-config";
import { updateCollectionItem, untrimStatus } from "@/lib/craft";

export const dynamic = "force-dynamic";

export async function PUT(
  req: Request,
  { params }: { params: { slug: string; itemId: string } },
) {
  const config = getTrackerConfig(params.slug);
  if (!config) {
    return NextResponse.json({ error: "Unknown tracker" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const properties: Record<string, unknown> = {};

    if (typeof body.status === "string") {
      properties.status = untrimStatus(body.status);
    }
    if (typeof body.rating === "string") {
      properties.rating = body.rating;
    }
    if (typeof body.ranking === "number") {
      properties.ranking = body.ranking;
    }

    await updateCollectionItem(
      config.collectionId,
      params.itemId,
      properties,
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(
      `[trackers/${params.slug}/${params.itemId}] update error:`,
      err,
    );
    return NextResponse.json(
      { error: "Failed to update item" },
      { status: 500 },
    );
  }
}
