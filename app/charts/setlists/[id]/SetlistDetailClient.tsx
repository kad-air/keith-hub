"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chart } from "@/lib/charts";
import type { Setlist } from "@/lib/setlists";

interface Props {
  initialSetlist: Setlist;
  initialCharts: Chart[];
  library: Chart[];
}

// Vertical gap between rows (Tailwind space-y-2 = 0.5rem). Used by the drag
// math to size the gap the lifted row leaves behind.
const GAP_PX = 8;
// Drag auto-scroll: distance from a viewport edge that arms scrolling, and the
// max px/frame it scrolls at full press into the edge.
const EDGE_PX = 90;
const EDGE_MAX_SPEED = 16;

function lineCount(content: string): number {
  return content.split("\n").length;
}

export default function SetlistDetailClient({
  initialSetlist,
  initialCharts,
  library,
}: Props) {
  const router = useRouter();
  const [setlist, setSetlist] = useState<Setlist>(initialSetlist);
  const [charts, setCharts] = useState<Chart[]>(initialCharts);
  const [online, setOnline] = useState(true);
  const [offlineReady, setOfflineReady] = useState(false);
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(initialSetlist.name);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const warmedRef = useRef<string>("");

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Library charts not already in this setlist — the "Add tabs" picker pool.
  const available = useMemo(() => {
    const member = new Set(charts.map((c) => c.id));
    return library.filter((c) => !member.has(c.id));
  }, [charts, library]);

  // Warm the SW cache for this setlist when it's flagged offline: fetch each
  // member chart's page (and this setlist page) so they're available with no
  // signal. Keyed on the member set so adds/removes re-warm.
  // Fold each chart's updatedAt into the key so editing a member chart re-warms
  // its page — keying on id alone would short-circuit the guard and leave the
  // stale (pre-edit) render cached for offline play.
  const warmKey = useMemo(
    () =>
      setlist.offline
        ? charts.map((c) => `${c.id}@${c.updatedAt}`).join(",")
        : "",
    [setlist.offline, charts],
  );
  useEffect(() => {
    if (!online || !setlist.offline) return;
    if (warmedRef.current === warmKey) {
      setOfflineReady(true);
      return;
    }
    let cancelled = false;
    setOfflineReady(false);
    (async () => {
      const pages = [
        `/charts/setlists/${setlist.id}`,
        ...charts.map((c) => `/charts/${c.id}`),
      ];
      for (const href of pages) {
        if (cancelled) return;
        try {
          await fetch(href);
          router.prefetch(href);
        } catch {
          return;
        }
      }
      if (!cancelled) {
        warmedRef.current = warmKey;
        setOfflineReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [online, setlist.offline, setlist.id, charts, warmKey, router]);

  const offlineStatus = !setlist.offline
    ? ""
    : !online
      ? "● Offline · charts available"
      : offlineReady
        ? "✓ Saved for offline"
        : "Saving for offline…";

  const toggleOffline = useCallback(async () => {
    const next = !setlist.offline;
    setSetlist((s) => ({ ...s, offline: next }));
    try {
      const res = await fetch(`/api/setlists/${setlist.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offline: next }),
      });
      if (!res.ok) throw new Error("toggle failed");
    } catch {
      setSetlist((s) => ({ ...s, offline: !next }));
    }
  }, [setlist.offline, setlist.id]);

  const saveName = useCallback(async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    const prev = setlist.name;
    setSetlist((s) => ({ ...s, name: trimmed }));
    setRenaming(false);
    try {
      const res = await fetch(`/api/setlists/${setlist.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error("rename failed");
    } catch {
      setSetlist((s) => ({ ...s, name: prev }));
      setNameDraft(prev);
    }
  }, [nameDraft, setlist.id, setlist.name]);

  const deleteSetlist = useCallback(async () => {
    if (
      !window.confirm(
        `Delete the setlist "${setlist.name}"? The charts stay in your library.`,
      )
    )
      return;
    try {
      const res = await fetch(`/api/setlists/${setlist.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("delete failed");
      router.push("/charts/setlists");
    } catch {
      setError("Couldn't delete. Try again.");
    }
  }, [setlist.id, setlist.name, router]);

  const addChart = useCallback(
    async (chart: Chart) => {
      if (!online) return;
      // Optimistic append. The server also appends at the end (MAX(sort_order)
      // + 1), so the optimistic order already matches — we deliberately do NOT
      // overwrite the list with the server's response, which would clobber a
      // concurrent add/remove/reorder still settling locally.
      setCharts((cur) =>
        cur.some((c) => c.id === chart.id) ? cur : [...cur, chart],
      );
      try {
        const res = await fetch(`/api/setlists/${setlist.id}/charts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chartId: chart.id }),
        });
        if (!res.ok) throw new Error("add failed");
      } catch {
        setCharts((cur) => cur.filter((c) => c.id !== chart.id));
      }
    },
    [online, setlist.id],
  );

  const removeChart = useCallback(
    async (chart: Chart) => {
      if (!online) return;
      const idx = charts.findIndex((c) => c.id === chart.id);
      setCharts((cur) => cur.filter((c) => c.id !== chart.id));
      try {
        const res = await fetch(
          `/api/setlists/${setlist.id}/charts/${chart.id}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error("remove failed");
      } catch {
        // Re-insert at the original position functionally, rather than
        // overwriting with a captured snapshot that a concurrent reconcile may
        // have made stale.
        setCharts((cur) => {
          if (cur.some((c) => c.id === chart.id)) return cur;
          const next = [...cur];
          next.splice(idx < 0 ? next.length : Math.min(idx, next.length), 0, chart);
          return next;
        });
      }
    },
    [online, charts, setlist.id],
  );

  // Persist a new order to the server, rolling back on failure.
  const commitOrder = useCallback(
    async (next: Chart[], prev: Chart[]) => {
      try {
        const res = await fetch(`/api/setlists/${setlist.id}/reorder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: next.map((c) => c.id) }),
        });
        if (!res.ok) throw new Error("reorder failed");
      } catch {
        setCharts(prev);
      }
    },
    [setlist.id],
  );

  // Copy the setlist to the clipboard as plain "Song - Artist" lines (just the
  // song when there's no artist), in performance order. Read-only, so it works
  // offline at a gig — no online gating. Briefly flips the label to confirm.
  const copyError = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copySetlist = useCallback(async () => {
    if (charts.length === 0) return;
    const text = charts
      .map((c) => (c.artist ? `${c.title} - ${c.artist}` : c.title))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyError.current) clearTimeout(copyError.current);
      copyError.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy to clipboard.");
    }
  }, [charts]);

  useEffect(
    () => () => {
      if (copyError.current) clearTimeout(copyError.current);
    },
    [],
  );

  // ---- Drag-to-reorder ---------------------------------------------------
  // A dependency-free pointer drag (touch + mouse). The list array stays
  // untouched during the drag — rows move via CSS transforms written straight
  // to the DOM, and the reordered array commits once on drop, so the 60Hz move
  // handler never hits React's render path. Lifted from the original setlist
  // list; now scoped to reordering within a single setlist.
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const drag = useRef<{
    pointerId: number;
    startPageY: number;
    startIndex: number;
    currentIndex: number;
    tops: number[];
    heights: number[];
    handle: HTMLElement;
  } | null>(null);
  const lastClientY = useRef(0);
  const autoScrollRaf = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const renderDrag = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    const dy = lastClientY.current + window.scrollY - d.startPageY;
    const { tops, heights, startIndex } = d;
    const n = tops.length;
    const lift = heights[startIndex] + GAP_PX;
    const draggedCenter = tops[startIndex] + heights[startIndex] / 2 + dy;

    let target = startIndex;
    while (target > 0 && draggedCenter < tops[target - 1] + heights[target - 1] / 2) target--;
    while (
      target < n - 1 &&
      draggedCenter > tops[target + 1] + heights[target + 1] / 2
    )
      target++;

    if (target !== d.currentIndex) {
      d.currentIndex = target;
      if ("vibrate" in navigator) navigator.vibrate?.(5);
    }

    for (let j = 0; j < n; j++) {
      const el = rowRefs.current[j];
      if (!el) continue;
      if (j === startIndex) {
        el.style.transform = `translateY(${dy}px)`;
        continue;
      }
      let shift = 0;
      if (startIndex < target && j > startIndex && j <= target) shift = -lift;
      else if (startIndex > target && j >= target && j < startIndex) shift = lift;
      el.style.transform = shift ? `translateY(${shift}px)` : "";
    }
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRaf.current != null) {
      cancelAnimationFrame(autoScrollRaf.current);
      autoScrollRaf.current = null;
    }
  }, []);

  const autoScrollTick = useCallback(() => {
    if (!drag.current) return;
    const y = lastClientY.current;
    const h = window.innerHeight;
    let dv = 0;
    if (y < EDGE_PX) dv = -Math.ceil(((EDGE_PX - y) / EDGE_PX) * EDGE_MAX_SPEED);
    else if (y > h - EDGE_PX)
      dv = Math.ceil(((y - (h - EDGE_PX)) / EDGE_PX) * EDGE_MAX_SPEED);
    if (dv !== 0) {
      window.scrollBy(0, dv);
      renderDrag();
    }
    autoScrollRaf.current = requestAnimationFrame(autoScrollTick);
  }, [renderDrag]);

  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current || e.pointerId !== drag.current.pointerId) return;
      e.preventDefault();
      lastClientY.current = e.clientY;
      renderDrag();
    },
    [renderDrag],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      stopAutoScroll();
      try {
        d.handle.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone */
      }
      for (const el of rowRefs.current) if (el) el.style.transform = "";
      drag.current = null;
      setDragIndex(null);

      const { startIndex, currentIndex } = d;
      if (currentIndex === startIndex) return;
      // Compute the new order from the live array OUTSIDE the state updater: the
      // updater must stay pure (StrictMode invokes it twice, which would double-
      // fire the reorder POST). If the list changed length mid-drag (an
      // add/remove reconciled while held), the captured indices no longer line
      // up — bail rather than commit a corrupted order.
      const cur = charts;
      if (cur.length !== d.tops.length) return;
      const next = [...cur];
      const [moved] = next.splice(startIndex, 1);
      next.splice(currentIndex, 0, moved);
      setCharts(next);
      commitOrder(next, cur);
    },
    [charts, stopAutoScroll, commitOrder],
  );

  const startDrag = useCallback(
    (e: React.PointerEvent, index: number) => {
      if (drag.current) return;
      // Reorder is a write — don't start a drag offline (the commit POST would
      // fail and snap the row back with no explanation mid-gig).
      if (!online) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const handle = e.currentTarget as HTMLElement;
      const els = rowRefs.current;
      const tops: number[] = [];
      const heights: number[] = [];
      for (const el of els) {
        if (!el) continue;
        tops.push(el.offsetTop);
        heights.push(el.offsetHeight);
      }
      handle.setPointerCapture(e.pointerId);
      lastClientY.current = e.clientY;
      drag.current = {
        pointerId: e.pointerId,
        startPageY: e.clientY + window.scrollY,
        startIndex: index,
        currentIndex: index,
        tops,
        heights,
        handle,
      };
      setDragIndex(index);
      if ("vibrate" in navigator) navigator.vibrate?.(10);
      autoScrollRaf.current = requestAnimationFrame(autoScrollTick);
    },
    [online, autoScrollTick],
  );

  // Keep the ref array sized to the current list so stale slots don't linger.
  rowRefs.current.length = charts.length;

  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <Link
          href="/charts/setlists"
          className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer hover:text-cream"
        >
          ← Setlists
        </Link>
        {renaming ? (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={nameDraft}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setNameDraft(setlist.name);
                }
              }}
              className="flex-1 border border-rule/60 bg-ink px-3 py-1.5 font-display text-xl text-cream outline-none focus:border-cat-practice/60"
            />
            <button
              onClick={saveName}
              className="border border-cat-practice/60 bg-cat-practice/10 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-kicker text-cream hover:bg-cat-practice/20"
            >
              Save
            </button>
          </div>
        ) : (
          <div className="mt-1 flex items-end justify-between gap-3">
            <h1 className="font-display text-2xl text-cream">{setlist.name}</h1>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => {
                  setNameDraft(setlist.name);
                  setRenaming(true);
                }}
                disabled={!online}
                title={!online ? "Connect to rename" : undefined}
                className="border border-rule/60 px-2.5 py-1 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-40"
              >
                Rename
              </button>
              <button
                onClick={deleteSetlist}
                disabled={!online}
                title={!online ? "Connect to delete" : undefined}
                className="border border-rule/60 px-2.5 py-1 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-music/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        )}

        {/* Offline toggle — itself a write (PUT), so disabled while offline. */}
        <label
          className={`mt-3 flex items-center gap-2 text-sm text-cream-dim ${
            online ? "cursor-pointer" : "cursor-not-allowed opacity-50"
          }`}
          title={!online ? "Connect to change offline availability" : undefined}
        >
          <input
            type="checkbox"
            checked={setlist.offline}
            onChange={toggleOffline}
            disabled={!online}
            className="h-4 w-4 accent-cat-practice"
          />
          <span>Available offline</span>
        </label>
        {offlineStatus && (
          <p
            className={`mt-1 font-mono text-[0.6rem] uppercase tracking-kicker ${
              online ? "text-cream-dimmer" : "text-cat-practice"
            }`}
          >
            {offlineStatus}
          </p>
        )}
      </header>

      {error && <p className="mb-4 text-sm text-cat-music">{error}</p>}

      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          {charts.length} chart{charts.length === 1 ? "" : "s"}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {/* Read-only — works offline, so no online gating. */}
          <button
            onClick={copySetlist}
            disabled={charts.length === 0}
            title={
              charts.length === 0
                ? "Nothing to copy yet"
                : "Copy as Song - Artist lines"
            }
            className="border border-rule/60 px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
          {!picking && (
            <button
              onClick={() => setPicking(true)}
              disabled={!online || available.length === 0}
              title={
                !online
                  ? "Connect to add charts"
                  : available.length === 0
                    ? "Every library chart is already here"
                    : undefined
              }
              className="border border-cat-practice/60 bg-cat-practice/10 px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              + Add tabs
            </button>
          )}
        </div>
      </div>

      {picking && (
        <section className="mb-6 border border-cat-practice/40 bg-ink-raised/30 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-lg text-cream">Add from library</h2>
            <button
              onClick={() => setPicking(false)}
              className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim hover:text-cream"
            >
              Done
            </button>
          </div>
          {available.length === 0 ? (
            <p className="text-sm text-cream-dim">
              Every chart in your library is already in this setlist.
            </p>
          ) : (
            <ol className="list-none space-y-2">
              {available.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 border border-rule/50 bg-ink/40 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[0.9rem] text-cream">
                      {c.title}
                    </span>
                    <span className="block truncate font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                      {c.artist ? `${c.artist} · ` : ""}
                      {lineCount(c.content)} lines
                    </span>
                  </div>
                  <button
                    aria-label={`Add ${c.title}`}
                    onClick={() => addChart(c)}
                    disabled={!online}
                    title={!online ? "Connect to add charts" : undefined}
                    className="flex h-7 shrink-0 items-center justify-center border border-cat-practice/60 bg-cat-practice/10 px-3 font-mono text-[0.65rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    + Add
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {charts.length === 0 ? (
        <p className="mt-8 text-sm text-cream-dim">
          This setlist is empty. Tap{" "}
          <span className="font-mono text-cream">+ Add tabs</span> to pull charts
          in from your library.
        </p>
      ) : (
        <ol className="list-none space-y-2">
          {charts.map((c, i) => {
            const dragging = dragIndex === i;
            return (
              <li
                key={c.id}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                style={{
                  transition: dragging
                    ? "none"
                    : "transform 180ms cubic-bezier(0.2, 0, 0, 1)",
                  zIndex: dragging ? 20 : undefined,
                  position: "relative",
                }}
                className={`flex items-center gap-1.5 border bg-ink-raised/40 px-2 py-2.5 sm:gap-2 sm:px-3 ${
                  dragging
                    ? "border-cat-practice/70 bg-ink-raised shadow-lg shadow-black/40"
                    : "border-rule/60"
                } ${dragIndex !== null && !dragging ? "opacity-90" : ""}`}
              >
                <button
                  type="button"
                  aria-label={`Drag to reorder ${c.title}`}
                  onPointerDown={(e) => startDrag(e, i)}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  disabled={!online}
                  title={!online ? "Connect to reorder" : undefined}
                  style={{ touchAction: "none" }}
                  className={`flex h-9 w-7 shrink-0 cursor-grab touch-none select-none items-center justify-center font-mono text-base text-cream-dimmer transition-colors hover:text-cat-practice active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 ${
                    dragging ? "text-cat-practice" : ""
                  }`}
                >
                  ⠿
                </button>
                <span className="w-5 shrink-0 text-right font-mono text-[0.7rem] text-cream-dimmer">
                  {i + 1}
                </span>
                <Link
                  href={`/charts/${c.id}?setlist=${setlist.id}`}
                  draggable={false}
                  className="min-w-0 flex-1"
                >
                  <span className="block truncate text-[0.95rem] text-cream hover:text-cat-practice">
                    {c.title}
                  </span>
                  <span className="block truncate font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
                    {c.artist ? `${c.artist} · ` : ""}
                    {lineCount(c.content)} lines
                  </span>
                </Link>
                <button
                  aria-label={`Remove ${c.title} from setlist`}
                  onClick={() => removeChart(c)}
                  disabled={!online}
                  title={!online ? "Connect to remove" : undefined}
                  className="flex h-7 w-7 shrink-0 items-center justify-center border border-rule/50 font-mono text-xs text-cream-dim transition-colors hover:border-cat-music/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-30"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}
