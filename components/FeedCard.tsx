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

export default function FeedCard({ item, onDismiss, onSaveToggle }: FeedCardProps) {
  const [saved, setSaved] = useState(!!item.saved_at);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);

  const category = item.source_category || "reading";
  const colors = CATEGORY_COLORS[category] || CATEGORY_COLORS.reading;

  if (dismissed) return null;

  async function handleOpenAndRead() {
    window.open(item.url, "_blank", "noopener,noreferrer");
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
        <span
          style={{
            fontSize: "0.75rem",
            color: "#8888a0",
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {item.source_name}
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

      {/* Title — for Bluesky posts (no title), render body text as the main content */}
      {item.title ? (
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

      {/* Body excerpt — only shown for titled items */}
      {item.title && item.body_excerpt && (
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
        <span style={{ fontSize: "0.75rem", color: "#8888a0" }}>
          {item.author ? `${item.author} · ` : ""}
          {relativeDate(item.published_at)}
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
