"use client";

import { useState, useCallback } from "react";
import type { Item } from "@/lib/types";
import FeedCard from "@/components/FeedCard";

interface FeedClientProps {
  initialItems: Item[];
}

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "reading", label: "Reading" },
  { id: "music", label: "Music" },
  { id: "film", label: "Film" },
  { id: "podcasts", label: "Podcasts" },
  { id: "bluesky", label: "Bluesky" },
];

export default function FeedClient({ initialItems }: FeedClientProps) {
  const [items, setItems] = useState<Item[]>(initialItems);
  const [activeCategory, setActiveCategory] = useState("all");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const fetchItems = useCallback(async (category: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50", offset: "0" });
      if (category !== "all") params.set("category", category);
      const res = await fetch(`/api/items?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setItems(data.items || []);
    } catch (err) {
      console.error("[FeedClient] Fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleCategoryChange(cat: string) {
    setActiveCategory(cat);
    if (cat === "all" && !loading) {
      // Use initial items for "all" on first load, then fetch fresh
      fetchItems("all");
    } else {
      fetchItems(cat);
    }
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.ok) throw new Error("Refresh failed");
      const data = await res.json();
      setLastRefresh(`Fetched ${data.fetched} new items`);
      await fetchItems(activeCategory);
    } catch (err) {
      console.error("[FeedClient] Refresh error:", err);
      setLastRefresh("Refresh failed");
    } finally {
      setRefreshing(false);
      setTimeout(() => setLastRefresh(null), 4000);
    }
  }

  const handleDismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleSaveToggle = useCallback((_id: string, _saved: boolean) => {
    // Items remain visible whether saved or not — saving is a separate state
  }, []);

  const visibleItems = items;

  return (
    <div
      style={{
        maxWidth: "680px",
        margin: "0 auto",
        padding: "1.5rem 1rem",
      }}
    >
      {/* Controls row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1.25rem",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        {/* Category tabs */}
        <div
          style={{
            display: "flex",
            gap: "0.375rem",
            flexWrap: "wrap",
          }}
        >
          {CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => handleCategoryChange(cat.id)}
                style={{
                  padding: "5px 14px",
                  borderRadius: "999px",
                  fontSize: "0.8125rem",
                  fontWeight: isActive ? 600 : 500,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  border: isActive ? "none" : "1px solid #1e1e24",
                  backgroundColor: isActive ? "#6366f1" : "transparent",
                  color: isActive ? "#ffffff" : "#8888a0",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.color =
                      "#f0f0f2";
                    (e.currentTarget as HTMLButtonElement).style.borderColor =
                      "#2e2e38";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.color =
                      "#8888a0";
                    (e.currentTarget as HTMLButtonElement).style.borderColor =
                      "#1e1e24";
                  }
                }}
              >
                {cat.label}
              </button>
            );
          })}
        </div>

        {/* Refresh button */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {lastRefresh && (
            <span
              style={{
                fontSize: "0.75rem",
                color: "#8888a0",
                whiteSpace: "nowrap",
              }}
            >
              {lastRefresh}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh feeds"
            style={{
              background: "none",
              border: "1px solid #1e1e24",
              borderRadius: "6px",
              cursor: refreshing ? "wait" : "pointer",
              padding: "6px 10px",
              color: refreshing ? "#8888a0" : "#8888a0",
              display: "flex",
              alignItems: "center",
              gap: "0.375rem",
              fontSize: "0.8125rem",
              transition: "all 0.15s ease",
              opacity: refreshing ? 0.6 : 1,
            }}
            onMouseEnter={(e) => {
              if (!refreshing) {
                (e.currentTarget as HTMLButtonElement).style.color = "#f0f0f2";
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  "#2e2e38";
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = "#8888a0";
              (e.currentTarget as HTMLButtonElement).style.borderColor =
                "#1e1e24";
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                animation: refreshing ? "spin 1s linear infinite" : "none",
              }}
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Spinner for category switch */}
      {loading && (
        <div
          style={{
            textAlign: "center",
            padding: "3rem 0",
            color: "#8888a0",
            fontSize: "0.875rem",
          }}
        >
          Loading...
        </div>
      )}

      {/* Feed list */}
      {!loading && (
        <>
          {visibleItems.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "5rem 0",
                color: "#8888a0",
              }}
            >
              <p
                style={{
                  fontFamily: "Georgia, serif",
                  fontSize: "1.125rem",
                  color: "#f0f0f2",
                  marginBottom: "0.5rem",
                }}
              >
                {"You're caught up."}
              </p>
              <p style={{ fontSize: "0.875rem" }}>Go do something.</p>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.625rem",
              }}
            >
              {visibleItems.map((item) => (
                <FeedCard
                  key={item.id}
                  item={item}
                  onDismiss={handleDismiss}
                  onSaveToggle={handleSaveToggle}
                />
              ))}

              {/* End state */}
              <div
                style={{
                  textAlign: "center",
                  padding: "2.5rem 0",
                  color: "#8888a0",
                  fontSize: "0.875rem",
                }}
              >
                {visibleItems.length} item{visibleItems.length !== 1 ? "s" : ""}{" "}
                · Dismiss all to finish up
              </div>
            </div>
          )}
        </>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
