"use client";

import { useState, useCallback } from "react";
import type { Item } from "@/lib/types";
import FeedCard from "@/components/FeedCard";

interface SavedClientProps {
  initialItems: Item[];
}

export default function SavedClient({ initialItems }: SavedClientProps) {
  const [items, setItems] = useState<Item[]>(initialItems);

  const handleUnsave = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleDismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  return (
    <div style={{ maxWidth: "680px", margin: "0 auto", padding: "1.5rem 1rem" }}>
      {items.length === 0 ? (
        <div style={{ textAlign: "center", padding: "5rem 0", color: "#8888a0" }}>
          <p style={{ fontFamily: "Georgia, serif", fontSize: "1.125rem", color: "#f0f0f2", marginBottom: "0.5rem" }}>
            Nothing saved yet.
          </p>
          <p style={{ fontSize: "0.875rem" }}>Tap the bookmark on any item to save it here.</p>
        </div>
      ) : (
        <>
          <p style={{ fontSize: "0.75rem", color: "#8888a0", marginBottom: "1.25rem" }}>
            {items.length} saved item{items.length !== 1 ? "s" : ""}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            {items.map((item) => (
              <FeedCard
                key={item.id}
                item={item}
                onDismiss={handleDismiss}
                onSaveToggle={(id, saved) => {
                  if (!saved) handleUnsave(id);
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
