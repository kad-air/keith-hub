"use client";

import { useState } from "react";
import type { Item } from "@/lib/types";

interface FeedCardProps {
  item: Item;
  onDismiss: (id: string) => void;
  onSaveToggle: (id: string, saved: boolean) => void;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  music: { bg: "rgba(139, 92, 246, 0.15)", text: "#a78bfa", label: "Music" },
  film: { bg: "rgba(245, 158, 11, 0.15)", text: "#fbbf24", label: "Film" },
  reading: { bg: "rgba(59, 130, 246, 0.15)", text: "#60a5fa", label: "Reading" },
  podcasts: { bg: "rgba(16, 185, 129, 0.15)", text: "#34d399", label: "Podcasts" },
  bluesky: { bg: "rgba(0, 133, 255, 0.12)", text: "#38bdf8", label: "Bluesky" },
};

function relativeDate(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return new Date(isoString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatDuration(raw: string): string {
  // Handles HH:MM:SS, MM:SS, or plain seconds
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

export default function FeedCard({ item, onDismiss, onSaveToggle }: FeedCardProps) {
  const [saved, setSaved] = useState(!!item.saved_at);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);

  const category = item.source_category || "reading";
  const colors = CATEGORY_COLORS[category] || CATEGORY_COLORS.reading;
  const isBluesky = category === "bluesky";
  const isPodcast = category === "podcasts";

  const parseMeta = <T,>(): T | null => {
    if (!item.metadata) return null;
    try { return JSON.parse(item.metadata) as T; } catch { return null; }
  };

  const bskyMeta = isBluesky ? parseMeta<{ handle?: string; avatar_url?: string; like_count?: number; reply_count?: number; repost_count?: number }>() : null;
  const podcastMeta = isPodcast ? parseMeta<{ show_name?: string; duration?: string; audio_url?: string; artwork_url?: string; apple_id?: string }>() : null;

  const tapUrl = isPodcast && podcastMeta?.apple_id
    ? `https://podcasts.apple.com/podcast/id${podcastMeta.apple_id}`
    : item.url;

  if (dismissed) return null;

  async function handleOpenAndRead() {
    window.open(tapUrl, "_blank", "noopener,noreferrer");
    // Mark as read
    try {
      await fetch(`/api/items/${item.id}/read`, { method: "POST" });
    } catch {
      // Ignore — item is already opened
    }
    setDismissed(true);
  }

  async function handleSave(e: React.MouseEvent) {
    e.stopPropagation();
    if (saving) return;
    setSaving(true);
    const optimisticSaved = !saved;
    setSaved(optimisticSaved);
    try {
      await fetch(`/api/items/${item.id}/save`, { method: "POST" });
      onSaveToggle(item.id, optimisticSaved);
    } catch {
      // Revert on failure
      setSaved(!optimisticSaved);
    } finally {
      setSaving(false);
    }
  }

  async function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    setDismissed(true);
    onDismiss(item.id);
    try {
      await fetch(`/api/items/${item.id}/read`, { method: "POST" });
    } catch {
      // Best effort
    }
  }

  return (
    <article
      onClick={handleOpenAndRead}
      style={{
        backgroundColor: "#111114",
        border: "1px solid #1e1e24",
        borderRadius: "8px",
        padding: "1rem 1.25rem",
        cursor: "pointer",
        transition: "border-color 0.15s ease, background-color 0.15s ease",
        position: "relative",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "#2e2e38";
        (e.currentTarget as HTMLElement).style.backgroundColor = "#13131a";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "#1e1e24";
        (e.currentTarget as HTMLElement).style.backgroundColor = "#111114";
      }}
    >
      {/* Header row: source + category pill */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.5rem",
        }}
      >
        {/* Avatar for Bluesky posts */}
        {isBluesky && bskyMeta?.avatar_url && (
          <img
            src={bskyMeta.avatar_url}
            alt={bskyMeta.handle || ""}
            width={22}
            height={22}
            style={{ borderRadius: "50%", flexShrink: 0, objectFit: "cover" }}
          />
        )}
        <span
          style={{
            fontSize: "0.75rem",
            color: "#8888a0",
            fontWeight: 500,
            textTransform: isBluesky ? "none" : "uppercase",
            letterSpacing: isBluesky ? "0" : "0.05em",
          }}
        >
          {isBluesky && bskyMeta?.handle ? `@${bskyMeta.handle}` : item.source_name}
        </span>
        <span
          style={{
            fontSize: "0.6875rem",
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: "999px",
            backgroundColor: colors.bg,
            color: colors.text,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {colors.label}
        </span>
      </div>

      {/* Podcast layout: artwork left, content right */}
      {isPodcast ? (
        <div style={{ display: "flex", gap: "0.875rem", alignItems: "flex-start" }}>
          {(podcastMeta?.artwork_url || item.image_url) && (
            <img
              src={podcastMeta?.artwork_url || item.image_url || ""}
              alt=""
              width={64}
              height={64}
              style={{ borderRadius: "6px", flexShrink: 0, objectFit: "cover" }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              style={{
                fontFamily: "Georgia, serif",
                fontSize: "0.9375rem",
                fontWeight: 600,
                color: "#f0f0f2",
                margin: "0 0 0.25rem 0",
                lineHeight: 1.4,
              }}
            >
              {item.title}
            </h2>
            <div style={{ fontSize: "0.75rem", color: "#8888a0", display: "flex", gap: "0.5rem", alignItems: "center" }}>
              {podcastMeta?.show_name && <span>{podcastMeta.show_name}</span>}
              {podcastMeta?.duration && (
                <>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span>{formatDuration(podcastMeta.duration)}</span>
                </>
              )}
            </div>
          </div>
        </div>
      ) : item.title ? (
        <h2
          style={{
            fontFamily: "Georgia, serif",
            fontSize: "1rem",
            fontWeight: 600,
            color: "#f0f0f2",
            margin: "0 0 0.375rem 0",
            lineHeight: 1.4,
            letterSpacing: "-0.01em",
          }}
        >
          {item.title}
        </h2>
      ) : (
        <p
          style={{
            fontSize: "0.9375rem",
            color: "#e0e0ee",
            margin: "0 0 0.75rem 0",
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {item.body_excerpt}
        </p>
      )}

      {/* Body excerpt — only shown for non-podcast titled items */}
      {!isPodcast && item.title && item.body_excerpt && (
        <p
          style={{
            fontSize: "0.875rem",
            color: "#8888a0",
            margin: "0 0 0.75rem 0",
            lineHeight: 1.55,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {item.body_excerpt}
        </p>
      )}

      {/* Footer row: author + date + actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: "0.5rem",
        }}
      >
        <span style={{ fontSize: "0.75rem", color: "#8888a0", display: "flex", alignItems: "center", gap: "0.625rem" }}>
          <span suppressHydrationWarning>{relativeDate(item.published_at)}</span>
          {isBluesky && bskyMeta && (
            <>
              {!!bskyMeta.reply_count && (
                <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  {bskyMeta.reply_count}
                </span>
              )}
              {!!bskyMeta.like_count && (
                <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  {bskyMeta.like_count}
                </span>
              )}
            </>
          )}
        </span>

        <div
          style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Save button */}
          <button
            onClick={handleSave}
            title={saved ? "Unsave" : "Save for later"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "6px",
              borderRadius: "6px",
              color: saved ? "#6366f1" : "#8888a0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "color 0.15s ease, background-color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "rgba(99, 102, 241, 0.1)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "transparent";
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill={saved ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          {/* Open link button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenAndRead();
            }}
            title="Open"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "6px",
              borderRadius: "6px",
              color: "#8888a0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "color 0.15s ease, background-color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = "#f0f0f2";
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "rgba(240, 240, 242, 0.08)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = "#8888a0";
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "transparent";
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>

          {/* Dismiss button */}
          <button
            onClick={handleDismiss}
            title="Dismiss"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "6px",
              borderRadius: "6px",
              color: "#8888a0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "color 0.15s ease, background-color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = "#f87171";
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "rgba(248, 113, 113, 0.1)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = "#8888a0";
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "transparent";
            }}
          >
            <svg
              width="16"
              height="16"
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
          </button>
        </div>
      </div>
    </article>
  );
}
