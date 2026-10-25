"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LIVE_POLL_MS, PENDING_POLL_MS } from "@/lib/hoops/scores/live";
import type { GameBox, GameState, LiveGame, LiveResponse } from "@/lib/hoops/scores/types";

interface LiveState {
  games: Record<string, LiveGame>;
  box: GameBox | null;
  /** Epoch ms of the last successful tick; null until one lands. */
  fetchedAt: number | null;
  /** The last tick failed (the cards keep showing what they had). */
  error: string | null;
}

const EMPTY: LiveState = { games: {}, box: null, fetchedAt: null, error: null };
const Ctx = createContext<LiveState>(EMPTY);

export function useLiveGame(id: string): LiveGame | null {
  return useContext(Ctx).games[id] ?? null;
}

export function useLive(): LiveState {
  return useContext(Ctx);
}

/**
 * The fast path, client side. Polls /api/hoops/scores/live and hands each
 * GameCard (and the box score) its live copy through context, so the page
 * patches in place instead of re-rendering the whole server tree every tick.
 *
 * Cadence follows what the LAST response said: a game in progress → every
 * LIVE_POLL_MS; only scheduled games left → PENDING_POLL_MS; nothing left to
 * watch → stop. Only while the tab is visible, with one immediate tick on
 * return — a backgrounded PWA shouldn't poll ESPN. One tick in flight at a
 * time. When a game changes STATE (tips, ends) the server page is refreshed
 * once so everything the overlay doesn't carry (winner, records, the notable
 * list) catches up through the slow path.
 */
export default function LiveProvider({
  dates,
  gameId = null,
  states,
  children,
}: {
  /** The day(s) whose games this page shows — today's page also lists last
   *  night's, and a late tip can still be running past midnight Mountain. */
  dates: string[];
  /** Set on the game page: a single game, plus its box score. */
  gameId?: string | null;
  /** The states the server rendered with, keyed by game id — a change on a
   *  tick triggers one router.refresh(). */
  states: Record<string, GameState>;
  children: ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>(EMPTY);
  const statesRef = useRef(states);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const tick = useCallback(async (): Promise<number | null> => {
    if (busy.current) return LIVE_POLL_MS;
    busy.current = true;
    try {
      const qs = new URLSearchParams();
      for (const d of dates) qs.append("date", d);
      if (gameId) qs.set("game", gameId);
      const res = await fetch(`/api/hoops/scores/live?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`live ${res.status}`);
      const body = (await res.json()) as LiveResponse & { error?: string | null };
      if (!alive.current) return null;
      const games: Record<string, LiveGame> = {};
      let flipped = false;
      for (const lg of body.games) {
        games[lg.game.id] = lg;
        const was = statesRef.current[lg.game.id];
        if (was !== undefined && was !== lg.game.state) flipped = true;
        statesRef.current[lg.game.id] = lg.game.state;
      }
      setState({ games, box: body.box ?? null, fetchedAt: body.fetchedAt, error: body.error ?? null });
      if (flipped) router.refresh();
      const anyLive = body.games.some((g) => g.game.state === "in");
      const anyPending = body.games.some((g) => g.game.state === "pre" && !g.game.postponed);
      return anyLive ? LIVE_POLL_MS : anyPending ? PENDING_POLL_MS : null;
    } catch (err) {
      if (alive.current) setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      return LIVE_POLL_MS * 3;
    } finally {
      busy.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates.join(","), gameId, router]);

  useEffect(() => {
    alive.current = true;
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const loop = async () => {
      clear();
      if (document.visibilityState !== "visible") return;
      const next = await tick();
      if (!alive.current || next === null || document.visibilityState !== "visible") return;
      timer.current = setTimeout(loop, next);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") void loop();
      else clear();
    };
    void loop();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive.current = false;
      clear();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [tick]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
