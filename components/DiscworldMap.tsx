"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DISCWORLD_EDGES,
  DISCWORLD_SEQUENCES,
  LAYOUT,
  type ManualStatus,
  type NodeKind,
  type NodeState,
  type NodeStatus,
} from "@/lib/books/discworld";

// The poster, as a pan-and-zoom map. Everything here is layout and gesture —
// the graph and the status rules live in lib/books/discworld.ts.
//
// 🔴 The zoom/pan is hand-rolled rather than pulled from a library, matching
// the drag-reorder in SetlistDetailClient and the swipe in FeedCard: the whole
// interaction is ~80 lines of pointer bookkeeping and the alternative is a
// dependency in the client bundle of a PWA that has to work at a gig.

// Geometry lives in lib/books/discworld.ts, next to the coordinates it
// describes, so check:books:discworld can assert against the same numbers the
// renderer draws with — see LAYOUT's comment there.
const { cellX: CELL_X, cellY: CELL_Y, r: R, view: VIEW } = LAYOUT;

const MIN_SCALE = 0.65;
const MAX_SCALE = 6;
/** Movement past this (screen px) is a pan, not a tap — the FeedCard rule. */
const TAP_SLOP = 6;

const KIND_COLOR: Record<NodeKind, string> = {
  starter: "#e2892c",
  standard: "#dbd07c",
  ya: "#b06aa8",
  short: "#7cb043",
  science: "#c9382e",
  illustrated: "#3fb8bd",
};

const KIND_LABEL: Record<NodeKind, string> = {
  starter: "Starter novel",
  standard: "Standard novel",
  ya: "Young adult novel",
  short: "Short story",
  science: "Science novel",
  illustrated: "Illustrated novel",
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  finished: "Read",
  reading: "Reading",
  owned: "In your library",
  absent: "Not in your library",
  skipped: "Skipped",
};

/** How much of the node's colour survives, by status. This is the progress
 *  visual: the map starts as a faint outline and fills in as it is read. */
const FILL_OPACITY: Record<NodeStatus, number> = {
  finished: 1,
  reading: 0.92,
  owned: 0.34,
  skipped: 0.16,
  absent: 0.1,
};

const px = (n: number, cell: number): number => n * cell;

// ── Label layout ─────────────────────────────────────────────────────────────

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Fit a title inside the coin. Tries progressively smaller type until the
 *  wrapped block fits the circle's height; the longest titles on the poster
 *  ("Minutes of the Meeting to Form the Proposed…") genuinely need the last
 *  rung, and the poster sets them just as small. */
function layoutLabel(title: string): { lines: string[]; size: number } {
  const rungs: Array<[maxChars: number, size: number, maxLines: number]> = [
    [10, 15, 3],
    [12, 13.5, 4],
    [14, 12, 5],
    [16, 10.5, 6],
    [18, 9, 8],
  ];
  for (const [maxChars, size, maxLines] of rungs) {
    const lines = wrap(title, maxChars);
    if (lines.length <= maxLines) return { lines, size };
  }
  return { lines: wrap(title, 18), size: 8.5 };
}

// ── Component ────────────────────────────────────────────────────────────────

type Props = {
  states: NodeState[];
  novels: { read: number; reading: number; total: number };
  all: { read: number; total: number };
  unmatched: Array<{ id: string; title: string }>;
};

