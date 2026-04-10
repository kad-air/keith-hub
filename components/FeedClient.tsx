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

const CATEGORIES: Array<{ id: keyof CategoryCounts; label: string }> = [
  { id: "all", label: "All" },
  { id: "podcasts", label: "Podcasts" },
  { id: "music", label: "Music" },
  { id: "film", label: "Film" },
  { id: "reading", label: "Reading" },
  { id: "bluesky", label: "Bluesky" },
];

interface PendingDismiss {
  ids: string[];
  items: Item[]; // for restoring
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
  const cardRefs = useRef<Array<HTMLElement | null>>([]);

  // ─── Data fetching ────────────────────────────────────────
  const fetchItems = useCallback(
    async (category: keyof CategoryCounts) => {
      setSwapping(true);
      try {
        const params = new URLSearchParams({ limit: "50", offset: "0" });
        if (category !== "all") params.set("category", category);
        const res = await fetch(`/api/items?${params}`, { cache: "no-store" });
        if (!res.ok) throw new Error("fetch failed");
        const data = (await res.json()) as ItemsResponse;
        setItems(data.items);
        setCounts(data.counts);
        setFocusedIndex(0);
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
  }, [activeCategory, fetchItems, refreshing]);

  // ─── Item actions ─────────────────────────────────────────
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
        await fetch(`/api/items/${item.id}/read`, { method: "POST" });
      } catch {
        // best effort
      }
    },
    [removeFromList, decrementCount]
  );

  const handleSave = useCallback(
    async (item: Item) => {
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
    [removeFromList, decrementCount]
  );

  const handleDismiss = useCallback(
    async (item: Item) => {
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
    [removeFromList, decrementCount]
  );

  const handleDismissAll = useCallback(async () => {
    if (items.length === 0) return;
    const snapshot = items;
    const ids = snapshot.map((it) => it.id);
    setItems([]);
    setCounts((prev) => {
      // Recalculate from snapshot
      const next = { ...prev };
      for (const it of snapshot) {
        next.all = Math.max(0, next.all - 1);
        const cat = it.source_category as keyof CategoryCounts | undefined;
        if (cat && cat in next && cat !== "all") {
          next[cat] = Math.max(0, next[cat] - 1);
        }
      }
      return next;
    });
    setPending({
      ids,
      items: snapshot,
      message: `Dismissed ${snapshot.length} item${snapshot.length === 1 ? "" : "s"}`,
    });
    try {
      await fetch("/api/items/read-bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    } catch {
      // best effort
    }
  }, [items]);

  const handleUndo = useCallback(async () => {
    if (!pending) return;
    const { ids, items: restored } = pending;
    setItems((prev) => {
      // Re-merge restored items, dedup, then re-sort by published desc
      // (good enough — close to original rank order)
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
    setPending(null);
    try {
      if (ids.length === 1) {
        await fetch(`/api/items/${ids[0]}/unread`, { method: "POST" });
      } else {
        await fetch("/api/items/read-bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, unread: true }),
        });
      }
    } catch (err) {
      console.error("[FeedClient] Undo error:", err);
    }
  }, [pending]);

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
      j: () => setFocusedIndex((i) => Math.min(items.length - 1, i + 1)),
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

  // ─── Derived ──────────────────────────────────────────────
  const grouped = useMemo(() => groupByDate(items), [items]);

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
                <span
                  className={[
                    "tabular-nums text-[0.65rem]",
                    isActive ? "text-accent" : "text-cream-dimmer",
                  ].join(" ")}
                >
                  {count}
                </span>
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
            <section key={group.bucket}>
              <DateDivider label={group.bucket} />
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
                    onFocus={() => setFocusedIndex(myIndex)}
                    onOpen={() => void handleOpen(item)}
                    onSave={() => void handleSave(item)}
                    onDismiss={() => void handleDismiss(item)}
                  />
                );
              })}
            </section>
          ))}

          {items.length > 0 && (
            <FooterActions
              count={items.length}
              onDismissAll={handleDismissAll}
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
  onDismissAll: () => void;
  onShowHelp: () => void;
}

function FooterActions({ count, onDismissAll, onShowHelp }: FooterActionsProps) {
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
          onClick={onDismissAll}
          className="border border-rule-strong px-4 py-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cream transition-colors hover:border-accent hover:text-accent"
        >
          Dismiss all
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
