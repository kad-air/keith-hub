"use client";

import { forwardRef } from "react";
import type {
  Item,
  BlueskyMetadata,
  BlueskyImage,
  BlueskyExternalCard,
  BlueskyQuotedPost,
} from "@/lib/types";

interface FeedCardProps {
  item: Item;
  index: number;
  focused: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onSave: () => void;
  onDismiss?: () => void;
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

  const bsky = isBluesky ? parseMeta<BlueskyMetadata>(item.metadata) : null;
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

      {/* Repost banner — when this post appears in the feed via someone reposting it */}
      {isBluesky && bsky?.reposted_by && (
        <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          <span>
            Reposted by{" "}
            {bsky.reposted_by.display_name || `@${bsky.reposted_by.handle}`}
          </span>
        </div>
      )}

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
          {isBluesky && bsky?.handle ? (
            <>
              {bsky.display_name && (
                <span className="text-cream">{bsky.display_name} </span>
              )}
              <span className="text-cream-dim">@{bsky.handle}</span>
            </>
          ) : (
            item.source_name
          )}
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
        <BlueskyBody item={item} bsky={bsky} />
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
        {onDismiss && (
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
        )}
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

// ─── Bluesky rich rendering ─────────────────────────────────────────────────

interface BlueskyBodyProps {
  item: Item;
  bsky: BlueskyMetadata | null;
}

function BlueskyBody({ item, bsky }: BlueskyBodyProps) {
  const text = item.body_excerpt || "";
  return (
    <>
      {bsky?.reply_to && <ReplyContext reply={bsky.reply_to} />}
      {text && (
        <p className="whitespace-pre-wrap break-words font-display text-[1rem] leading-[1.55] text-cream opsz-body">
          {text}
        </p>
      )}
      {bsky?.images && bsky.images.length > 0 && (
        <div className="mt-3">
          <ImageGrid images={bsky.images} />
        </div>
      )}
      {bsky?.external && (
        <div className="mt-3">
          <ExternalCard external={bsky.external} />
        </div>
      )}
      {bsky?.quoted && (
        <div className="mt-3">
          <QuotedPost post={bsky.quoted} />
        </div>
      )}
    </>
  );
}

function ReplyContext({ reply }: { reply: { handle: string; display_name?: string; text: string } }) {
  return (
    <div className="mb-2 flex gap-2 border-l-2 border-rule pl-3 text-cream-dim">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          ↳ replying to {reply.display_name || `@${reply.handle}`}
        </div>
        <div className="mt-0.5 line-clamp-2 font-display text-[0.85rem] italic leading-snug text-cream-dim opsz-body">
          {reply.text}
        </div>
      </div>
    </div>
  );
}

function ImageGrid({ images }: { images: BlueskyImage[] }) {
  // 1 image: full width, respect aspect ratio (capped)
  // 2 images: side-by-side
  // 3 images: first full-width, two below
  // 4+ images: 2x2 grid
  const count = images.length;

  if (count === 1) {
    const img = images[0];
    const ar = img.aspect_ratio;
    // Cap max height so portrait shots don't dominate the card
    const aspectStyle = ar
      ? { aspectRatio: `${ar.width} / ${ar.height}`, maxHeight: "32rem" }
      : { maxHeight: "32rem" };
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={img.fullsize}
        alt={img.alt}
        loading="lazy"
        style={aspectStyle}
        className="w-full rounded-sm object-cover ring-1 ring-rule"
      />
    );
  }

  if (count === 2) {
    return (
      <div className="grid grid-cols-2 gap-1.5">
        {images.slice(0, 2).map((img, i) => (
          <BlueskyImageThumb key={i} img={img} aspect="square" />
        ))}
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <div className="row-span-2">
          <BlueskyImageThumb img={images[0]} aspect="portrait" />
        </div>
        <BlueskyImageThumb img={images[1]} aspect="square" />
        <BlueskyImageThumb img={images[2]} aspect="square" />
      </div>
    );
  }

  // 4+
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {images.slice(0, 4).map((img, i) => (
        <BlueskyImageThumb key={i} img={img} aspect="square" />
      ))}
    </div>
  );
}

function BlueskyImageThumb({
  img,
  aspect,
}: {
  img: BlueskyImage;
  aspect: "square" | "portrait";
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={img.thumb}
      alt={img.alt}
      loading="lazy"
      className={[
        "h-full w-full rounded-sm object-cover ring-1 ring-rule",
        aspect === "square" ? "aspect-square" : "aspect-[3/4]",
      ].join(" ")}
    />
  );
}

function ExternalCard({ external }: { external: BlueskyExternalCard }) {
  return (
    <a
      href={external.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="flex overflow-hidden rounded-sm border border-rule bg-ink/60 transition-colors hover:border-rule-strong"
    >
      {external.thumb && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={external.thumb}
          alt=""
          loading="lazy"
          className="h-24 w-24 flex-shrink-0 object-cover sm:h-28 sm:w-28"
        />
      )}
      <div className="min-w-0 flex-1 px-3.5 py-2.5">
        <div className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          {external.domain}
        </div>
        <div className="mt-0.5 line-clamp-2 font-display text-[0.92rem] font-medium leading-snug text-cream opsz-body">
          {external.title}
        </div>
        {external.description && (
          <div className="mt-0.5 line-clamp-2 font-display text-[0.78rem] italic leading-snug text-cream-dim opsz-body">
            {external.description}
          </div>
        )}
      </div>
    </a>
  );
}

function QuotedPost({ post }: { post: BlueskyQuotedPost }) {
  return (
    <a
      href={post.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="block rounded-sm border border-rule bg-ink/60 px-3.5 py-3 transition-colors hover:border-rule-strong"
    >
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dim">
        {post.avatar_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.avatar_url}
            alt=""
            className="h-3.5 w-3.5 flex-shrink-0 rounded-full object-cover"
          />
        )}
        <span className="truncate">
          {post.display_name && (
            <span className="text-cream">{post.display_name} </span>
          )}
          <span className="text-cream-dim">@{post.handle}</span>
        </span>
      </div>
      {post.text && (
        <p className="whitespace-pre-wrap break-words font-display text-[0.92rem] leading-snug text-cream opsz-body line-clamp-6">
          {post.text}
        </p>
      )}
      {post.images && post.images.length > 0 && (
        <div className="mt-2.5">
          <ImageGrid images={post.images} />
        </div>
      )}
      {post.external && (
        <div className="mt-2.5 flex items-center gap-2 text-cream-dim">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span className="truncate font-mono text-[0.6rem] uppercase tracking-kicker">
            {post.external.domain}
          </span>
        </div>
      )}
    </a>
  );
}

export default FeedCard;
