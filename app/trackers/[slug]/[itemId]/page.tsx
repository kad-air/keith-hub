import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTrackerConfig } from "@/lib/tracker-config";
import { fetchCollectionItems, normalizeItems } from "@/lib/craft";
import type { CraftCollectionResponse } from "@/lib/craft-types";
import { buildExtraProps } from "@/lib/tracker-detail";
import TrackerItemClient from "@/components/TrackerItemClient";

export const dynamic = "force-dynamic";

interface Props {
  params: { slug: string; itemId: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const config = getTrackerConfig(params.slug);
  if (!config) return { title: "Tracker — hub" };
  try {
    const data = await fetchCollectionItems(config.collectionId);
    const item = normalizeItems(data.items, config).find(
      (i) => i.id === params.itemId,
    );
    if (!item) return { title: `${config.label} — hub` };
    return { title: `${item.name} — ${config.label} — hub` };
  } catch {
    return { title: `${config.label} — hub` };
  }
}

export default async function TrackerItemPage({ params }: Props) {
  const config = getTrackerConfig(params.slug);
  if (!config) return notFound();

  // Fetch in a narrow try/catch so a 404 (notFound below) isn't swallowed by
  // the network-error fallback — Next.js's notFound() throws an internal
  // error that must propagate to the framework.
  let data: CraftCollectionResponse;
  try {
    data = await fetchCollectionItems(config.collectionId);
  } catch (err) {
    console.error(
      `[trackers/${params.slug}/${params.itemId}] page fetch error:`,
      err,
    );
    return (
      <article className="mx-auto max-w-[720px] px-6 py-16 text-center">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Failed to load item
        </p>
      </article>
    );
  }

  const items = normalizeItems(data.items, config);
  const item = items.find((i) => i.id === params.itemId);
  if (!item) return notFound();

  const extraProps = buildExtraProps(data.schema, item.properties, config);

  return (
    <TrackerItemClient item={item} config={config} extraProps={extraProps} />
  );
}
