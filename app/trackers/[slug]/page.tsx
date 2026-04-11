import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTrackerConfig } from "@/lib/tracker-config";
import { fetchCollectionItems, normalizeItems } from "@/lib/craft";
import TrackerClient from "@/components/TrackerClient";

export const dynamic = "force-dynamic";

interface Props {
  params: { slug: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const config = getTrackerConfig(params.slug);
  return { title: config ? `${config.label} — hub` : "Tracker — hub" };
}

export default async function TrackerPage({ params }: Props) {
  const config = getTrackerConfig(params.slug);
  if (!config) return notFound();

  try {
    const data = await fetchCollectionItems(config.collectionId);
    const items = normalizeItems(data.items, config);
    return <TrackerClient items={items} config={config} />;
  } catch (err) {
    console.error(`[trackers/${params.slug}] page fetch error:`, err);
    return (
      <article className="mx-auto max-w-[720px] px-6 py-16 text-center">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Failed to load {config.label}
        </p>
      </article>
    );
  }
}
