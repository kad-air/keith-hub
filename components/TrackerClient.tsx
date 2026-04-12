"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TrackerConfig, TrackerItem } from "@/lib/craft-types";
import { useKeyboard } from "@/lib/useKeyboard";
import TrackerCard from "@/components/TrackerCard";
import Toast from "@/components/Toast";
import KeyboardHelp from "@/components/KeyboardHelp";

// ── Sort helpers ────────────────────────────────────────────────
type SortKey = "release-desc" | "release-asc" | "title" | "rating";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "release-desc", label: "Newest" },
  { key: "release-asc", label: "Oldest" },
  { key: "title", label: "Title" },
  { key: "rating", label: "Rating" },
];

const RATING_ORDER: Record<string, number> = {
  "\uD83D\uDE0D": 0, // 😍
  "\uD83D\uDC4D": 1, // 👍
  "\uD83D\uDE11": 2, // 😑
  "\uD83D\uDC4E": 3, // 👎
};

function parseReleaseDate(d: string | null): number | null {
  if (!d) return null;
  if (/^\d{4}$/.test(d)) return parseInt(d, 10);
  const ts = new Date(d).getTime();
  return isNaN(ts) ? null : ts;
}

function sortItems(items: TrackerItem[], sort: SortKey): TrackerItem[] {
  return [...items].sort((a, b) => {
    switch (sort) {
      case "release-desc":
      case "release-asc": {
        const da = parseReleaseDate(a.releaseDate);
        const db = parseReleaseDate(b.releaseDate);
        if (da === null && db === null) return 0;
        if (da === null) return 1;
        if (db === null) return -1;
        return sort === "release-desc" ? db - da : da - db;
      }
      case "title":
        return a.name.localeCompare(b.name);
      case "rating": {
        const ra = RATING_ORDER[a.rating] ?? 4;
        const rb = RATING_ORDER[b.rating] ?? 4;
        return ra - rb;
      }
      default:
        return 0;
    }
  });
}

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
  const [activeSort, setActiveSort] = useState<SortKey>("release-desc");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const TRACKER_CHUNK = 30;
  const [renderedCount, setRenderedCount] = useState(TRACKER_CHUNK);
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

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

  // ── Filtered + sorted items ───────────────────────────────────
  const filteredItems = useMemo(() => {
    const filtered =
      activeStatus === "all"
        ? items
        : items.filter((i) => i.status === activeStatus);
    return sortItems(filtered, activeSort);
  }, [items, activeStatus, activeSort]);

  // ── Chunked rendering ─────────────────────────────────────────
  useEffect(() => {
    setRenderedCount(TRACKER_CHUNK);
  }, [filteredItems]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRenderedCount((prev) => Math.min(prev + TRACKER_CHUNK, filteredItems.length));
        }
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [filteredItems.length]);

  const visibleItems = useMemo(
    () => filteredItems.slice(0, renderedCount),
    [filteredItems, renderedCount],
  );

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
      j: () => {
        setFocusedIndex((i) => {
          const next = Math.min(i + 1, filteredItems.length - 1);
          if (next >= renderedCount) {
            setRenderedCount((prev) => Math.min(prev + TRACKER_CHUNK, filteredItems.length));
          }
          return next;
        });
      },
      k: () => setFocusedIndex((i) => Math.max(i - 1, 0)),
      "g h": () => router.push("/"),
      "g s": () => router.push("/saved"),
      "g r": () => router.push("/read"),
      "?": () => setShowHelp((v) => !v),
    }),
    [filteredItems.length, renderedCount, router],
  );

  useKeyboard(shortcuts, !showHelp);

  // Reset focused index when filter changes
  const handleStatusChange = useCallback((status: string) => {
    setActiveStatus(status);
    setFocusedIndex(0);
  }, []);

  return (
    <article className="mx-auto max-w-[720px] px-[max(1rem,env(safe-area-inset-left))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      {/* Status filter tabs + sort control */}
      <div className="sticky top-14 z-30 -mx-[max(1rem,env(safe-area-inset-left))] border-b border-rule/40 bg-ink/85 px-[max(1rem,env(safe-area-inset-left))] pt-3 pb-0 backdrop-blur-md">
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 gap-4 overflow-x-auto scrollbar-none">
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

          {/* Sort dropdown */}
          <select
            value={activeSort}
            onChange={(e) => {
              setActiveSort(e.target.value as SortKey);
              setFocusedIndex(0);
            }}
            className="mb-1.5 shrink-0 appearance-none border border-rule/60 bg-ink px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-rule-strong focus:border-accent focus:text-cream focus:outline-none"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Grid */}
      <div
        ref={gridRef}
        className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-3"
      >
        {visibleItems.map((item, i) => (
          <TrackerCard
            key={item.id}
            item={item}
            config={config}
            index={i}
            focused={i === focusedIndex}
            onFocus={setFocusedIndex}
            onUpdate={handleUpdate}
          />
        ))}
      </div>

      {/* Sentinel for progressive chunk loading */}
      {renderedCount < filteredItems.length && (
        <div ref={sentinelRef} className="h-px" />
      )}

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
