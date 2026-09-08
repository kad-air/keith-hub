"use client";

import { useRouter } from "next/navigation";
import { useKeyboard } from "@/lib/useKeyboard";

/**
 * Number keys for a section's in-page tabs: `1` → the first href, `2` → the
 * second, and so on. Mount it next to the tab row it mirrors. Renders
 * nothing. The labels live in `lib/shortcuts.ts` so the help overlay shows
 * them; keep the two in the same order.
 */
export default function SectionTabKeys({ hrefs }: { hrefs: string[] }) {
  const router = useRouter();
  const map: Record<string, () => void> = {};
  hrefs.slice(0, 9).forEach((href, i) => {
    map[String(i + 1)] = () => router.push(href);
  });
  useKeyboard(map);
  return null;
}
