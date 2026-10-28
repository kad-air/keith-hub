"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { LIVE_POLL_MS, PENDING_POLL_MS } from "@/lib/hoops/scores/live";
import { loadSpoiler, saveSpoiler, type SpoilerMap } from "@/lib/hoops/scores/spoilerStore";
import type { GameBox, GameState, LiveGame, LiveResponse, SyncResolution, WirePlay } from "@/lib/hoops/scores/types";

interface LiveState {
  games: Record<string, LiveGame>;
  box: GameBox | null;
  /** The box is held to a synced moment (counting stats only). */
  held: boolean;
  /** The game page's play-by-play tab, as the last tick cut it; null when
   *  not asked for, veiled, or before tip. */
  plays: WirePlay[] | null;
  /** Epoch ms of the last successful tick; null until one lands. */
  fetchedAt: number | null;
  /** The last tick failed (the cards keep showing what they had). */
  error: string | null;
}

interface SpoilerApi {
  /** Today's page: started games are veiled unless revealed or synced. */
  protect: boolean;
  spoiler: SpoilerMap;
  reveal: (id: string) => void;
  syncTo: (id: string, offsetMs: number) => void;
  unsync: (id: string) => void;
  /** "I'm at `clockSec` left in `period`" → the server's resolution. */
  resolve: (id: string, period: number, clockSec: number) => Promise<SyncResolution>;
}

const EMPTY: LiveState = { games: {}, box: null, held: false, plays: null, fetchedAt: null, error: null };
const NO_SPOILER: SpoilerApi = {
  protect: false,
  spoiler: {},
  reveal: () => {},
  syncTo: () => {},
  unsync: () => {},
  resolve: async () => ({ ok: false, reason: "no-plays" }),
};
const Ctx = createContext<LiveState>(EMPTY);
const SpoilerCtx = createContext<SpoilerApi>(NO_SPOILER);

export function useLiveGame(id: string): LiveGame | null {
  return useContext(Ctx).games[id] ?? null;
}

export function useLive(): LiveState {
  return useContext(Ctx);
}

export function useSpoiler(): SpoilerApi {
  return useContext(SpoilerCtx);
}

/** How the game page may show one game, from the viewer's choice as the
 *  server last applied it: `pending` until the first tick lands under
 *  protection (the server render carries nothing to show), then `veiled`,
 *  `synced` (held to the moment) or `open`. `early` is a synced view whose
 *  moment is still before the opening tip. Unprotected pages are `open`. */
export type GameView = "open" | "pending" | "veiled" | "early" | "synced";

