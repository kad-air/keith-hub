"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { TrackerConfig, TrackerItem } from "@/lib/craft-types";

interface TrackerCardProps {
  item: TrackerItem;
  config: TrackerConfig;
  index: number;
  focused: boolean;
  onFocus: (index: number) => void;
  onUpdate: (
    itemId: string,
    updates: Partial<Pick<TrackerItem, "status" | "rating" | "ranking">>,
  ) => void;
}

export default memo(function TrackerCard({
  item,
  config,
  index,
  focused,
  onFocus,
  onUpdate,
}: TrackerCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rankingDraft, setRankingDraft] = useState(
    item.ranking?.toString() ?? "",
  );

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const handleStatusChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onUpdate(item.id, { status: e.target.value });
    },
    [item.id, onUpdate],
  );

  const handleRatingChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      onUpdate(item.id, { rating: value });
    },
    [item.id, onUpdate],
  );

  const handleRankingCommit = useCallback(() => {
    const value = rankingDraft.trim();
    const num = value === "" ? undefined : parseInt(value, 10);
    if (num !== item.ranking) {
      onUpdate(item.id, {
        ranking: isNaN(num as number) ? undefined : num,
      });
    }
  }, [item.id, item.ranking, rankingDraft, onUpdate]);

  const handleRankingKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        (e.target as HTMLInputElement).blur();
      }
    },
    [],
  );

  // Open external link if available
  // Format release date for display
  const formattedDate = (() => {
    if (!item.releaseDate) return null;
    // publication_year is just a 4-digit string like "2026"
    if (/^\d{4}$/.test(item.releaseDate)) return item.releaseDate;
    // ISO date string from Craft
    const d = new Date(item.releaseDate);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  })();

  const handleClick = useCallback(() => {
    if (item.linkUrl) {
      window.open(item.linkUrl, "_blank", "noopener");
    }
  }, [item.linkUrl]);

  return (
    <div
      ref={cardRef}
      onClick={handleClick}
      onMouseEnter={() => onFocus(index)}
      className={[
        "group relative flex flex-col overflow-hidden border border-rule/40 bg-ink-raised transition-colors",
        "hover:border-rule-strong",
        item.linkUrl ? "cursor-pointer" : "",
        focused ? "ring-1 ring-accent" : "",
      ].join(" ")}
    >
      {/* Cover image */}
      <div
        className={[
          config.aspectClass,
          "relative w-full overflow-hidden bg-ink",
        ].join(" ")}
      >
        {item.imageUrl && visible ? (
          <img
            src={item.imageUrl}
            alt={item.name}
            className="h-full w-full object-cover"
          />
        ) : item.imageUrl ? (
          /* Placeholder while waiting for intersection */
          <div className="h-full w-full bg-ink" />
        ) : (
          <div
            className={[
              "flex h-full w-full items-center justify-center p-3",
              config.colorClass,
              "bg-ink-hover",
            ].join(" ")}
          >
            <span className="text-center font-display text-sm italic leading-tight opacity-60">
              {item.name}
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col gap-1 px-2.5 pt-2 pb-2">
        <h3 className="font-display text-[0.95rem] font-medium italic leading-tight text-cream line-clamp-2">
          {item.name}
        </h3>
        {item.subtitle && (
          <p className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dim line-clamp-1">
            {item.subtitle}
          </p>
        )}
        {formattedDate && (
          <p className="font-mono text-[0.55rem] uppercase tracking-kicker text-cream-dimmer">
            {formattedDate}
          </p>
        )}

        {/* Inline edit row */}
        <div
          className="mt-auto flex items-center gap-1.5 pt-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Status */}
          <select
            value={item.status}
            onChange={handleStatusChange}
            className="min-w-0 flex-1 appearance-none truncate border border-rule bg-ink px-1.5 py-1 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-rule-strong focus:border-accent focus:text-cream focus:outline-none"
          >
            <option value="">—</option>
            {config.statusOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>

          {/* Rating */}
          <select
            value={item.rating}
            onChange={handleRatingChange}
            className="w-10 appearance-none border border-rule bg-ink px-1 py-1 text-center text-[0.75rem] transition-colors hover:border-rule-strong focus:border-accent focus:outline-none"
          >
            <option value="">—</option>
            {config.ratingOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>

          {/* Ranking */}
          <input
            type="number"
            min={1}
            step={1}
            value={rankingDraft}
            onChange={(e) => setRankingDraft(e.target.value)}
            onBlur={handleRankingCommit}
            onKeyDown={handleRankingKeyDown}
            placeholder="#"
            className="w-9 appearance-none border border-rule bg-ink px-1 py-1 text-center font-mono text-[0.65rem] tabular-nums text-cream-dim transition-colors hover:border-rule-strong focus:border-accent focus:text-cream focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
});
