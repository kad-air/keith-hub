"use client";

import { forwardRef } from "react";
import type { Item } from "@/lib/types";

interface FeedCardProps {
  item: Item;
  index: number;
  focused: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onSave: () => void;
  onDismiss: () => void;
}

const CATEGORY_LABEL: Record<string, { label: string; klass: string }> = {
  music: { label: "Music", klass: "text-cat-music" },
  film: { label: "Film", klass: "text-cat-film" },
  reading: { label: "Reading", klass: "text-cat-reading" },
  podcasts: { label: "Podcast", klass: "text-cat-podcasts" },
  bluesky: { label: "Bluesky", klass: "text-cat-bluesky" },
};

function relativeDate(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays === 1) return "1d";
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatDuration(raw: string): string {
  const parts = raw.split(":").map(Number);
  if (parts.length === 3) {
    const [h, m] = parts;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  if (parts.length === 2) return `${parts[0]}m`;
  const secs = Number(raw);
  if (!isNaN(secs)) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  return raw;
}

interface BlueskyMeta {
  handle?: string;
  avatar_url?: string;
  like_count?: number;
  reply_count?: number;
  repost_count?: number;
}

interface PodcastMeta {
  show_name?: string;
  duration?: string;
  audio_url?: string;
  artwork_url?: string;
  apple_id?: string;
}

function parseMeta<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const FeedCard = forwardRef<HTMLElement, FeedCardProps>(function FeedCard(
  { item, index, focused, onFocus, onOpen, onSave, onDismiss },
  ref
) {
  const category = item.source_category || "reading";
  const cat = CATEGORY_LABEL[category] || CATEGORY_LABEL.reading;
  const isBluesky = category === "bluesky";
  const isPodcast = category === "podcasts";
  const saved = !!item.saved_at;

  const bsky = isBluesky ? parseMeta<BlueskyMeta>(item.metadata) : null;
  const podcast = isPodcast ? parseMeta<PodcastMeta>(item.metadata) : null;

  // Limit stagger to first 8 cards so the page never feels slow
  const animDelay =
    index < 8 ? `${30 + index * 35}ms` : undefined;

  return (
    <article
      ref={ref}
      data-feed-index={index}
      onClick={onOpen}
      onMouseEnter={onFocus}
      onTouchStart={onFocus}
      className={[
        "group relative cursor-pointer scroll-mt-24 px-6 py-5 transition-colors duration-200 animate-fade-in-up",
        // Reserve right-side space for the always-visible action buttons on touch
        "[@media(hover:none)]:pr-28",
        "border-b border-rule/70",
        focused ? "bg-ink-hover" : "hover:bg-ink-raised/60",
      ].join(" ")}
      style={animDelay ? { animationDelay: animDelay } : undefined}
    >
      {/* Left edge accent rule — focus state */}
      <span
        aria-hidden
        className={[
          "pointer-events-none absolute left-0 top-0 h-full transition-all duration-200",
          focused
            ? "w-[3px] bg-accent"
            : "w-[2px] bg-transparent group-hover:bg-cream-dimmer/50",
        ].join(" ")}
      />

      {/* Kicker line: source · category · time */}
      <div className="mb-2.5 flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim">
        {isBluesky && bsky?.avatar_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bsky.avatar_url}
            alt=""
            className="h-4 w-4 flex-shrink-0 rounded-full object-cover"
          />
        )}
        <span className="truncate">
          {isBluesky && bsky?.handle ? `@${bsky.handle}` : item.source_name}
        </span>
        <span className="text-cream-dimmer">·</span>
        <span className={cat.klass}>{cat.label}</span>
        <span className="text-cream-dimmer">·</span>
        <span suppressHydrationWarning className="text-cream-dimmer tabular-nums">
          {relativeDate(item.published_at)}
        </span>
        {saved && (
          <>
            <span className="text-cream-dimmer">·</span>
            <span className="flex items-center gap-1 text-accent">
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
              >
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              Saved
            </span>
          </>
        )}
      </div>

      {/* Body — three layouts */}
      {isPodcast ? (
        <div className="flex gap-4">
          {(podcast?.artwork_url || item.image_url) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={podcast?.artwork_url || item.image_url || ""}
              alt=""
              className="h-20 w-20 flex-shrink-0 rounded-sm object-cover ring-1 ring-rule"
            />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[1.05rem] font-medium leading-snug text-cream opsz-body">
              {item.title}
            </h2>
            <p className="mt-1.5 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
              {podcast?.show_name}
              {podcast?.duration && (
                <>
                  <span className="text-cream-dimmer"> · </span>
                  {formatDuration(podcast.duration)}
                </>
              )}
            </p>
          </div>
        </div>
      ) : isBluesky ? (
        <p className="whitespace-pre-wrap break-words font-display text-[1rem] leading-[1.55] text-cream opsz-body">
          {item.body_excerpt}
        </p>
      ) : (
        <>
          <h2 className="font-display text-[1.4rem] font-medium leading-[1.2] tracking-[-0.012em] text-cream opsz-display">
            {item.title}
          </h2>
          {item.body_excerpt && (
            <p className="mt-2 line-clamp-2 font-display text-[0.95rem] italic leading-[1.5] text-cream-dim opsz-body">
              {item.body_excerpt}
            </p>
          )}
        </>
      )}

      {/* Bluesky engagement counts */}
      {isBluesky && bsky && (!!bsky.reply_count || !!bsky.like_count) && (
        <div className="mt-2.5 flex items-center gap-4 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          {!!bsky.reply_count && <span>{bsky.reply_count} replies</span>}
          {!!bsky.like_count && <span>{bsky.like_count} likes</span>}
        </div>
      )}

      {/* Action row — visible on hover or focus on desktop, always visible on touch devices */}
      <div
        className={[
          "absolute right-5 top-5 flex items-center gap-1 transition-opacity duration-150",
          focused
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <ActionButton
          label={saved ? "Unsave (s)" : "Save (s)"}
          active={saved}
          onClick={onSave}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill={saved ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </ActionButton>
        <ActionButton label="Dismiss (x)" onClick={onDismiss}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </ActionButton>
      </div>
    </article>
  );
});

interface ActionButtonProps {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function ActionButton({ label, active, onClick, children }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className={[
        "flex h-7 w-7 items-center justify-center rounded-sm border transition-colors",
        // Larger hit zone + fully opaque background on touch devices
        "[@media(hover:none)]:h-11 [@media(hover:none)]:w-11 [@media(hover:none)]:bg-ink",
        active
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-rule bg-ink/60 text-cream-dim hover:border-rule-strong hover:bg-ink hover:text-cream",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export default FeedCard;