export function useGameView(id: string, guarded: boolean): GameView {
  const state = useContext(Ctx);
  const sp = useContext(SpoilerCtx);
  if (!guarded) return "open";
  const lg = state.games[id];
  if (!lg) return state.fetchedAt === null ? "pending" : "veiled";
  if (lg.veiled) return sp.spoiler[id]?.mode === "synced" && lg.moment === null ? "early" : "veiled";
  if (lg.moment && !lg.moment.final) return "synced";
  return "open";
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
 *
 * Spoiler mode (`protect`, today's page): the viewer's reveals and syncs live
 * in localStorage (spoilerStore.ts) and ride every tick as `reveal=` and
 * `sync=`, so the SERVER veils what hasn't been revealed — no hidden score is
 * ever on the wire. A synced game whose moment reaches the final is promoted
 * to revealed (there is nothing left to protect). Any change of choice kicks
 * an immediate tick.
 */
export default function LiveProvider({
  dates,
  gameId = null,
  states,
  protect = false,
  plays = false,
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
  protect?: boolean;
  /** The game page's play-by-play tab: ask for the plays with each tick. */
  plays?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>(EMPTY);
  const [spoiler, setSpoilerState] = useState<SpoilerMap>({});
  const spoilerRef = useRef<SpoilerMap>({});
  const statesRef = useRef(states);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const loopRef = useRef<() => void>(() => {});
  const date = dates[0];

  const setSpoiler = useCallback(
    (next: SpoilerMap) => {
      spoilerRef.current = next;
      setSpoilerState(next);
      saveSpoiler(date, next);
      loopRef.current();
    },
    [date],
  );

  const tick = useCallback(async (): Promise<number | null> => {
    if (busy.current) return LIVE_POLL_MS;
    busy.current = true;
    try {
      const qs = new URLSearchParams();
      for (const d of dates) qs.append("date", d);
      if (gameId) qs.set("game", gameId);
      if (gameId && plays) qs.set("plays", "1");
      if (protect) {
        qs.set("protect", "1");
        const sp = spoilerRef.current;
        const reveal = Object.keys(sp).filter((id) => sp[id].mode === "revealed");
        const sync = Object.keys(sp)
          .filter((id) => sp[id].mode === "synced")
          .map((id) => `${id}:${(sp[id] as { offsetMs: number }).offsetMs}`);
        if (reveal.length) qs.set("reveal", reveal.join(","));
        if (sync.length) qs.set("sync", sync.join(","));
      }
      const res = await fetch(`/api/hoops/scores/live?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`live ${res.status}`);
      const body = (await res.json()) as LiveResponse & { error?: string | null };
      if (!alive.current) return null;
      const games: Record<string, LiveGame> = {};
      let flipped = false;
      let promoted: SpoilerMap | null = null;
      for (const lg of body.games) {
        games[lg.game.id] = lg;
        const was = statesRef.current[lg.game.id];
        // A veiled or synced copy's state is the server's word on the real
        // game only when veiled (state is kept); a synced copy's is the moment's.
        if (!lg.moment && was !== undefined && was !== lg.game.state) flipped = true;
        if (!lg.moment) statesRef.current[lg.game.id] = lg.game.state;
        if (lg.moment?.final && spoilerRef.current[lg.game.id]?.mode === "synced") {
          promoted = { ...(promoted ?? spoilerRef.current), [lg.game.id]: { mode: "revealed" } };
        }
      }
      setState({
        games,
        box: body.box ?? null,
        held: body.held === true,
        plays: body.plays ?? null,
        fetchedAt: body.fetchedAt,
        error: body.error ?? null,
      });
      if (promoted) {
        spoilerRef.current = promoted;
        setSpoilerState(promoted);
        saveSpoiler(date, promoted);
      }
      if (flipped) router.refresh();
      const anyLive = body.games.some((g) => g.game.state === "in" || (g.moment && !g.moment.final));
      const anyPending = body.games.some((g) => g.game.state === "pre" && !g.game.postponed);
      return anyLive ? LIVE_POLL_MS : anyPending ? PENDING_POLL_MS : null;
    } catch (err) {
      if (alive.current) setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      return LIVE_POLL_MS * 3;
    } finally {
      busy.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates.join(","), gameId, protect, plays, router, date]);

  useEffect(() => {
    alive.current = true;
    if (protect) {
      const stored = loadSpoiler(date);
      spoilerRef.current = stored;
      setSpoilerState(stored);
    }
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
    loopRef.current = () => void loop();
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
  }, [tick, protect, date]);

  const api: SpoilerApi = {
    protect,
    spoiler,
    reveal: (id) => setSpoiler({ ...spoilerRef.current, [id]: { mode: "revealed" } }),
    syncTo: (id, offsetMs) => setSpoiler({ ...spoilerRef.current, [id]: { mode: "synced", offsetMs } }),
    unsync: (id) => {
      const next = { ...spoilerRef.current };
      delete next[id];
      setSpoiler(next);
    },
    resolve: async (id, period, clockSec) => {
      const qs = new URLSearchParams({ date, game: id, at: `${period}:${clockSec}`, protect: "1" });
      const res = await fetch(`/api/hoops/scores/live?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`live ${res.status}`);
      const body = (await res.json()) as LiveResponse;
      return body.resolution ?? { ok: false, reason: "no-plays" };
    },
  };

  return (
    <Ctx.Provider value={state}>
      <SpoilerCtx.Provider value={api}>{children}</SpoilerCtx.Provider>
    </Ctx.Provider>
  );
}
