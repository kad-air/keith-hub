"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { keepLastNight, loadSpoiler } from "@/lib/hoops/scores/spoilerStore";
import GamesSection from "./GamesSection";
import type { Game } from "@/lib/hoops/scores/types";

/**
 * Today's "Last night" list, until noon Mountain (lib/hoops/scores/dates.ts
 * lastNightUntil). After that only the games the viewer is still synced to
 * from last night stay (spoilerStore.ts keepLastNight); when none are, the
 * section is gone.
 *
 * The synced games live in this device's localStorage, so past noon the
 * server render carries an empty section and the kept games appear after
 * hydration: nothing shows and then vanishes. A page left open across noon
 * drops the rest at noon (or on the first look back, for a backgrounded PWA)
 * and refreshes the server tree once so last night's notable lines and its
 * live polling go with it.
 */
export default function LastNight({
  title,
  date,
  games,
  until,
  pastAtRender,
}: {
  title: string;
  /** Last night's date. */
  date: string;
  games: Game[] | null;
  /** Epoch ms of the cutoff. */
  until: number;
  /** The server's clock had passed `until` when it rendered. */
  pastAtRender: boolean;
}) {
  const router = useRouter();
  const [past, setPast] = useState(pastAtRender);
  // null until the stored syncs are read (never on the server render).
  const [kept, setKept] = useState<Set<string> | null>(null);
  const pastRef = useRef(pastAtRender);

  useEffect(() => {
    const ids = (games ?? []).map((g) => g.id);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const now = Date.now() >= until;
      setKept(new Set(keepLastNight(ids, loadSpoiler(date), now)));
      setPast(now);
      // Crossed noon on this page: let the server drop the rest too.
      if (now && !pastRef.current) router.refresh();
      pastRef.current = now;
      if (!now && timer === null) timer = setTimeout(check, until - Date.now());
    };
    const onVis = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [games, date, until, router]);

  if (!past) return <GamesSection title={title} date={date} games={games} />;
  if (!kept || !games) return null;
  const left = games.filter((g) => kept.has(g.id));
  if (left.length === 0) return null;
  return <GamesSection title={title} date={date} games={left} />;
}
