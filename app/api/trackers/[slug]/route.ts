import { NextResponse } from "next/server";
import { getTrackerConfig } from "@/lib/tracker-config";
import { fetchCollectionItems, normalizeItems } from "@/lib/craft";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const config = getTrackerConfig(params.slug);
  if (!config) {
    return NextResponse.json({ error: "Unknown tracker" }, { status: 404 });
  }

  try {
    const data = await fetchCollectionItems(config.collectionId);
    const items = normalizeItems(data.items, config);
    return NextResponse.json({ items });
  } catch (err) {
    console.error(`[trackers/${params.slug}] fetch error:`, err);
    return NextResponse.json(
      { error: "Failed to fetch tracker items" },
      { status: 500 },
    );
  }
}
