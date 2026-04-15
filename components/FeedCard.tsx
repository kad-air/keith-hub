"use client";

import { forwardRef, memo, useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import type {
  Item,
  BlueskyMetadata,
  BlueskyImage,
  BlueskyExternalCard,
  BlueskyQuotedPost,
} from "@/lib/types";

// Swipe-to-action constants. The article (the inner element) follows the
// finger horizontally; if released past COMMIT_THRESHOLD it animates off
// screen and fires the corresponding action. DETECT_THRESHOLD is the dead
// zone before we lock the gesture as horizontal — anything smaller stays
// available as a vertical scroll. The COMMIT_ANIM_MS matches the CSS
// transition duration so the timeout fires when the slide-off finishes.
const SWIPE_DETECT_THRESHOLD = 6;
const SWIPE_COMMIT_THRESHOLD = 80;
const COMMIT_ANIM_MS = 200;
// Long-press (touch-only) fires Clear-Above. Held this long without
// enough motion to lock the swipe gesture = treat as long-press.
const LONG_PRESS_MS = 1000;

interface FeedCardProps {
  item: Item;
  index: number;
  focused: boolean;
  onFocus: (index: number) => void;
  onOpen: (item: Item) => void;
  onSave: (item: Item) => void;
  onDismiss?: (item: Item) => void;
  // "Clear above" — dismiss this item plus every card above it in one go.
  // Desktop: third hover button. Mobile: long-press the card.
  onClearAbove?: (item: Item) => void;
  // Bluesky write actions. Each returns a promise that resolves true on
  // success and false if the server call failed — FeedCard owns the
  // optimistic UI update and reverts when these return false. Omitting the
  // handler hides the control entirely (used on /read etc. where we
  // deliberately don't surface interactive affordances).
  onBskyLike?: (item: Item) => Promise<boolean>;
  onBskyRepost?: (item: Item) => Promise<boolean>;
  onBskyFollow?: (item: Item) => Promise<boolean>;
}

const CATEGORY_LABEL: Record<string, { label: string; klass: string }> = {
  music: { label: "Music", klass: "text-cat-music" },
  books: { label: "Books", klass: "text-cat-books" },
  film: { label: "Film", klass: "text-cat-film" },
  tech_review: { label: "Tech Review", klass: "text-cat-tech_review" },
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

const FeedCard = memo(forwardRef<HTMLDivElement, FeedCardProps>(function FeedCard(
  {
    item,
    index,
    focused,
    onFocus,
    onOpen,
    onSave,
    onDismiss,
    onClearAbove,
    onBskyLike,
    onBskyRepost,
    onBskyFollow,
  },
  ref
) {
  const category = item.source_category || "reading";
  const cat = CATEGORY_LABEL[category] || CATEGORY_LABEL.reading;
  const isBluesky = category === "bluesky";
  const isPodcast = category === "podcasts";
  const saved = !!item.saved_at;

  const bsky = isBluesky ? parseMeta<BlueskyMetadata>(item.metadata) : null;
  const podcast = isPodcast ? parseMeta<PodcastMeta>(item.metadata) : null;

  // ── Bluesky interaction state ────────────────────────────────
  // We hold optimistic overrides in local state so taps feel instant. When
  // `item.metadata` changes underneath us (feed refresh, parent mutation),
  // the effect below resyncs us to the new server truth.
  const [bskyLiked, setBskyLiked] = useState<boolean>(
    !!bsky?.viewer?.like_uri
  );
  const [bskyLikeCount, setBskyLikeCount] = useState<number>(
    bsky?.like_count ?? 0
  );
  const [bskyReposted, setBskyReposted] = useState<boolean>(
    !!bsky?.viewer?.repost_uri
  );
  const [bskyRepostCount, setBskyRepostCount] = useState<number>(
    bsky?.repost_count ?? 0
  );
  // Follow is one-way. Once true we never flip it back, even if the
  // underlying row changes (so a rapid double-tap can't re-show the chip).
  const [bskyFollowing, setBskyFollowing] = useState<boolean>(
    !!bsky?.viewer?.following_uri
  );
  const bskyBusyRef = useRef<{ like: boolean; repost: boolean; follow: boolean }>(
    { like: false, repost: false, follow: false }
  );
  useEffect(() => {
    if (!isBluesky) return;
    // Re-derive from item.metadata directly: the outer-scope `bsky` is a
    // fresh object every render, so putting it in the deps list (or reading
    // it here without the metadata string as dep) would trip this effect
    // after every click and stomp the optimistic state we just set.
    const fresh = parseMeta<BlueskyMetadata>(item.metadata);
    setBskyLiked(!!fresh?.viewer?.like_uri);
    setBskyLikeCount(fresh?.like_count ?? 0);
    setBskyReposted(!!fresh?.viewer?.repost_uri);
    setBskyRepostCount(fresh?.repost_count ?? 0);
    // Only flip to true from server truth — don't let an older cached row
    // revert a successful optimistic follow.
    if (fresh?.viewer?.following_uri) setBskyFollowing(true);
  }, [item.metadata, isBluesky]);

  async function handleBskyLike() {
    if (!onBskyLike || !bsky) return;
    if (bskyBusyRef.current.like) return;
    bskyBusyRef.current.like = true;
    const prevLiked = bskyLiked;
    const prevCount = bskyLikeCount;
    const nextLiked = !prevLiked;
    setBskyLiked(nextLiked);
    setBskyLikeCount(Math.max(0, prevCount + (nextLiked ? 1 : -1)));
    const ok = await onBskyLike(item);
    if (!ok) {
      setBskyLiked(prevLiked);
      setBskyLikeCount(prevCount);
    }
    bskyBusyRef.current.like = false;
  }

  async function handleBskyRepost() {
    if (!onBskyRepost || !bsky) return;
    if (bskyBusyRef.current.repost) return;
    bskyBusyRef.current.repost = true;
    const prevReposted = bskyReposted;
    const prevCount = bskyRepostCount;
    const nextReposted = !prevReposted;
    setBskyReposted(nextReposted);
    setBskyRepostCount(Math.max(0, prevCount + (nextReposted ? 1 : -1)));
    const ok = await onBskyRepost(item);
    if (!ok) {
      setBskyReposted(prevReposted);
      setBskyRepostCount(prevCount);
    }
    bskyBusyRef.current.repost = false;
  }

  async function handleBskyFollow() {
    if (!onBskyFollow || !bsky) return;
    if (bskyBusyRef.current.follow) return;
    bskyBusyRef.current.follow = true;
    setBskyFollowing(true);
    const ok = await onBskyFollow(item);
    if (!ok) setBskyFollowing(false);
    bskyBusyRef.current.follow = false;
  }

  const canBskyInteract = isBluesky && bsky && !!bsky.uri && !!bsky.cid;
  const canBskyFollow = isBluesky && bsky && !!bsky.did && !bskyFollowing;

  // Limit stagger to first 8 cards so the page never feels slow
  const animDelay =
    index < 8 ? `${30 + index * 35}ms` : undefined;

  // ─── Swipe state ─────────────────────────────────────────────
  // dx is the current horizontal translation of the article. animating
  // toggles the CSS transition so direct-drag updates feel 1:1 (no
  // transition) while commit/snap-back are smooth (transition on).
  // wasSwipedRef guards onClick so a swipe doesn't also count as a tap.
  const [dx, setDx] = useState(0);
  const [animating, setAnimating] = useState(false);
  // `longPressing` drives the hold progress bar at the top of the card.
  // When true, the bar's CSS transition scales from 0→1 over LONG_PRESS_MS.
  // When false, it snaps back to 0 with a quick fade — either because the
  // user released early, started swiping, or the long-press fired.
  const [longPressing, setLongPressing] = useState(false);
  const startRef = useRef<{ x: number; y: number; locked: boolean } | null>(null);
  const wasSwipedRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);

  function cancelLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setLongPressing(false);
  }

  function handleTouchStart(e: ReactTouchEvent) {
    if (animating) return;
    onFocus(index);
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY, locked: false };
    longPressFiredRef.current = false;
    if (onClearAbove) {
      cancelLongPress();
      setLongPressing(true);
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        setLongPressing(false);
        // Only fire if the user never started swiping and never released.
        const s = startRef.current;
        if (!s || s.locked) return;
        longPressFiredRef.current = true;
        // Swallow the upcoming click from release.
        wasSwipedRef.current = true;
        onClearAbove(item);
      }, LONG_PRESS_MS);
    }
  }

  function handleTouchMove(e: ReactTouchEvent) {
    const start = startRef.current;
    if (!start || animating) return;
    const t = e.touches[0];
    const moveX = t.clientX - start.x;
    const moveY = t.clientY - start.y;

    if (!start.locked) {
      const absX = Math.abs(moveX);
      const absY = Math.abs(moveY);
      if (absX < SWIPE_DETECT_THRESHOLD && absY < SWIPE_DETECT_THRESHOLD) return;
      // Any meaningful motion cancels the pending long-press.
      cancelLongPress();
      if (absY > absX) {
        // The user is scrolling vertically — bow out so the page can scroll.
        startRef.current = null;
        return;
      }
      start.locked = true;
      wasSwipedRef.current = true;
    }
    setDx(moveX);
  }

  function handleTouchEnd() {
    cancelLongPress();
    const start = startRef.current;
    if (!start) return;
    startRef.current = null;
    if (longPressFiredRef.current) {
      // Long-press already fired — do nothing on release.
      return;
    }
    if (!start.locked) {
      // Tap, not swipe — let the upcoming click event open the card.
      return;
    }

    const finalDx = dx;
    setAnimating(true);

    const commitSave = finalDx > SWIPE_COMMIT_THRESHOLD;
    // Only treat a left swipe as a commit if there's actually a dismiss
    // action to fire — on /read the dismiss button is hidden, so a left
    // swipe just snaps back instead of doing nothing visible.
    const commitDismiss = finalDx < -SWIPE_COMMIT_THRESHOLD && !!onDismiss;

    if (commitSave) {
      setDx(window.innerWidth);
      window.setTimeout(() => {
        onSave(item);
        // If the parent unmounts us (typical on the main feed), these
        // setState calls are no-ops. If we stay mounted (e.g. /read where
        // save toggles in place), reset position WITHOUT animating —
        // setting animating false first means the next render snaps to 0
        // instantly instead of sliding back from off-screen.
        setAnimating(false);
        setDx(0);
        wasSwipedRef.current = false;
      }, COMMIT_ANIM_MS);
    } else if (commitDismiss) {
      setDx(-window.innerWidth);
      window.setTimeout(() => {
        onDismiss?.(item);
        setAnimating(false);
        setDx(0);
        wasSwipedRef.current = false;
      }, COMMIT_ANIM_MS);
    } else {
      // Snap back
      setDx(0);
      window.setTimeout(() => {
        setAnimating(false);
        wasSwipedRef.current = false;
      }, COMMIT_ANIM_MS);
    }
  }

  function handleClick() {
    if (wasSwipedRef.current) {
      // The touchend that just preceded this click was the end of a
      // swipe gesture, not a tap — eat the click and let the gesture
      // animation finish on its own.
      wasSwipedRef.current = false;
      return;
    }
    onOpen(item);
  }

  // Reveal background icons only after the gesture has clearly started so
  // that incidental movement doesn't flash them.
  const showSaveBg = dx > SWIPE_DETECT_THRESHOLD;
  const showDismissBg = dx < -SWIPE_DETECT_THRESHOLD && !!onDismiss;
  // Past the commit threshold, intensify the icon to confirm the action
  // will fire on release.
  const saveCommitted = dx > SWIPE_COMMIT_THRESHOLD;
  const dismissCommitted = dx < -SWIPE_COMMIT_THRESHOLD && !!onDismiss;

  return (
    <div
      ref={ref}
      data-feed-index={index}
      className="group relative scroll-mt-24 overflow-hidden border-b border-rule/70 animate-fade-in-up"
      style={animDelay ? { animationDelay: animDelay } : undefined}
    >
      {/* Save background — revealed under the article on right swipe */}
      {showSaveBg && (
        <div
          aria-hidden
          className={[
            "pointer-events-none absolute inset-0 flex items-center justify-start pl-8 transition-colors duration-150",
            saveCommitted ? "bg-accent-soft text-accent" : "bg-accent-soft/40 text-accent/60",
          ].join(" ")}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill={saveCommitted ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </div>
      )}
      {/* Dismiss background — revealed under the article on left swipe */}
      {showDismissBg && (
        <div
          aria-hidden
          className={[
            "pointer-events-none absolute inset-0 flex items-center justify-end pr-8 transition-colors duration-150",
            dismissCommitted ? "bg-rule/60 text-cream" : "bg-rule/30 text-cream-dim",
          ].join(" ")}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </div>
      )}
      {/* Left edge accent rule — focus state. Lives on the wrapper (not the
          article) so it doesn't slide horizontally during a swipe. */}
      <span
        aria-hidden
        className={[
          "pointer-events-none absolute left-0 top-0 z-10 h-full transition-all duration-200",
          focused
            ? "w-[3px] bg-accent"
            : "w-[2px] bg-transparent group-hover:bg-cream-dimmer/50",
        ].join(" ")}
      />
      <article
        onClick={handleClick}
        onMouseEnter={() => onFocus(index)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{
          transform: `translateX(${dx}px)`,
          transition: animating ? `transform ${COMMIT_ANIM_MS}ms ease-out` : "none",
          touchAction: "pan-y",
          // Suppress iOS's long-press callout (copy/share) and text selection,
          // both of which would fight the Clear-Above long-press gesture.
          WebkitTouchCallout: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
        className={[
          "relative cursor-pointer px-6 py-5 transition-colors duration-200",
          // Opaque background so the swipe action area is hidden until revealed
          focused ? "bg-ink-hover" : "bg-ink hover:bg-ink-raised/60",
        ].join(" ")}
      >
      {/* Long-press progress bar. Only appears during a touch hold; fills
          from left to right over LONG_PRESS_MS, then Clear-Above fires.
          scaleX + transform-origin is noticeably smoother on mobile than
          animating width. Fast 120ms snap-back when the gesture is
          cancelled (release, scroll, or swipe). */}
      {onClearAbove && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-[2px] origin-left bg-accent"
          style={{
            transform: longPressing ? "scaleX(1)" : "scaleX(0)",
            opacity: longPressing ? 1 : 0,
            transition: longPressing
              ? `transform ${LONG_PRESS_MS}ms linear, opacity 80ms ease-out`
              : "transform 120ms ease-out, opacity 120ms ease-out",
          }}
        />
      )}
      {/* Repost banner — when this post appears in the feed via someone reposting it */}
      {isBluesky && bsky?.reposted_by && (
        <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
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
      <div className="mb-2.5 flex items-center gap-2 font-mono text-[0.72rem] uppercase tracking-kicker text-cream-dim">
        {isBluesky && bsky?.avatar_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bsky.avatar_url}
            alt=""
            loading="lazy"
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
        {canBskyFollow && onBskyFollow && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleBskyFollow();
            }}
            title={`Follow @${bsky?.handle}`}
            className="ml-0.5 flex-shrink-0 rounded-full border border-accent/50 px-2 py-0.5 font-mono text-[0.62rem] uppercase tracking-kicker text-accent transition-colors hover:border-accent hover:bg-accent-soft"
          >
            + Follow
          </button>
        )}
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
              loading="lazy"
              className="h-20 w-20 flex-shrink-0 rounded-sm object-cover ring-1 ring-rule"
            />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[1.05rem] font-medium leading-snug text-cream opsz-body">
              {item.title}
            </h2>
            <p className="mt-1.5 font-mono text-[0.72rem] uppercase tracking-kicker text-cream-dim">
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

      {/* Bluesky engagement row. Like and Repost are interactive when the
          handlers are provided and we have the post identity. Reply count
          stays a read-only label — we don't post replies from here. */}
      {isBluesky && bsky && (
        <div className="mt-2.5 flex items-center gap-3 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim">
          {onBskyLike && canBskyInteract ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleBskyLike();
              }}
              title={bskyLiked ? "Unlike" : "Like"}
              className={[
                "flex items-center gap-1.5 rounded-sm px-2 py-1 transition-colors",
                bskyLiked
                  ? "text-accent hover:text-accent"
                  : "hover:text-cream",
              ].join(" ")}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill={bskyLiked ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              <span className="tabular-nums">{bskyLikeCount}</span>
            </button>
          ) : !!bsky.like_count ? (
            <span>{bsky.like_count} likes</span>
          ) : null}
          {onBskyRepost && canBskyInteract ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleBskyRepost();
              }}
              title={bskyReposted ? "Undo repost" : "Repost"}
              className={[
                "flex items-center gap-1.5 rounded-sm px-2 py-1 transition-colors",
                bskyReposted
                  ? "text-accent hover:text-accent"
                  : "hover:text-cream",
              ].join(" ")}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="17 1 21 5 17 9" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <polyline points="7 23 3 19 7 15" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
              <span className="tabular-nums">{bskyRepostCount}</span>
            </button>
          ) : !!bsky.repost_count ? (
            <span>{bsky.repost_count} reposts</span>
          ) : null}
          {!!bsky.reply_count && <span>{bsky.reply_count} replies</span>}
        </div>
      )}

      {/* Action row — hover- or focus-revealed on desktop. Hidden entirely
          on touch devices, where swipe gestures replace the buttons. The
          @media(hover:none) override comes after the focused/hover classes
          so it wins the opacity cascade on touch. */}
      <div
        className={[
          "absolute right-5 top-5 flex items-center gap-1 transition-opacity duration-150",
          focused ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          "[@media(hover:none)]:!opacity-0 [@media(hover:none)]:pointer-events-none",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <ActionButton
          label={saved ? "Unsave (s)" : "Save (s)"}
          active={saved}
          onClick={() => onSave(item)}
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
        {onClearAbove && (
          <ActionButton
            label="Clear above (c)"
            onClick={() => onClearAbove(item)}
          >
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
              <polyline points="17 11 12 6 7 11" />
              <polyline points="17 18 12 13 7 18" />
            </svg>
          </ActionButton>
        )}
        {onDismiss && (
          <ActionButton label="Dismiss (x)" onClick={() => onDismiss(item)}>
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
    </div>
  );
}));

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
        <div className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
          ↳ replying to {reply.display_name || `@${reply.handle}`}
        </div>
        <div className="mt-0.5 line-clamp-2 font-display text-[0.9rem] italic leading-snug text-cream-dim opsz-body">
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
        <div className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
          {external.domain}
        </div>
        <div className="mt-1 line-clamp-2 font-display text-[0.95rem] font-medium leading-snug text-cream opsz-body">
          {external.title}
        </div>
        {external.description && (
          <div className="mt-1 line-clamp-2 font-display text-[0.85rem] italic leading-snug text-cream-dim opsz-body">
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
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
        {post.avatar_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.avatar_url}
            alt=""
            loading="lazy"
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
        <p className="whitespace-pre-wrap break-words font-display text-[0.95rem] leading-snug text-cream opsz-body line-clamp-6">
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
          <span className="truncate font-mono text-[0.68rem] uppercase tracking-kicker">
            {post.external.domain}
          </span>
        </div>
      )}
    </a>
  );
}

export default FeedCard;
