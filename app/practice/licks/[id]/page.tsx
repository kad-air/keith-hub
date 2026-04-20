import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLickById } from "@/lib/practice/licks";
import { isDone } from "@/lib/practice/progress";
import { LickDetailClient } from "./LickDetailClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const lick = getLickById(params.id);
  return { title: `${lick?.name ?? "Lick"} — Practice — hub` };
}

export default function LickDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const lick = getLickById(params.id);
  if (!lick) notFound();
  const learned = isDone(`lick:${lick.id}`);
  return <LickDetailClient lick={lick} initiallyLearned={learned} />;
}
