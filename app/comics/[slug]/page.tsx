import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getStoryline } from "@/lib/comics-data";
import { getReadComicIds } from "@/lib/queries";
import ComicsClient from "@/components/ComicsClient";

export const dynamic = "force-dynamic";

interface Props {
  params: { slug: string };
}

export function generateMetadata({ params }: Props): Metadata {
  const s = getStoryline(params.slug);
  return { title: s ? `${s.title} — hub` : "Comics — hub" };
}

export default function StorylinePage({ params }: Props) {
  const storyline = getStoryline(params.slug);
  if (!storyline) return notFound();

  const readIds = getReadComicIds();
  const initialReadIds = storyline.issues
    .filter((i) => readIds.has(i.id))
    .map((i) => i.id);

  return (
    <ComicsClient storyline={storyline} initialReadIds={initialReadIds} />
  );
}
