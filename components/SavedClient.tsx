"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Item } from "@/lib/types";
import FeedCard from "@/components/FeedCard";
import KeyboardHelp from "@/components/KeyboardHelp";
import { useKeyboard } from "@/lib/useKeyboard";

interface SavedClientProps {
  initialItems: Item[];
}

export default function SavedClient({ initialItems }: SavedClientProps) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>(initialItems);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);

  const removeFromList = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

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
      const url = podcastMeta?.apple_id
        ? `https://podcasts.apple.com/podcast/id${podcastMeta.apple_id}`
        : item.url;
      window.open(url, "_blank", "noopener,noreferrer");
      // Opening from /saved does NOT remove the item — saved is its own pile
    },
    []
  );

  // Toggling save off (unsave) from /saved removes the item from this list.
  const handleUnsave = useCallback(
    async (item: Item) => {
      removeFromList(item.id);
      try {
        await fetch(`/api/items/${item.id}/save`, { method: "POST" });
      } catch (err) {
        console.error("[SavedClient] Save toggle error:", err);
      }
    },
    [removeFromList]
  );

  // On the saved page, "dismiss" means "remove from saved" — i.e. unsave.
  // It does NOT call /read (that would affect the main feed in unexpected ways).
  const handleDismiss = handleUnsave;

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
        if (it) void handleUnsave(it);
      },
      x: () => {
        const it = items[focusedIndex];
        if (it) void handleDismiss(it);
      },
      e: () => {
        const it = items[focusedIndex];
        if (it) void handleDismiss(it);
      },
      "g h": () => router.push("/"),
      "g s": () => router.push("/saved"),
      "?": () => setHelpOpen((v) => !v),
    },
    !helpOpen
  );

  return (
    <div className="mx-auto max-w-[720px] px-2 pb-32 pt-6">
      <div className="mb-5 flex items-baseline justify-between px-6">
        <h1 className="font-display text-[1.6rem] font-medium italic text-cream opsz-display">
          Saved
        </h1>
        <span className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim tabular-nums">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="px-6 py-24 text-center">
          <h2 className="font-display text-[1.6rem] font-medium italic text-cream opsz-display">
            Nothing saved yet.
          </h2>
          <p className="mt-3 font-display text-[0.95rem] italic text-cream-dim">
            Press <kbd className="font-mono text-[0.7rem] uppercase">s</kbd> on
            any item to save it here.
          </p>
        </div>
      ) : (
        <div>
          {items.map((item, idx) => (
            <FeedCard
              key={item.id}
              item={item}
              index={idx}
              focused={idx === focusedIndex}
              ref={(el) => {
                cardRefs.current[idx] = el;
              }}
              onFocus={() => setFocusedIndex(idx)}
              onOpen={() => void handleOpen(item)}
              onSave={() => void handleUnsave(item)}
              onDismiss={() => void handleDismiss(item)}
            />
          ))}
        </div>
      )}

      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
