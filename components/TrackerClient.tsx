"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TrackerConfig, TrackerItem } from "@/lib/craft-types";
import { useKeyboard } from "@/lib/useKeyboard";
import TrackerCard from "@/components/TrackerCard";
import Toast from "@/components/Toast";
import KeyboardHelp from "@/components/KeyboardHelp";

interface TrackerClientProps {
  items: TrackerItem[];
  config: TrackerConfig;
}

export default function TrackerClient({
  items: initialItems,
  config,
}: TrackerClientProps) {
  const router = useRouter();
  const [items, setItems] = useState<TrackerItem[]>(initialItems);
  const [activeStatus, setActiveStatus] = useState("all");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // ── Status tabs with counts ───────────────────────────────────
  const statusTabs = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const opt of config.statusOptions) {
      counts[opt] = items.filter((i) => i.status === opt).length;
    }
    return [
      { id: "all", label: "All", count: counts.all },
      ...config.statusOptions.map((opt) => ({
        id: opt,
        label: opt,
        count: counts[opt] ?? 0,
      })),
    ];
  }, [items, config.statusOptions]);

  // ── Filtered items ────────────────────────────────────────────
  const filteredItems = useMemo(() => {
    if (activeStatus === "all") return items;
    return items.filter((i) => i.status === activeStatus);
  }, [items, activeStatus]);

  // ── Optimistic update ─────────────────────────────────────────
  const handleUpdate = useCallback(
    async (
      itemId: string,
      updates: Partial<Pick<TrackerItem, "status" | "rating" | "ranking">>,
    ) => {
      // Snapshot for rollback
      const prev = items;
      setItems((cur) =>
        cur.map((i) => (i.id === itemId ? { ...i, ...updates } : i)),
      );

      try {
        const res = await fetch(
          `/api/trackers/${config.slug}/${itemId}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          },
        );
        if (!res.ok) throw new Error("Update failed");
      } catch {
        // Revert on failure
        setItems(prev);
        setError("Update failed — reverted");
      }
    },
    [items, config.slug],
  );

  // ── Keyboard navigation ───────────────────────────────────────
  const shortcuts = useMemo(
    () => ({
      j: () => setFocusedIndex((i) => Math.min(i + 1, filteredItems.length - 1)),
      k: () => setFocusedIndex((i) => Math.max(i - 1, 0)),
      "g h": () => router.push("/"),
      "g s": () => router.push("/saved"),
      "g r": () => router.push("/read"),
      "?": () => setShowHelp((v) => !v),
    }),
    [filteredItems.length, router],
  );

  useKeyboard(shortcuts, !showHelp);

  // Reset focused index when filter changes
  const handleStatusChange = useCallback((status: string) => {
    setActiveStatus(status);
    setFocusedIndex(0);
  }, []);

  return (
    <article className="mx-auto max-w-[720px] px-[max(1rem,env(safe-area-inset-left))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      {/* Status filter tabs */}
      <div className="sticky top-14 z-30 -mx-[max(1rem,env(safe-area-inset-left))] border-b border-rule/40 bg-ink/85 px-[max(1rem,env(safe-area-inset-left))] pt-3 pb-0 backdrop-blur-md">
        <div className="flex gap-4 overflow-x-auto scrollbar-none">
          {statusTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleStatusChange(tab.id)}
              className={[
                "whitespace-nowrap border-b-2 pb-2.5 font-mono text-[0.65rem] uppercase tracking-kicker transition-colors",
                activeStatus === tab.id
                  ? `border-current ${config.colorClass}`
                  : "border-transparent text-cream-dimmer hover:text-cream-dim",
              ].join(" ")}
            >
              {tab.label}
              <span className="ml-1.5 tabular-nums opacity-60">
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div
        ref={gridRef}
        className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-3"
      >
        {filteredItems.map((item, i) => (
          <TrackerCard
            key={item.id}
            item={item}
            config={config}
            focused={i === focusedIndex}
            onFocus={() => setFocusedIndex(i)}
            onUpdate={handleUpdate}
          />
        ))}
      </div>

      {filteredItems.length === 0 && (
        <p className="py-16 text-center font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Nothing here yet
        </p>
      )}

      {/* Error toast */}
      {error && (
        <Toast
          message={error}
          onDismiss={() => setError(null)}
          durationMs={3500}
        />
      )}

      {/* Keyboard help */}
      <KeyboardHelp open={showHelp} onClose={() => setShowHelp(false)} />
    </article>
  );
}
