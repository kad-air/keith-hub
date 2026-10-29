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
 *
 * Until 3 AM (`protect`) the games arrive veiled from the server and render
 * under spoiler mode, as they did when they were tonight's. A page left open
 * across 3 AM refreshes the server tree once, which lifts the veil and brings
 * last night's notable lines.
 */
export default function LastNight({
  title,
  date,
  games,
  until,
  pastAtRender,
  protect = false,
  guardUntil,
}: {
  title: string;
  /** Last night's date. */
  date: string;
  games: Game[] | null;
  /** Epoch ms of the cutoff. */
  until: number;
  /** The server's clock had passed `until` when it rendered. */
  pastAtRender: boolean;
  /** Spoiler mode on last night (before 3 AM): `games` come veiled. */
  protect?: boolean;
  /** Epoch ms spoiler mode lets go of last night. */
  guardUntil: number;
}) {
  const router = useRouter();
  const [past, setPast] = useState(pastAtRender);
  // null until the stored syncs are read (never on the server render).
  const [kept, setKept] = useState<Set<string> | null>(null);
  const pastRef = useRef(pastAtRender);
  const guardRef = useRef(protect);

  useEffect(() => {
    const ids = (games ?? []).map((g) => g.id);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const now = Date.now() >= until;
      setKept(new Set(keepLastNight(ids, loadSpoiler(date), now)));
      setPast(now);
      // Crossed noon on this page: let the server drop the rest too.
      // Crossed 3 AM under guard: let the server lift the veil.
      const open = Date.now() >= guardUntil;
      if ((now && !pastRef.current) || (open && guardRef.current)) router.refresh();
      pastRef.current = now;
      if (open) guardRef.current = false;
      const next = [until, ...(guardRef.current ? [guardUntil] : [])].filter((t) => t > Date.now());
      if (timer) clearTimeout(timer);
      timer = next.length ? setTimeout(check, Math.min(...next) - Date.now()) : null;
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
  }, [games, date, until, guardUntil, router]);

  if (!past) return <GamesSection title={title} date={date} games={games} protect={protect} />;
  if (!kept || !games) return null;
  const left = games.filter((g) => kept.has(g.id));
  if (left.length === 0) return null;
  return <GamesSection title={title} date={date} games={left} protect={protect} />;
}