export default function DiscworldMap({ states, novels, all, unmatched }: Props) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ tx: 0, ty: 0, s: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLegend, setShowLegend] = useState(false);

  const byId = useMemo(() => new Map(states.map((s) => [s.node.id, s])), [states]);
  const selectedState = selected ? byId.get(selected) ?? null : null;

  // ── Gesture bookkeeping ────────────────────────────────────────────────────
  // Refs, not state: a setState per pointermove would re-render 60 nodes at
  // 60Hz. Only `view` is state, and it is written once per frame's worth of
  // movement anyway.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panned = useRef(false);
  const pinchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  /** viewBox units per screen pixel, given preserveAspectRatio="meet". */
  const fitScale = useCallback((): number => {
    const el = wrapRef.current;
    if (!el) return 1;
    const r = el.getBoundingClientRect();
    return Math.min(r.width / VIEW.w, r.height / VIEW.h) || 1;
  }, []);

  /** A client point in viewBox coordinates (before the pan/zoom transform). */
  const toViewBox = useCallback((clientX: number, clientY: number) => {
    const el = wrapRef.current;
    if (!el) return { vx: 0, vy: 0 };
    const r = el.getBoundingClientRect();
    const f = Math.min(r.width / VIEW.w, r.height / VIEW.h) || 1;
    const offX = (r.width - VIEW.w * f) / 2;
    const offY = (r.height - VIEW.h * f) / 2;
    return {
      vx: (clientX - r.left - offX) / f + VIEW.x,
      vy: (clientY - r.top - offY) / f + VIEW.y,
    };
  }, []);

  /** Zoom to `nextScale`, keeping the content under (clientX, clientY) put. */
  const zoomAt = useCallback(
    (nextScale: number, clientX: number, clientY: number) => {
      setView((v) => {
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
        const { vx, vy } = toViewBox(clientX, clientY);
        const cx = (vx - v.tx) / v.s;
        const cy = (vy - v.ty) / v.s;
        return { s, tx: vx - cx * s, ty: vy - cy * s };
      });
    },
    [toViewBox],
  );

  const zoomCentre = useCallback(
    (factor: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setView((v) => {
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.s * factor));
        const { vx, vy } = toViewBox(r.left + r.width / 2, r.top + r.height / 2);
        const cx = (vx - v.tx) / v.s;
        const cy = (vy - v.ty) / v.s;
        return { s, tx: vx - cx * s, ty: vy - cy * s };
      });
    },
    [toViewBox],
  );

  const fit = useCallback(() => setView({ tx: 0, ty: 0, s: 1 }), []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) panned.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      panned.current = true;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const start = pinchRef.current;
      if (start && start.dist > 0) {
        setView((v) => {
          const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.s * (dist / start.dist)));
          const { vx, vy } = toViewBox(cx, cy);
          const ccx = (vx - v.tx) / v.s;
          const ccy = (vy - v.ty) / v.s;
          return { s, tx: vx - ccx * s, ty: vy - ccy * s };
        });
      }
      pinchRef.current = { dist, cx, cy };
      return;
    }

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) panned.current = true;
    const f = fitScale();
    setView((v) => ({ ...v, tx: v.tx + dx / f, ty: v.ty + dy / f }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;

    // 🔴 Selection is a hit test here, NOT an onClick on the coin. The pan
    // needs setPointerCapture to survive the finger leaving the element, and
    // capture retargets the synthesised click to the CAPTURE element — so a
    // click handler on the <g> fires unreliably or not at all. Reading the
    // element under the released pointer is the version that always works.
    if (!wasSingle || panned.current) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const group = hit?.closest?.("[data-node-id]") as SVGElement | null;
    const id = group?.getAttribute("data-node-id") ?? null;
    setSelected((cur) => (id == null ? null : cur === id ? null : id));
  };

  // The live view, for listeners that must not be rebound on every pan frame.
  const viewRef = useRef(view);
  viewRef.current = view;

  // Wheel has to be a non-passive native listener: React's onWheel is passive
  // in React 18, so preventDefault() there is ignored and the page scrolls
  // behind the map while you are trying to zoom it.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel; a plain two-finger scroll should
      // pan, which is what it does everywhere else on macOS.
      if (e.ctrlKey || e.metaKey) {
        zoomAt(viewRef.current.s * Math.exp(-e.deltaY / 220), e.clientX, e.clientY);
      } else {
        const f = fitScale();
        setView((v) => ({ ...v, tx: v.tx - e.deltaX / f, ty: v.ty - e.deltaY / f }));
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoomAt, fitScale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") zoomCentre(1.25);
      else if (e.key === "-" || e.key === "_") zoomCentre(0.8);
      else if (e.key === "0") fit();
      else if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomCentre, fit]);

  // ── Marking ────────────────────────────────────────────────────────────────

  async function mark(nodeId: string, status: ManualStatus | null) {
    setBusy(true);
    try {
      const res = await fetch(`/api/books/discworld/${nodeId}`, {
        method: status ? "POST" : "DELETE",
        headers: status ? { "Content-Type": "application/json" } : undefined,
        body: status ? JSON.stringify({ status }) : undefined,
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      // Nothing optimistic to roll back — the sheet keeps showing the old
      // state, which is the truth until the server says otherwise.
    } finally {
      setBusy(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const pct = novels.total > 0 ? Math.round((novels.read / novels.total) * 100) : 0;

  return (
    <div>
      <div className="mb-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
            {novels.read} of {novels.total} novels
            {novels.reading > 0 && ` · ${novels.reading} in progress`}
          </p>
          <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
            {pct}%
          </p>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden bg-rule/40">
          <div
            className="h-full bg-accent transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1.5 text-[0.78rem] text-cream-dimmer">
          {all.read} of {all.total} works on the guide, counting the short stories, science books
          and companion volumes.
        </p>
      </div>

      <div className="relative border border-rule/60 bg-ink-raised/30">
        <div
          ref={wrapRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => zoomAt(viewRef.current.s * 1.6, e.clientX, e.clientY)}
          className="h-[65vh] max-h-[820px] min-h-[380px] w-full cursor-grab touch-none select-none active:cursor-grabbing"
        >
          <svg
            viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
            preserveAspectRatio="xMidYMid meet"
            className="h-full w-full"
            role="img"
            aria-label="The Discworld reading order, as a map"
          >
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
              {/* Connections first so the coins sit on top of them. */}
              <g>
                {DISCWORLD_EDGES.map((e) => {
                  const a = byId.get(e.from)?.node;
                  const b = byId.get(e.to)?.node;
                  if (!a || !b) return null;
                  const both =
                    byId.get(e.from)?.status === "finished" &&
                    byId.get(e.to)?.status === "finished";
                  return (
                    <line
                      key={`${e.from}-${e.to}`}
                      x1={px(a.x, CELL_X)}
                      y1={px(a.y, CELL_Y)}
                      x2={px(b.x, CELL_X)}
                      y2={px(b.y, CELL_Y)}
                      stroke="#b4342a"
                      strokeWidth={e.kind === "direct" ? 4 : 3}
                      strokeLinecap="round"
                      strokeDasharray={e.kind === "direct" ? undefined : "1 12"}
                      opacity={both ? 0.95 : e.kind === "direct" ? 0.5 : 0.38}
                    />
                  );
                })}
              </g>

              {/* Sequence names, in the poster's hand. */}
              <g className="font-display">
                {DISCWORLD_SEQUENCES.map((s) => (
                  <text
                    key={s.key}
                    textAnchor={s.anchor}
                    className="fill-cream-dim"
                    fontSize={LAYOUT.labelSize}
                    letterSpacing="2"
                  >
                    {s.lines.map((line, i) => (
                      <tspan
                        key={i}
                        x={px(s.x, CELL_X)}
                        y={
                          px(s.y, CELL_Y) +
                          (i - (s.lines.length - 1) / 2) * LAYOUT.labelLineHeight +
                          LAYOUT.labelSize * 0.34
                        }
                      >
                        {line.toUpperCase()}
                      </tspan>
                    ))}
                  </text>
                ))}
              </g>

              {/* Coins. */}
              <g>
                {states.map((st) => (
                  <Coin
                    key={st.node.id}
                    state={st}
                    selected={selected === st.node.id}
                    onSelect={() => setSelected((cur) => (cur === st.node.id ? null : st.node.id))}
                  />
                ))}
              </g>
            </g>
          </svg>
        </div>

        {/* Controls. Always visible, never hover-revealed — the BooksClient
            star rule: a hover-only control is unreachable on the phone. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2">
          <button
            onClick={() => setShowLegend((v) => !v)}
            className="pointer-events-auto border border-rule/60 bg-ink/85 px-2 py-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
          >
            {showLegend ? "Hide key" : "Key"}
          </button>
          <div className="pointer-events-auto flex items-center gap-1">
            <ZoomButton label="Zoom out" onClick={() => zoomCentre(0.8)}>
              −
            </ZoomButton>
            <button
              onClick={fit}
              className="border border-rule/60 bg-ink/85 px-2 py-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
            >
              Fit
            </button>
            <ZoomButton label="Zoom in" onClick={() => zoomCentre(1.25)}>
              +
            </ZoomButton>
          </div>
        </div>

        {showLegend && (
          <div className="pointer-events-none absolute inset-x-0 bottom-12 px-2">
            <div className="pointer-events-auto border border-rule/60 bg-ink/95 p-3">
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                {(Object.keys(KIND_COLOR) as NodeKind[]).map((k) => (
                  <li key={k} className="flex items-center gap-2 text-[0.75rem] text-cream-dim">
                    <span
                      className="inline-block h-3 w-3 shrink-0 rounded-full"
                      style={{ background: KIND_COLOR[k] }}
                    />
                    {KIND_LABEL[k]}
                  </li>
                ))}
              </ul>
              <p className="mt-2 border-t border-rule/40 pt-2 text-[0.72rem] leading-relaxed text-cream-dimmer">
                A solid line is a direct connection, a dotted one is minor. Full colour means read,
                a ring means in progress, a faded coin means the book isn&apos;t in your library
                yet. Drag to pan, pinch or ctrl-scroll to zoom, tap a book to mark it.
              </p>
            </div>
          </div>
        )}
      </div>

      {unmatched.length > 0 && (
        <p className="mt-3 border-l-2 border-accent/60 pl-3 text-[0.78rem] text-cream-dim">
          {unmatched.length} Discworld book{unmatched.length === 1 ? "" : "s"} in your library
          {unmatched.length === 1 ? " isn't" : " aren't"} on this map:{" "}
          {unmatched.map((b) => b.title).join(", ")}. Its title and series number don&apos;t match
          any node, so the map can&apos;t see your progress on it.
        </p>
      )}

      {selectedState && (
        <NodeSheet
          state={selectedState}
          busy={busy}
          onClose={() => setSelected(null)}
          onMark={(s) => mark(selectedState.node.id, s)}
        />
      )}
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center border border-rule/60 bg-ink/85 font-mono text-sm text-cream-dim hover:text-accent"
    >
      {children}
    </button>
  );
}

// ── One coin ─────────────────────────────────────────────────────────────────

function Coin({
  state,
  selected,
  onSelect,
}: {
  state: NodeState;
  selected: boolean;
  onSelect: () => void;
}) {
  const { node, status } = state;
  const cx = px(node.x, CELL_X);
  const cy = px(node.y, CELL_Y);
  const colour = KIND_COLOR[node.kind];
  const { lines, size } = useMemo(() => layoutLabel(node.title), [node.title]);
  const faded = status === "absent" || status === "skipped";
  const circumference = 2 * Math.PI * (R + 7);

  return (
    <g
      data-node-id={node.id}
      className="cursor-pointer focus:outline-none"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-label={`${node.title} — ${STATUS_LABEL[status]}`}
    >
      <circle
        cx={cx}
        cy={cy}
        r={R}
        fill={colour}
        fillOpacity={FILL_OPACITY[status]}
        stroke={colour}
        strokeOpacity={faded ? 0.45 : 0.9}
        strokeWidth={3}
        strokeDasharray={status === "owned" ? "7 5" : undefined}
      />

      {/* In-progress ring: the actual sync percentage, drawn from the top. */}
      {status === "reading" && state.percentage != null && (
        <circle
          cx={cx}
          cy={cy}
          r={R + 7}
          fill="none"
          stroke="#f2c14e"
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={`${circumference * Math.max(0.02, state.percentage)} ${circumference}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      )}

      {selected && (
        <circle
          cx={cx}
          cy={cy}
          r={R + 13}
          fill="none"
          className="stroke-accent"
          strokeWidth={3}
        />
      )}

      <text
        textAnchor="middle"
        className={`font-display ${faded ? "fill-cream" : ""}`}
        fill={faded ? undefined : "#17130f"}
        fontSize={size}
        style={{ pointerEvents: "none" }}
      >
        {lines.map((line, i) => (
          <tspan key={i} x={cx} y={cy + (i - (lines.length - 1) / 2) * (size * 1.18) + size * 0.35}>
            {line}
          </tspan>
        ))}
      </text>

      {status === "finished" && (
        <g style={{ pointerEvents: "none" }}>
          <circle cx={cx + R * 0.72} cy={cy - R * 0.72} r={17} fill="#17130f" />
          <path
            d={`M ${cx + R * 0.72 - 7} ${cy - R * 0.72} l 5 5 l 9 -10`}
            fill="none"
            stroke="#7cd06a"
            strokeWidth={3.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}

      {status === "skipped" && (
        <line
          x1={cx - R * 0.7}
          y1={cy + R * 0.7}
          x2={cx + R * 0.7}
          y2={cy - R * 0.7}
          stroke={colour}
          strokeOpacity={0.95}
          strokeWidth={5}
          style={{ pointerEvents: "none" }}
        />
      )}

      {/* The reader's own mark, called out. Anything the sync didn't decide
          should say so — the map is otherwise indistinguishable from evidence. */}
      {state.manual && (
        <circle
          cx={cx - R * 0.72}
          cy={cy - R * 0.72}
          r={6}
          className="fill-accent"
          style={{ pointerEvents: "none" }}
        />
      )}
    </g>
  );
}

// ── The detail sheet ─────────────────────────────────────────────────────────

function NodeSheet({
  state,
  busy,
  onClose,
  onMark,
}: {
  state: NodeState;
  busy: boolean;
  onClose: () => void;
  onMark: (status: ManualStatus | null) => void;
}) {
  const { node, status, auto, manual } = state;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 animate-slide-up px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-[560px] border border-rule bg-ink shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b border-rule/60 px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
              {KIND_LABEL[node.kind]}
              {node.pubOrder != null && ` · #${node.pubOrder}`} · {node.year}
            </p>
            <h2 className="mt-0.5 font-display text-lg leading-tight text-cream">{node.title}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 font-mono text-sm text-cream-dimmer hover:text-accent"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-3 text-sm">
          <p className="text-cream-dim">
            <span
              className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
              style={{ background: KIND_COLOR[node.kind], opacity: FILL_OPACITY[status] + 0.2 }}
            />
            {STATUS_LABEL[status]}
            {state.percentage != null && status !== "finished" && (
              <span className="text-cream-dimmer"> · {Math.round(state.percentage * 100)}%</span>
            )}
          </p>

          {/* Honesty carry: when the reader's mark and the sync disagree, say
              so plainly rather than quietly showing only the winner. */}
          {manual && (
            <p className="mt-1 text-[0.78rem] text-cream-dimmer">
              Marked by hand
              {auto !== "absent" && auto !== resolvedAuto(manual) && (
                <> · your library says &ldquo;{STATUS_LABEL[auto].toLowerCase()}&rdquo;</>
              )}
            </p>
          )}
          {!manual && status === "finished" && (
            <p className="mt-1 text-[0.78rem] text-cream-dimmer">From your reading sync.</p>
          )}
          {!manual && status === "absent" && (
            <p className="mt-1 text-[0.78rem] text-cream-dimmer">
              Nothing in the library matches this one, so the sync can&apos;t track it. Mark it read
              if you read it elsewhere.
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <SheetButton
              active={manual === "read"}
              disabled={busy}
              onClick={() => onMark(manual === "read" ? null : "read")}
            >
              {manual === "read" ? "✓ Read" : "Mark read"}
            </SheetButton>
            <SheetButton
              active={manual === "reading"}
              disabled={busy}
              onClick={() => onMark(manual === "reading" ? null : "reading")}
            >
              {manual === "reading" ? "✓ Reading" : "Mark reading"}
            </SheetButton>
            <SheetButton
              active={manual === "skipped"}
              disabled={busy}
              onClick={() => onMark(manual === "skipped" ? null : "skipped")}
            >
              {manual === "skipped" ? "✓ Skipped" : "Skip"}
            </SheetButton>
            {manual && (
              <SheetButton active={false} disabled={busy} onClick={() => onMark(null)}>
                Clear mark
              </SheetButton>
            )}
          </div>

          {state.bookId && (
            <Link
              href={`/books/${state.bookId}`}
              className="mt-3 inline-block font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:underline"
            >
              Open in library →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/** The auto status a given manual mark claims, so the sheet can tell the
 *  reader when the two disagree instead of silently preferring one. */
function resolvedAuto(manual: ManualStatus): NodeStatus {
  return manual === "read" ? "finished" : manual === "reading" ? "reading" : "skipped";
}

function SheetButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`border px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors disabled:opacity-50 ${
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-rule/60 text-cream-dim hover:border-accent/60 hover:text-accent"
      }`}
    >
      {children}
    </button>
  );
}
