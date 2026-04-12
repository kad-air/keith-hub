"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

const CATEGORIES: Array<{ id: keyof CategoryCounts; label: string }> = [
  { id: "all", label: "All" },
  { id: "podcasts", label: "Podcasts" },
  { id: "music", label: "Music" },
  { id: "books", label: "Books" },
  { id: "film", label: "Film" },
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

export default function FeedClient({
  initialItems,
  initialCounts,
}: FeedClientProps) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>(initialItems);
  const [counts, setCounts] = useState<CategoryCounts>(initialCounts);
  const [activeCategory, setActiveCategory] =
    useState<keyof CategoryCounts>("all");
  const [swapping, setSwapping] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [pending, setPending] = useState<PendingDismiss | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [renderedCount, setRenderedCount] = useState(INITIAL_CHUNK);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
      // Use cached data if fresh (< 30s old)
      const cached = categoryCache.current.get(category);
      if (cached && Date.now() - cached.ts < 30_000) {
        setItems(cached.items);
        setCounts(cached.counts);
        setFocusedIndex(0);
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
    },
    [activeCategory, fetchItems]
  );

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    invalidateCache();
    setRefreshing(true);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.ok) throw new Error("refresh failed");
      const data = (await res.json()) as { fetched: number };
      setRefreshMessage(
        data.fetched > 0
          ? `${data.fetched} new item${data.fetched === 1 ? "" : "s"}`
          : "Up to date"
      );
      await fetchItems(activeCategory);
    } catch {
      setRefreshMessage("Refresh failed");
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMessage(null), 3500);
    }
  }, [activeCategory, fetchItems, refreshing, invalidateCache]);

  // ─── Silent auto-refresh on PWA resume ────────────────────
  const lastRefreshRef = useRef(0);
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshRef.current < 60_000) return;
      lastRefreshRef.current = Date.now();
      fetch("/api/refresh", { method: "POST" })
        .then(() => fetchItems(activeCategory))
        .catch(() => {});
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [activeCategory, fetchItems]);

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

  // Bulk dismiss: marks every unread item in scope as read — not just the
  // visible 300, but every unread item in the current category (or globally
  // on the All view). The server returns the affected IDs so undo can clear
  // read_at on exactly those rows.
  //
  // Important: this is a DISMISS, not a "I read these" action. It only sets
  // item_state.read_at, never consumed_at, so bulk-dismissed items do NOT
  // appear in the /read history view (which queries on consumed_at). Same
  // semantic as the per-card dismiss button.
  const handleMarkAllRead = useCallback(async () => {
    invalidateCache();
    // Snapshot the counts before we mutate so we know what to roll back on
    // undo (and to format the toast message).
    const totalBefore =
      activeCategory === "all" ? counts.all : counts[activeCategory];
    if (totalBefore === 0) return;

    // Optimistic UI: empty the visible list and zero the relevant count(s).
    setItems([]);
    setCounts((prev) => {
      if (activeCategory === "all") {
        return { all: 0, reading: 0, books: 0, music: 0, film: 0, podcasts: 0, bluesky: 0 };
      }
      return { ...prev, [activeCategory]: 0, all: Math.max(0, prev.all - totalBefore) };
    });

    let serverIds: string[] = [];
    try {
      const res = await fetch("/api/items/read-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category: activeCategory === "all" ? undefined : activeCategory,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { ids: string[] };
        serverIds = data.ids;
      }
    } catch {
      // best effort — counts/items will reconcile on the next refresh
    }

    setPending({
      ids: serverIds,
      // Empty items[] tells handleUndo to refetch instead of restoring in
      // place — see the PendingDismiss comment above.
      items: [],
      message: `Dismissed ${totalBefore} item${totalBefore === 1 ? "" : "s"}`,
    });
  }, [activeCategory, counts, invalidateCache]);

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

  // Scroll focused card into view when keyboard nav changes the index
  useEffect(() => {
    const el = cardRefs.current[focusedIndex];
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedIndex]);

  // ─── Keyboard shortcuts ──────────────────────────────────
  useKeyboard(
    {
      j: () => {
        setFocusedIndex((i) => {
          const next = Math.min(items.length - 1, i + 1);
          if (next >= renderedCount) {
            setRenderedCount((prev) => Math.min(prev + CHUNK_SIZE, items.length));
          }
          return next;
        });
      },
      k: () => setFocusedIndex((i) => Math.max(0, i - 1)),
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
      r: () => void handleRefresh(),
      "g h": () => router.push("/"),
      "g s": () => router.push("/saved"),
      "g r": () => router.push("/read"),
      "?": () => setHelpOpen((v) => !v),
    },
    !helpOpen
  );

  // ─── Pull to refresh (touch only) ────────────────────────
  useEffect(() => {
    let startY: number | null = null;
    let pulling = false;

    function onTouchStart(e: TouchEvent) {
      if (window.scrollY > 0) return;
      startY = e.touches[0].clientY;
      pulling = true;
    }
    function onTouchMove(e: TouchEvent) {
      if (!pulling || startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy < 0) {
        pulling = false;
      }
    }
    function onTouchEnd(e: TouchEvent) {
      if (!pulling || startY === null) return;
      const dy = e.changedTouches[0].clientY - startY;
      if (dy > 90) {
        void handleRefresh();
      }
      pulling = false;
      startY = null;
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [handleRefresh]);

  // ─── Chunked rendering ───────────────────────────────────
  // Reset chunk count when the item list changes (category switch, refresh)
  useEffect(() => {
    setRenderedCount(INITIAL_CHUNK);
  }, [items]);

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
      {/* ── Controls row ── */}
      <div className="mb-5 flex items-center justify-between gap-4 px-4">
        <nav className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          {CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.id;
            const count = counts[cat.id];
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleCategoryChange(cat.id)}
                className={[
                  "group flex items-baseline gap-1.5 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
                  // Vertical hit zone bump on touch devices, no visual change
                  "[@media(hover:none)]:py-2 [@media(hover:none)]:-my-1",
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
                      "tabular-nums text-[0.65rem]",
                      isActive ? "text-accent" : "text-cream-dimmer",
                    ].join(" ")}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          {refreshMessage && (
            <span className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim animate-fade-in">
              {refreshMessage}
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh (r)"
            aria-label="Refresh feeds"
            className="flex h-8 w-8 items-center justify-center rounded-sm border border-rule text-cream-dim transition-colors hover:border-rule-strong hover:text-cream disabled:opacity-50 [@media(hover:none)]:h-11 [@media(hover:none)]:w-11"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? "animate-spin" : ""}
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </div>

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
      {pending && (
        <Toast
          message={pending.message}
          actionLabel="Undo"
          onAction={handleUndo}
          onDismiss={() => setPending(null)}
        />
      )}

      {/* ── Help overlay ── */}
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────

function DateDivider({ label }: { label: string }) {
  return (
    <div className="mb-1 mt-7 flex items-center gap-3 px-6 first:mt-0">
      <span className="font-mono text-[0.65rem] uppercase tracking-kicker text-cat-film">
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
        <span className="font-mono text-[0.6rem] uppercase tracking-kicker">
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
          className="border border-rule-strong px-4 py-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cream transition-colors hover:border-accent hover:text-accent"
        >
          That&rsquo;s enough for now.
        </button>
        <button
          type="button"
          onClick={onShowHelp}
          className="px-4 py-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim transition-colors hover:text-cream"
        >
          Keyboard
        </button>
      </div>
    </div>
  );
}
