import type { Metadata } from "next";
import { LICKS } from "@/lib/practice/licks";
import { getLearnedLickIds } from "@/lib/practice/progress";
import { LickLibraryClient } from "./LickLibraryClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Licks — Practice — hub" };

export default function LicksPage() {
  const learnedIds = Array.from(getLearnedLickIds());
  return <LickLibraryClient licks={LICKS} initialLearned={learnedIds} />;
}
