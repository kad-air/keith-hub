"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Item, CategoryCounts, ItemsResponse } from "@/lib/types";
import { groupByDate } from "@/lib/groupByDate";
import { useKeyboard } from "@/lib/useKeyboard";
import FeedCard from "@/components/FeedCard";
import Toast from "@/components/Toast";
import KeyboardHelp from "@/components/KeyboardHelp";

interface FeedClientProps {
  initialItems: Item[];
  initialCounts: CategoryCounts;
}

// Safety ceiling for client-side refetch. Matches MAIN_FEED_LIMIT in
// app/page.tsx. The actual feed size is bounded by TTL pruning, not this.
const FEED_LIMIT = 2000;

// ── Chunked rendering ────────────────────────────────────────
// Render items in progressive chunks instead of all at once to keep
// initial DOM size small. More chunks load as the user scrolls.
const INITIAL_CHUNK = 50;
const CHUNK_SIZE = 50;

// ── Pull to refresh ──────────────────────────────────────────
// Finger travel is damped before driving the indicator zone's height,
// giving the drag rubber-band resistance. Crossing PULL_ARM_HEIGHT
// (damped px) arms the gesture — the arrow flips and the label changes;
// releasing while armed holds the zone at PULL_HOLD_HEIGHT until the
// refresh completes.
const PULL_DAMPING = 0.5;
const PULL_ARM_HEIGHT = 64;
const PULL_MAX_HEIGHT = 110;
const PULL_HOLD_HEIGHT = 52;

const CATEGORIES: Array<{ id: keyof CategoryCounts; label: string }> = [
  { id: "all", label: "All" },
  { id: "podcasts", label: "Podcasts" },
  { id: "music", label: "Music" },
  { id: "books", label: "Books" },
  { id: "film", label: "Film" },
  { id: "tech_review", label: "Tech Review" },
  { id: "reading", label: "Reading" },
  { id: "bluesky", label: "Bluesky" },
];

interface PendingDismiss {
  ids: string[];
  // For per-item dismiss/dismiss-all flows we snapshot the items so undo
  // can restore them in place. For mark-all-as-read the snapshot would be
  // huge (potentially thousands of items), so we leave it empty and the
  // undo handler refetches from the server instead.
  items: Item[];
  message: string;
}

interface NewItemsAvailable {
  items: Item[];
  counts: CategoryCounts;
  newCount: number;
}

const VALID_CATEGORIES = new Set<string>(CATEGORIES.map((c) => c.id));

