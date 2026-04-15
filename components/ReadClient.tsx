"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Item } from "@/lib/types";
import FeedCard from "@/components/FeedCard";
import KeyboardHelp from "@/components/KeyboardHelp";
import Toast from "@/components/Toast";
import { useKeyboard } from "@/lib/useKeyboard";

interface ReadClientProps {
  initialItems: Item[];
}

// /read is the history view: items the user has actually opened (consumed_at
// is set, distinct from items that were just dismissed). It's append-only
// from the user's perspective — opening an item from here re-opens the URL
// in Safari and bumps it to the top, but doesn't remove it. Save toggles
// behave the same as elsewhere. There's no dismiss-from-read action; this
// view is the safety net for "I clicked a link and now I want it back."
export default function ReadClient({ initialItems }: ReadClientProps) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>(initialItems);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [bskyError, setBskyError] = useState<string | null>(null);
  const READ_CHUNK = 40;
  const [renderedCount, setRenderedCount] = useState(READ_CHUNK);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleOpen = useCallback(async (item: Item) => {
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
    const url = podcastMeta?.apple_id
      ? `https://podcasts.apple.com/podcast/id${podcastMeta.apple_id}`
      : item.url;
    // Anchor click — see comment in FeedClient.handleOpen for the iOS PWA reason.
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Bump consumed_at so re-opening moves the item to the top of /read.
    try {
      await fetch(`/api/items/${item.id}/open`, { method: "POST" });
    } catch {
      // best effort
    }
  }, []);

  const handleSave = useCallback(async (item: Item) => {
    const wasSaved = !!item.saved_at;
    setItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? { ...it, saved_at: wasSaved ? null : new Date().toISOString() }
          : it
      )
    );
    try {
      await fetch(`/api/items/${item.id}/save`, { method: "POST" });
    } catch (err) {
      console.error("[ReadClient] Save error:", err);
    }
  }, []);

  // No dismiss action on /read — this is the history view, not a triage queue.
  // FeedCard hides the dismiss button when onDismiss is omitted.

  const postBskyAction = useCallback(
    async (item: Item, path: string, errorMessage: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/items/${item.id}/${path}`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`${path} ${res.status}`);
        return true;
      } catch (err) {
        console.error(`[ReadClient] bsky ${path} error:`, err);
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

  // Keep focusedIndex in bounds
  useEffect(() => {
    if (focusedIndex >= items.length && items.length > 0) {
      setFocusedIndex(items.length - 1);
    }
  }, [items.length, focusedIndex]);

  useEffect(() => {
    const el = cardRefs.current[focusedIndex];
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedIndex]);

  // ── Chunked rendering ─────────────────────────────────────
  useEffect(() => {
    setRenderedCount(READ_CHUNK);
  }, [items]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRenderedCount((prev) => Math.min(prev + READ_CHUNK, items.length));
        }
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [items.length]);

  const visibleItems = useMemo(
    () => items.slice(0, renderedCount),
    [items, renderedCount],
  );

  useKeyboard(
    {
      j: () => {
        setFocusedIndex((i) => {
          const next = Math.min(items.length - 1, i + 1);
          if (next >= renderedCount) {
            setRenderedCount((prev) => Math.min(prev + READ_CHUNK, items.length));
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
      "g h": () => router.push("/"),
      "g s": () => router.push("/saved"),
      "g r": () => router.push("/read"),
      "?": () => setHelpOpen((v) => !v),
    },
    !helpOpen
  );

  return (
    <div className="mx-auto max-w-[720px] px-2 pb-32 pt-6">
      <div className="mb-5 flex items-baseline justify-between px-6">
        <h1 className="font-display text-[1.6rem] font-medium italic text-cream opsz-display">
          Read
        </h1>
        <span className="font-mono text-[0.72rem] uppercase tracking-kicker text-cream-dim tabular-nums">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="px-6 py-24 text-center">
          <h2 className="font-display text-[1.6rem] font-medium italic text-cream opsz-display">
            No history yet.
          </h2>
          <p className="mt-3 font-display text-[0.95rem] italic text-cream-dim">
            Items you open from the feed will land here so you can find them
            again.
          </p>
        </div>
      ) : (
        <div>
          {visibleItems.map((item, idx) => (
            <FeedCard
              key={item.id}
              item={item}
              index={idx}
              focused={idx === focusedIndex}
              ref={(el) => {
                cardRefs.current[idx] = el;
              }}
              onFocus={setFocusedIndex}
              onOpen={handleOpen}
              onSave={handleSave}
              onBskyLike={handleBskyLike}
              onBskyRepost={handleBskyRepost}
              onBskyFollow={handleBskyFollow}
            />
          ))}
          {renderedCount < items.length && (
            <div ref={sentinelRef} className="h-px" />
          )}
        </div>
      )}

      {bskyError && (
        <Toast
          message={bskyError}
          onDismiss={() => setBskyError(null)}
          durationMs={4000}
        />
      )}

      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