export default function FeedClient({
  initialItems,
  initialCounts,
}: FeedClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // URL is the source of truth for which tab is active so refreshes,
  // shared links, and PWA cold-starts all restore the same view.
  const urlCategory = searchParams.get("category");
  const initialCategory: keyof CategoryCounts =
    urlCategory && VALID_CATEGORIES.has(urlCategory)
      ? (urlCategory as keyof CategoryCounts)
      : "all";
  const [items, setItems] = useState<Item[]>(initialItems);
  const [counts, setCounts] = useState<CategoryCounts>(initialCounts);
  const [activeCategory, setActiveCategory] =
    useState<keyof CategoryCounts>(initialCategory);
  const [swapping, setSwapping] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);
  // Discrete pull-to-refresh phase for the indicator label. The continuous
  // height tracking bypasses React entirely (see the gesture effect).
  const [pullPhase, setPullPhase] = useState<
    "idle" | "pull" | "armed" | "refreshing"
  >("idle");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [pending, setPending] = useState<PendingDismiss | null>(null);
  const [newItemsAvailable, setNewItemsAvailable] =
    useState<NewItemsAvailable | null>(null);
  const [bskyError, setBskyError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [renderedCount, setRenderedCount] = useState(INITIAL_CHUNK);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pullZoneRef = useRef<HTMLDivElement>(null);
  // Gate scrollIntoView to keyboard-driven focus changes only. Touch and
  // hover also call onFocus to set focusedIndex — without this gate, tapping
  // a card (onTouchStart fires before the tap commits) or drifting the mouse
  // across cards would trigger smooth-scrolling mid-gesture.
  const keyboardFocusRef = useRef(false);

  // ─── Category cache ──────────────────────────────────────
  // Avoids redundant network round-trips when switching between tabs.
  // Entries older than 30s are treated as stale and refetched.
  const categoryCache = useRef(
    new Map<string, { items: Item[]; counts: CategoryCounts; ts: number }>(),
  );

  // ─── Item actions ─────────────────────────────────────────
  const invalidateCache = useCallback(() => {
    categoryCache.current.clear();
  }, []);

  // ─── Data fetching ────────────────────────────────────────
  const fetchItems = useCallback(
    async (category: keyof CategoryCounts) => {
      // Any user-driven refresh supersedes a pending "new items" toast.
      setNewItemsAvailable(null);

      // Use cached data if fresh (< 30s old)
      const cached = categoryCache.current.get(category);
      if (cached && Date.now() - cached.ts < 30_000) {
        setItems(cached.items);
        setCounts(cached.counts);
        setFocusedIndex(0);
        setRenderedCount(INITIAL_CHUNK);
        return;
      }

      setSwapping(true);
      try {
        const params = new URLSearchParams({
          limit: String(FEED_LIMIT),
          offset: "0",
        });
        if (category !== "all") params.set("category", category);
        const res = await fetch(`/api/items?${params}`, { cache: "no-store" });
        if (!res.ok) throw new Error("fetch failed");
        const data = (await res.json()) as ItemsResponse;
        setItems(data.items);
        setCounts(data.counts);
        setFocusedIndex(0);
        setRenderedCount(INITIAL_CHUNK);
        categoryCache.current.set(category, {
          items: data.items,
          counts: data.counts,
          ts: Date.now(),
        });
      } catch (err) {
        console.error("[FeedClient] Fetch error:", err);
      } finally {
        setSwapping(false);
      }
    },
    []
  );

  const handleCategoryChange = useCallback(
    (cat: keyof CategoryCounts) => {
      if (cat === activeCategory) return;
      setActiveCategory(cat);
      void fetchItems(cat);
      // Mirror the active tab into the URL. replace() (not push) so each
      // tap doesn't pile up in browser history — back should leave the page.
      const url = cat === "all" ? "/" : `/?category=${cat}`;
      router.replace(url, { scroll: false });
    },
    [activeCategory, fetchItems, router]
  );

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    invalidateCache();
    setRefreshing(true);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.ok) throw new Error("refresh failed");
      const data = (await res.json()) as {
        fetched: number;
        rss: number;
        bluesky: number;
      };
      // Only count items that actually land in the active view. New bsky
      // posts don't grow the All view (its bsky contribution is derived
      // from the RSS total), so a bsky-only crawl reads as "Up to date"
      // everywhere except the Bluesky tab.
      const relevant = activeCategory === "bluesky" ? data.bluesky : data.rss;
      setRefreshResult(
        relevant > 0
          ? `${relevant} new item${relevant === 1 ? "" : "s"}`
          : "Up to date"
      );
      await fetchItems(activeCategory);
    } catch {
      setRefreshResult("Refresh failed");
    } finally {
      setRefreshing(false);
      // Safety clear in case the toast never mounts (a higher-priority
      // toast like undo can occupy the slot past the toast's own timer).
      setTimeout(() => setRefreshResult(null), 4000);
    }
  }, [activeCategory, fetchItems, refreshing, invalidateCache]);

  // ─── Sync URL → data on mount ────────────────────────────
  // Server SSR's the All view. If the URL says otherwise (deep link,
  // refresh on a filtered tab, PWA cold-start), fetch the right slice.
  useEffect(() => {
    if (initialCategory !== "all") {
      void fetchItems(initialCategory);
    }
    // Mount-only: subsequent URL changes come from handleCategoryChange,
    // which already updates state and fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Silent auto-refresh on PWA resume ────────────────────
  // When the user switches back to the app, trigger a server-side fetch so
  // new content is ready, and update the tab badge counts — but do NOT
  // replace the visible item list or reset focusedIndex, which would yank
  // the user's scroll position to the top of the feed. If new items are
  // available, surface a toast offering to load them on demand.
  const lastRefreshRef = useRef(0);
  // Latest-items ref consumed by event handlers so their identity can stay
  // stable across `items` changes. Assigned during render (not in an effect)
  // so handlers firing between render and effect don't see stale items.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Same trick for focusedIndex — read by the visibility-change handler
  // without adding it to the effect deps (which would re-register on every
  // j/k press).
  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;
  // Same trick for the pull gesture's handlers.
  const pullPhaseRef = useRef(pullPhase);
  pullPhaseRef.current = pullPhase;
  const refreshingRef = useRef(refreshing);
  refreshingRef.current = refreshing;
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshRef.current < 60_000) return;
      lastRefreshRef.current = Date.now();
      invalidateCache();
      fetch("/api/refresh", { method: "POST" })
        .then(() => {
          // Fetch fresh data for counts and new-items detection — don't
          // touch the visible items or scroll position unless the user
          // explicitly opts in via the "Load now" toast action.
          const params = new URLSearchParams({
            limit: String(FEED_LIMIT),
            offset: "0",
          });
          if (activeCategory !== "all") params.set("category", activeCategory);
          return fetch(`/api/items?${params}`, { cache: "no-store" });
        })
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then((data: ItemsResponse) => {
          setCounts(data.counts);
          const currentIds = new Set(itemsRef.current.map((it) => it.id));
          // On the All view, ignore bluesky rows when counting what's new:
          // surprise sampling rotates which bsky posts appear on every
          // query, so they'd register as "new" even when nothing was
          // fetched. Only RSS arrivals are worth disturbing the user for.
          const newCount = data.items.reduce(
            (n, it) =>
              currentIds.has(it.id) ||
              (activeCategory === "all" && it.source_category === "bluesky")
                ? n
                : n + 1,
            0
          );
          if (newCount === 0) return;
          // If the user is already at the top of the feed with nothing
          // keyboard-focused deep in the list, there's no scroll position
          // to preserve — just apply the update silently. Otherwise surface
          // the "Load now" toast so their read position isn't yanked.
          const atTop =
            typeof window !== "undefined" &&
            window.scrollY < 100 &&
            focusedIndexRef.current === 0;
          if (atTop) {
            setItems(data.items);
            setRenderedCount(INITIAL_CHUNK);
            return;
          }
          setNewItemsAvailable({
            items: data.items,
            counts: data.counts,
            newCount,
          });
        })
        .catch(() => {});
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [activeCategory, invalidateCache]);

  // Apply the pending new-items payload — the user has opted in, so replacing
  // the list and snapping focus to the top is the expected behavior.
  const handleLoadNewItems = useCallback(() => {
    setNewItemsAvailable((pending) => {
      if (!pending) return null;
      setItems(pending.items);
      setCounts(pending.counts);
      setFocusedIndex(0);
      setRenderedCount(INITIAL_CHUNK);
      return null;
    });
  }, []);

  // Also stamp the ref on manual refresh so the 60s guard works both ways
  useEffect(() => {
    if (refreshing) lastRefreshRef.current = Date.now();
  }, [refreshing]);

  const removeFromList = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const decrementCount = useCallback(
    (item: Item) => {
      setCounts((prev) => {
        const next = { ...prev, all: Math.max(0, prev.all - 1) };
        const cat = item.source_category as keyof CategoryCounts | undefined;
        if (cat && cat in next && cat !== "all") {
          next[cat] = Math.max(0, next[cat] - 1);
        }
        return next;
      });
    },
    []
  );

  const handleOpen = useCallback(
    async (item: Item) => {
      invalidateCache();
      const podcastMeta =
        item.source_category === "podcasts" && item.metadata
          ? (() => {
              try {
                return JSON.parse(item.metadata) as { apple_id?: string };
              } catch {
                return null;
              }
            })()
          : null;
      const url =
        podcastMeta?.apple_id
          ? `https://podcasts.apple.com/podcast/id${podcastMeta.apple_id}`
          : item.url;
      // iOS standalone PWA quirk: window.open(url, "_blank") opens the link
      // in BOTH Safari and an in-PWA SFSafariViewController-style overlay,
      // because WebKit half-implements the API. Using a programmatic anchor
      // click instead — iOS treats <a target="_blank"> as a clean handoff to
      // Safari without the overlay.
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      removeFromList(item.id);
      decrementCount(item);
      try {
        // /open marks the item as both read AND consumed, so it appears
        // in the /read view. /read alone would only mark it as dismissed.
        await fetch(`/api/items/${item.id}/open`, { method: "POST" });
      } catch {
        // best effort
      }
    },
    [removeFromList, decrementCount, invalidateCache]
  );

  const handleSave = useCallback(
    async (item: Item) => {
      invalidateCache();
      const wasSaved = !!item.saved_at;
      // Optimistic: when saving (not unsaving), the item leaves the feed
      if (!wasSaved) {
        removeFromList(item.id);
        decrementCount(item);
      } else {
        // Toggle saved state in-place
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, saved_at: null } : it
          )
        );
      }
      try {
        await fetch(`/api/items/${item.id}/save`, { method: "POST" });
      } catch (err) {
        console.error("[FeedClient] Save error:", err);
      }
    },
    [removeFromList, decrementCount, invalidateCache]
  );

  // Bluesky write actions. FeedCard owns the optimistic UI flip; these
  // functions just fire the request and surface a toast on failure. Return
  // true on success so the card keeps its optimistic state, false on failure
  // so it reverts.
  const postBskyAction = useCallback(
    async (item: Item, path: string, errorMessage: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/items/${item.id}/${path}`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`${path} ${res.status}`);
        return true;
      } catch (err) {
        console.error(`[FeedClient] bsky ${path} error:`, err);
        setBskyError(errorMessage);
        return false;
      }
    },
    []
  );
  const handleBskyLike = useCallback(
    (item: Item) => postBskyAction(item, "bsky-like", "Couldn’t like that post"),
    [postBskyAction]
  );
  const handleBskyRepost = useCallback(
    (item: Item) => postBskyAction(item, "bsky-repost", "Couldn’t repost that"),
    [postBskyAction]
  );
  const handleBskyFollow = useCallback(
    (item: Item) => postBskyAction(item, "bsky-follow", "Couldn’t follow that account"),
    [postBskyAction]
  );

  const handleDismiss = useCallback(
    async (item: Item) => {
      invalidateCache();
      removeFromList(item.id);
      decrementCount(item);
      setPending({
        ids: [item.id],
        items: [item],
        message: "Dismissed",
      });
      try {
        await fetch(`/api/items/${item.id}/read`, { method: "POST" });
      } catch {
        // best effort
      }
    },
    [removeFromList, decrementCount, invalidateCache]
  );

  // Clear above: dismiss the targeted item plus every card rendered above it.
  // Semantically identical to bulk-dismissing those items — only read_at gets
  // set, never consumed_at, so they don't pollute /read. Snapshot the items
  // so undo can restore them in place instead of refetching.
  //
  // Reads the current items via itemsRef so this callback's identity stays
  // stable across items changes — if items were in the dep list, every
  // dismiss would rebuild the callback and defeat FeedCard's memo, forcing
  // every rendered card to re-render.
  const handleClearAbove = useCallback(
    async (item: Item) => {
      invalidateCache();
      const current = itemsRef.current;
      const cutoff = current.findIndex((it) => it.id === item.id);
      if (cutoff < 0) return;
      const toClear = current.slice(0, cutoff + 1);
      const clearIds = toClear.map((it) => it.id);
      const clearIdSet = new Set(clearIds);
      const clearCount = clearIds.length;
      if (clearCount === 0) return;

      setItems((prev) => prev.filter((it) => !clearIdSet.has(it.id)));
      setCounts((prev) => {
        const next = { ...prev };
        next.all = Math.max(0, next.all - clearCount);
        for (const it of toClear) {
          const cat = it.source_category as keyof CategoryCounts | undefined;
          if (cat && cat in next && cat !== "all") {
            next[cat] = Math.max(0, next[cat] - 1);
          }
        }
        return next;
      });

      setPending({
        ids: clearIds,
        items: toClear,
        message: `Cleared ${clearCount} item${clearCount === 1 ? "" : "s"}`,
      });
      setFocusedIndex(0);

      // The cleared cards vanished synchronously; without this the user
      // ends up scrolled deep into what's now empty/shifted content. Wait
      // for the removal to commit, then glide to the top so "clear above"
      // always lands at the top of the feed.
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      try {
        await fetch("/api/items/read-bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: clearIds }),
        });
      } catch {
        // best effort
      }
    },
    [invalidateCache]
  );

  // Bulk dismiss: marks the currently-visible items as read using their
  // specific IDs. Only items the user has actually seen get dismissed — any
  // new items that arrived on the server in the interim survive and will
  // populate the feed after the dismiss completes.
  //
  // Important: this is a DISMISS, not a "I read these" action. It only sets
  // item_state.read_at, never consumed_at, so bulk-dismissed items do NOT
  // appear in the /read history view (which queries on consumed_at). Same
  // semantic as the per-card dismiss button.
  const handleMarkAllRead = useCallback(async () => {
    invalidateCache();
    // Read current items via ref so this callback's identity stays stable —
    // closing over `items` would rebuild it on every dismiss.
    const dismissIds = itemsRef.current.map((it) => it.id);
    const dismissCount = dismissIds.length;
    if (dismissCount === 0) return;

    // Optimistic UI: empty the visible list and zero the relevant count(s).
    setItems([]);
    setCounts((prev) => {
      if (activeCategory === "all") {
        return { all: 0, reading: 0, tech_review: 0, books: 0, music: 0, film: 0, podcasts: 0, bluesky: 0 };
      }
      return { ...prev, [activeCategory]: 0, all: Math.max(0, prev.all - dismissCount) };
    });

    try {
      await fetch("/api/items/read-bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: dismissIds }),
      });
    } catch {
      // best effort — counts/items will reconcile on the next refresh
    }

    setPending({
      ids: dismissIds,
      // Empty items[] tells handleUndo to refetch instead of restoring in
      // place — see the PendingDismiss comment above.
      items: [],
      message: `Dismissed ${dismissCount} item${dismissCount === 1 ? "" : "s"}`,
    });

    // Refetch to reveal any new items that arrived while the user was
    // browsing. This runs after the pending toast is set so the user sees
    // the undo option immediately.
    void fetchItems(activeCategory);
  }, [activeCategory, invalidateCache, fetchItems]);

  const handleUndo = useCallback(async () => {
    if (!pending) return;
    const { ids, items: restored } = pending;

    // Two undo paths depending on whether we have an items snapshot:
    //
    //  - With snapshot (per-item dismiss / Dismiss-visible flow): merge the
    //    restored items back into the visible list and bump the counts. The
    //    server-side unread happens after.
    //  - Without snapshot (Mark-all-as-read flow): we never had the items
    //    in memory because there could have been thousands. Clear read_at on
    //    the saved IDs and refetch the visible list from the server.
    if (restored.length > 0) {
      setItems((prev) => {
        const map = new Map<string, Item>();
        for (const it of restored) map.set(it.id, it);
        for (const it of prev) map.set(it.id, it);
        return Array.from(map.values()).sort((a, b) =>
          a.published_at < b.published_at ? 1 : -1
        );
      });
      setCounts((prev) => {
        const next = { ...prev };
        for (const it of restored) {
          next.all += 1;
          const cat = it.source_category as keyof CategoryCounts | undefined;
          if (cat && cat in next && cat !== "all") {
            next[cat] += 1;
          }
        }
        return next;
      });
    }
    setPending(null);

    try {
      if (ids.length === 1) {
        await fetch(`/api/items/${ids[0]}/unread`, { method: "POST" });
      } else if (ids.length > 0) {
        await fetch("/api/items/read-bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, unread: true }),
        });
      }
    } catch (err) {
      console.error("[FeedClient] Undo error:", err);
    }

    // Mark-all-undo: refetch the visible list from the server now that
    // read_at is cleared. This is the only path that takes us through
    // fetchItems on undo.
    if (restored.length === 0) {
      void fetchItems(activeCategory);
    }
  }, [pending, fetchItems, activeCategory]);

  // ─── Keep focusedIndex within bounds ─────────────────────
  useEffect(() => {
    if (focusedIndex >= items.length && items.length > 0) {
      setFocusedIndex(items.length - 1);
    }
  }, [items.length, focusedIndex]);

  // Scroll focused card into view when keyboard nav changes the index.
  // Skipped when the focus change came from touch/hover — those set
  // focusedIndex too but the user hasn't asked to be scrolled.
  useEffect(() => {
    if (!keyboardFocusRef.current) return;
    keyboardFocusRef.current = false;
    const el = cardRefs.current[focusedIndex];
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedIndex]);

  // ─── Keyboard shortcuts ──────────────────────────────────
  useKeyboard(
    {
      j: () => {
        keyboardFocusRef.current = true;
        setFocusedIndex((i) => {
          const next = Math.min(items.length - 1, i + 1);
          if (next >= renderedCount) {
            setRenderedCount((prev) => Math.min(prev + CHUNK_SIZE, items.length));
          }
          return next;
        });
      },
      k: () => {
        keyboardFocusRef.current = true;
        setFocusedIndex((i) => Math.max(0, i - 1));
      },
      o: () => {
        const it = items[focusedIndex];
        if (it) void handleOpen(it);
      },
      enter: () => {
        const it = items[focusedIndex];
        if (it) void handleOpen(it);
      },
      s: () => {
        const it = items[focusedIndex];
        if (it) void handleSave(it);
      },
      x: () => {
        const it = items[focusedIndex];
        if (it) void handleDismiss(it);
      },
      e: () => {
        const it = items[focusedIndex];
        if (it) void handleDismiss(it);
      },
      c: () => {
        const it = items[focusedIndex];
        if (it) void handleClearAbove(it);
      },
      r: () => void handleRefresh(),
      "g h": () => router.push("/"),
      "g s": () => router.push("/saved"),
      "g r": () => router.push("/read"),
      "?": () => setHelpOpen((v) => !v),
    },
    !helpOpen
  );

  // ─── Pull to refresh (touch only) ────────────────────────
  // The indicator zone above the category nav grows 1:damped with the
  // finger, flips to "Release to refresh" past the arm threshold, and
  // holds open with a spinner while the crawl runs. Height/opacity are
  // written straight to the DOM during the drag — a setState per
  // touchmove would re-render the whole card list at 60Hz. React state
  // only tracks the discrete phase, which drives the label. The native
  // overscroll bounce is suppressed via overscroll-behavior on <body>
  // (globals.css), so this zone is the only thing that moves.
  useEffect(() => {
    const zone = pullZoneRef.current;
    if (!zone) return;

    let startX = 0;
    let startY = 0;
    let tracking = false; // touch began at the top of the page
    let engaged = false; // vertical pull won the gesture

    function setZone(px: number, animate: boolean) {
      zone!.style.transition = animate
        ? "height 220ms ease-out, opacity 220ms ease-out"
        : "none";
      zone!.style.height = `${px}px`;
      zone!.style.opacity =
        px === 0 ? "0" : String(Math.min(px / PULL_ARM_HEIGHT, 1));
    }

    function onTouchStart(e: TouchEvent) {
      // Only from the very top, and never on top of an in-flight refresh.
      if (
        window.scrollY > 0 ||
        refreshingRef.current ||
        pullPhaseRef.current === "refreshing"
      )
        return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      engaged = false;
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!engaged) {
        // Let horizontal gestures (card swipes) win before engaging.
        if (Math.abs(dx) > 10 && Math.abs(dx) > dy) {
          tracking = false;
          return;
        }
        if (dy <= 8) return;
        engaged = true;
      }
      if (dy <= 0) {
        // Reversed direction — abort and hand the page back to scrolling.
        tracking = false;
        engaged = false;
        setZone(0, true);
        setPullPhase("idle");
        return;
      }
      const height = Math.min(dy * PULL_DAMPING, PULL_MAX_HEIGHT);
      setZone(height, false);
      const phase = height >= PULL_ARM_HEIGHT ? "armed" : "pull";
      if (pullPhaseRef.current !== phase) {
        setPullPhase(phase);
        // Haptic tick at the commit point. No-op on iOS (Safari has no
        // vibration API) — there the arrow flip + label swap carry it.
        if (phase === "armed") navigator.vibrate?.(10);
      }
    }

    function onTouchEnd() {
      if (!tracking) return;
      tracking = false;
      if (!engaged) return;
      engaged = false;
      if (pullPhaseRef.current === "armed") {
        setPullPhase("refreshing");
        setZone(PULL_HOLD_HEIGHT, true);
        void handleRefresh();
      } else {
        setPullPhase("idle");
        setZone(0, true);
      }
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [handleRefresh]);

  // Collapse the held pull zone once the refresh settles.
  useEffect(() => {
    if (pullPhase !== "refreshing" || refreshing) return;
    const zone = pullZoneRef.current;
    if (zone) {
      zone.style.transition = "height 250ms ease-in-out, opacity 250ms ease-in-out";
      zone.style.height = "0px";
      zone.style.opacity = "0";
    }
    setPullPhase("idle");
  }, [pullPhase, refreshing]);

  // ─── Chunked rendering ───────────────────────────────────
  // Wholesale list replacements (category switch, refresh, load-new-items)
  // reset renderedCount explicitly at their call sites. Here we only clamp
  // so a dismiss that shrinks items below the current renderedCount doesn't
  // leave the sentinel unreachable — and crucially, a dismiss from a
  // deep-scrolled position doesn't truncate the rendered window back to 50.
  useEffect(() => {
    setRenderedCount((prev) => Math.min(prev, Math.max(INITIAL_CHUNK, items.length)));
  }, [items.length]);

  // Load more chunks as the user scrolls near the sentinel
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRenderedCount((prev) => Math.min(prev + CHUNK_SIZE, items.length));
        }
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [items.length]);

  // ─── Derived ──────────────────────────────────────────────
  // Slice to rendered chunk for progressive rendering
  const visibleItems = useMemo(
    () => items.slice(0, renderedCount),
    [items, renderedCount],
  );

  // The All view is stride-interleaved — date headers would chop the
  // carefully mixed sequence into clumps. Category-filtered views are
  // pure recency, so date dividers are still useful there.
  const grouped = useMemo(
    () =>
      activeCategory === "all"
        ? [{ bucket: null, items: visibleItems }]
        : groupByDate(visibleItems),
    [visibleItems, activeCategory]
  );

  // Build a flat order so keyboard nav indices line up with grouped render
  // (groupByDate preserves input order so a flat re-walk gives the same items)
  let flatIndex = -1;

  return (
    <div className="mx-auto max-w-[720px] px-2 pb-32 pt-6">
      {/* ── Pull-to-refresh zone ── */}
      {/* Height/opacity are driven directly by the gesture effect; only the
          label re-renders on phase changes. aria-hidden: the outcome is
          announced by the refresh toast, this is gesture feedback. */}
      <div
        ref={pullZoneRef}
        aria-hidden
        className="relative overflow-hidden"
        style={{ height: 0, opacity: 0 }}
      >
        <div className="absolute inset-x-0 bottom-2.5 flex items-center justify-center gap-2.5 font-mono text-[0.68rem] uppercase tracking-kicker">
          {pullPhase === "refreshing" ? (
            <>
              <span className="inline-block animate-spin font-display text-[0.95rem] leading-none text-accent">
                ⁂
              </span>
              <span className="text-cream-dim">Refreshing</span>
            </>
          ) : (
            <>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={[
                  "transition-transform duration-150",
                  pullPhase === "armed"
                    ? "rotate-180 text-accent"
                    : "text-cream-dimmer",
                ].join(" ")}
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <polyline points="5 12 12 19 19 12" />
              </svg>
              <span
                className={
                  pullPhase === "armed" ? "text-cream" : "text-cream-dimmer"
                }
              >
                {pullPhase === "armed" ? "Release to refresh" : "Pull to refresh"}
              </span>
            </>
          )}
        </div>
      </div>

      {/* ── Category nav ── */}
      {/* Refresh has no button: pull-to-refresh on touch, `r` on desktop,
          and the PWA-resume auto-refresh cover it. Feedback rides the toast. */}
      <nav className="mb-5 flex items-baseline gap-5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {CATEGORIES.map((cat) => {
          const isActive = activeCategory === cat.id;
          const count = counts[cat.id];
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => handleCategoryChange(cat.id)}
              className={[
                "group flex shrink-0 items-baseline gap-1.5 whitespace-nowrap font-mono text-[0.75rem] uppercase tracking-kicker transition-colors",
                // Vertical hit zone bump on touch devices. No negative-margin
                // compensation — inside the overflow-x scroll container it
                // would clip; the row just runs slightly taller on touch.
                "[@media(hover:none)]:py-2",
                isActive
                  ? "text-cream"
                  : "text-cream-dim hover:text-cream",
              ].join(" ")}
            >
              <span
                className={[
                  "border-b border-transparent pb-0.5 transition-colors",
                  isActive ? "border-accent" : "group-hover:border-rule-strong",
                ].join(" ")}
              >
                {cat.label}
              </span>
              {cat.id !== "bluesky" && (
                <span
                  className={[
                    "tabular-nums text-[0.7rem]",
                    isActive ? "text-accent" : "text-cream-dim",
                  ].join(" ")}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* ── Feed list ── */}
      {items.length === 0 && !swapping ? (
        <EmptyState />
      ) : (
        <div
          className={[
            "transition-opacity duration-200",
            swapping ? "opacity-30" : "opacity-100",
          ].join(" ")}
        >
          {grouped.map((group) => (
            <section key={group.bucket ?? "interleaved"}>
              {group.bucket && <DateDivider label={group.bucket} />}
              {group.items.map((item) => {
                flatIndex += 1;
                const myIndex = flatIndex;
                return (
                  <FeedCard
                    key={item.id}
                    item={item}
                    index={myIndex}
                    focused={myIndex === focusedIndex}
                    ref={(el) => {
                      cardRefs.current[myIndex] = el;
                    }}
                    onFocus={setFocusedIndex}
                    onOpen={handleOpen}
                    onSave={handleSave}
                    onDismiss={handleDismiss}
                    onClearAbove={handleClearAbove}
                    onBskyLike={handleBskyLike}
                    onBskyRepost={handleBskyRepost}
                    onBskyFollow={handleBskyFollow}
                  />
                );
              })}
            </section>
          ))}

          {/* Sentinel for progressive chunk loading */}
          {renderedCount < items.length && (
            <div ref={sentinelRef} className="h-px" />
          )}

          {items.length > 0 && renderedCount >= items.length && (
            <FooterActions
              count={items.length}
              onMarkAllRead={handleMarkAllRead}
              onShowHelp={() => setHelpOpen(true)}
            />
          )}
        </div>
      )}

      {/* ── Toast ── */}
      {pending ? (
        <Toast
          message={pending.message}
          actionLabel="Undo"
          onAction={handleUndo}
          onDismiss={() => setPending(null)}
        />
      ) : (refreshing && pullPhase !== "refreshing") || refreshResult ? (
        // In-flight feedback for keyboard/resume-initiated refreshes only —
        // a pull shows its own "Refreshing" state in the pull zone, so the
        // toast would double up. The result still lands here for both.
        <Toast
          message={refreshResult ?? "Refreshing…"}
          onDismiss={() => setRefreshResult(null)}
          // In flight: park the auto-dismiss far out; when the result lands
          // the durationMs change re-arms the timer at the short value.
          durationMs={refreshing ? 60000 : 3500}
        />
      ) : bskyError ? (
        <Toast
          message={bskyError}
          onDismiss={() => setBskyError(null)}
          durationMs={4000}
        />
      ) : newItemsAvailable ? (
        <Toast
          message={`${newItemsAvailable.newCount} new item${
            newItemsAvailable.newCount === 1 ? "" : "s"
          }`}
          actionLabel="Load now"
          onAction={handleLoadNewItems}
          onDismiss={() => setNewItemsAvailable(null)}
          durationMs={15000}
        />
      ) : null}

      {/* ── Help overlay ── */}
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────

function DateDivider({ label }: { label: string }) {
  return (
    <div className="mb-1 mt-7 flex items-center gap-3 px-6 first:mt-0">
      <span className="font-mono text-[0.72rem] uppercase tracking-kicker text-cat-film">
        {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-rule" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-6 py-24 text-center">
      <p className="font-display text-[1.05rem] italic text-cream-dim opsz-body">
        ⁂
      </p>
      <h2 className="mt-4 font-display text-[2.2rem] font-medium italic leading-tight text-cream opsz-display">
        You&rsquo;re caught up.
      </h2>
      <p className="mt-3 font-display text-[0.95rem] italic text-cream-dim">
        Close the tab. Go do something.
      </p>
    </div>
  );
}

interface FooterActionsProps {
  count: number;
  onMarkAllRead: () => void;
  onShowHelp: () => void;
}

function FooterActions({ count, onMarkAllRead, onShowHelp }: FooterActionsProps) {
  return (
    <div className="mt-10 px-6 pb-2 text-center">
      <div className="mb-4 flex items-center justify-center gap-3 text-cream-dimmer">
        <span aria-hidden className="h-px w-12 bg-rule" />
        <span className="font-mono text-[0.68rem] uppercase tracking-kicker">
          end of feed
        </span>
        <span aria-hidden className="h-px w-12 bg-rule" />
      </div>
      <p className="mb-5 font-display text-[0.9rem] italic text-cream-dim">
        {count} {count === 1 ? "item" : "items"} remaining.
      </p>
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={onMarkAllRead}
          className="border border-rule-strong px-4 py-2 font-mono text-[0.72rem] uppercase tracking-kicker text-cream transition-colors hover:border-accent hover:text-accent"
        >
          That&rsquo;s enough for now.
        </button>
        {/* Hidden on phones (no hardware keyboard); kept at sm+ — an iPad
            may have a keyboard attached. */}
        <button
          type="button"
          onClick={onShowHelp}
          className="px-4 py-2 font-mono text-[0.72rem] uppercase tracking-kicker text-cream-dim transition-colors hover:text-cream max-sm:hidden"
        >
          Keyboard
        </button>
      </div>
    </div>
  );
}
