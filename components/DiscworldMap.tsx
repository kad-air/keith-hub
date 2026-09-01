"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DISCWORLD_EDGES,
  DISCWORLD_SEQUENCES,
  LAYOUT,
  seqArrowSpan,
  trimEdge,
  type ManualStatus,
  type NodeKind,
  type NodeState,
  type NodeStatus,
} from "@/lib/books/discworld";

// The poster, as a pan-and-zoom map. Everything here is layout and gesture —
// the graph and the status rules live in lib/books/discworld.ts.
//
// Styled to the "parchment" design (Claude Design → Discworld Map.dc.html):
// glossy rimmed coins, red arrows trimmed to the rims, wax-seal read badges,
// fantasy display type, and a candlelit "parchment at night" variant for the
// dark theme. 🔴 The two variants are ONE implementation — every colour and
// opacity that differs between them is a --dw-* CSS variable defined per theme
// in globals.css. There is no theme branch in this file, so the Auto setting
// works with no JS and nothing can hydrate wrong.
//
// 🔴 The zoom/pan is hand-rolled rather than pulled from a library, matching
// the drag-reorder in SetlistDetailClient and the swipe in FeedCard.

const { cellX: CELL_X, cellY: CELL_Y, r: R, view: VIEW, seqShift: SEQ_SHIFT } = LAYOUT;

/** Layer-pixel offset of the SVG's origin: the layer is 1900×1440 starting at
 *  0,0 while the SVG's viewBox starts at (-400, -110), so an SVG point X sits
 *  at layer pixel X + OX. The HTML label overlay is positioned in layer
 *  pixels, which is what makes these necessary. */
const OX = -VIEW.x;
const OY = -VIEW.y;

const MIN_SCALE = 0.6;
const MAX_SCALE = 6;
/** Movement past this (screen px) is a pan, not a tap — the FeedCard rule. */
const TAP_SLOP = 6;
/** Degrees of hand-pinned wobble on each coin. Deterministic (derived from the
 *  node's index), never random — a random tilt would differ between the server
 *  render and the client one. */
const WOBBLE = 3;
const BURST_MS = 850;

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

/** How much of the coin's colour survives, by status — the progress visual.
 *  Values differ per theme (an unlit coin sinks into the vellum at night, a
 *  pale one sits on the parchment by day), so they are variables, not numbers. */
const FILL_VAR: Record<NodeStatus, string> = {
  finished: "var(--dw-fill-finished)",
  reading: "var(--dw-fill-reading)",
  owned: "var(--dw-fill-owned)",
  absent: "var(--dw-fill-absent)",
  skipped: "var(--dw-fill-skipped)",
};

const GLOW_VAR: Record<NodeStatus, string> = {
  finished: "var(--dw-glow-finished)",
  reading: "var(--dw-glow-reading)",
  owned: "0",
  absent: "0",
  skipped: "0",
};

const px = (n: number, cell: number): number => n * cell;

// ── Ageing ───────────────────────────────────────────────────────────────────
// The overlay that makes the sheet read as OLD rather than merely beige. It
// lives INSIDE the pan/zoom layer (unlike the candle wash, which is a viewport
// effect) and multiplies over the finished drawing, so the stains move with
// the paper and tint the coins and the ink — the map reads as printed on an
// aged sheet instead of floating above a tinted rectangle. Colours are
// deliberately theme-independent: multiply darkens correctly on both
// parchments, and only the layer's opacity differs (--dw-age-op).

/** Three stacked turbulence passes in one tile: broad mottling of the vellum
 *  tone, sparse foxing blotches (high-contrast alpha threshold, so they come
 *  out as organic spots rather than fog), and a faint directional fibre grain
 *  (anisotropic base frequency — parchment has a grain direction). */
const AGE_TEXTURE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='640'%3E%3Cfilter id='m'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.006 0.008' numOctaves='5' seed='9' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.33 0 0 0 0 0.22 0 0 0 0 0.10 0 0 0 0.55 -0.12'/%3E%3C/filter%3E%3Cfilter id='x'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.016 0.02' numOctaves='4' seed='4' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.45 0 0 0 0 0.26 0 0 0 0 0.08 0 0 0 1.7 -0.95'/%3E%3C/filter%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9 0.28' numOctaves='2' seed='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.36 0 0 0 0 0.26 0 0 0 0 0.13 0 0 0 0.26 -0.06'/%3E%3C/filter%3E%3Crect width='640' height='640' filter='url(%23m)'/%3E%3Crect width='640' height='640' filter='url(%23x)'/%3E%3Crect width='640' height='640' filter='url(%23g)'/%3E%3C/svg%3E")`;

/** Fixed one-off stains — two water rings (the tell-tale dried-tide edge, dark
 *  rim around a paler centre), two soft blots, one faint third ring. Placed by
 *  hand at spots that avoid sitting dead-centre on any coin cluster. */
const AGE_STAINS = [
  "radial-gradient(closest-side, transparent 55%, rgba(101,66,24,0.20) 62%, rgba(101,66,24,0.08) 66%, transparent 72%)",
  "radial-gradient(closest-side, transparent 58%, rgba(101,66,24,0.16) 65%, transparent 71%)",
  "radial-gradient(closest-side, rgba(94,58,20,0.13), rgba(94,58,20,0.05) 55%, transparent 75%)",
  "radial-gradient(closest-side, rgba(94,58,20,0.11), transparent 70%)",
  "radial-gradient(closest-side, transparent 60%, rgba(101,66,24,0.10) 68%, transparent 74%)",
].join(", ");

/** How far the ageing layer extends past the poster on every side, in layer
 *  px. Must cover the container at MIN_SCALE: the widest visible span is
 *  container / (base × MIN_SCALE) ≈ 1280 / 0.26 ≈ 4900 layer px against the
 *  poster's 1900, i.e. ~1500 px of backdrop each side. 2400 leaves margin. */
const AGE_OVERHANG = 2400;

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

/** Type size for a coin's title. The wrapping itself is left to the browser
 *  (`text-wrap: balance` on a real HTML box beats anything hand-broken into
 *  <tspan>s) — this only picks the size the wrapped block will fit at. */
function labelSize(title: string): number {
  const rungs: Array<[maxChars: number, size: number, maxLines: number]> = [
    [10, 15, 3],
    [12, 13.5, 4],
    [14, 12, 5],
    [16, 10.5, 6],
    [18, 9, 8],
  ];
  for (const [maxChars, size, maxLines] of rungs) {
    if (wrap(title, maxChars).length <= maxLines) return size;
  }
  return 8.5;
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
  const [baseScale, setBaseScale] = useState(0.55);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [burst, setBurst] = useState<string | null>(null);

  const byId = useMemo(() => new Map(states.map((s) => [s.node.id, s])), [states]);
  const selectedState = selected ? byId.get(selected) ?? null : null;

  const viewRef = useRef(view);
  viewRef.current = view;
  const baseRef = useRef(baseScale);
  baseRef.current = baseScale;
  /** True while the view is exactly where "Fit" put it, so a resize can re-fit
   *  instead of stranding a map the reader never moved. */
  const pristine = useRef(true);

  /** Centre the whole poster in the viewport at base scale. */
  const fitTo = useCallback((base: number): { tx: number; ty: number; s: number } => {
    const el = wrapRef.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    return { tx: (w - VIEW.w * base) / 2, ty: (h - VIEW.h * base) / 2, s: 1 };
  }, []);

  const fit = useCallback(() => {
    pristine.current = true;
    setView(fitTo(baseRef.current));
  }, [fitTo]);

  // Base scale is "the whole poster just fits", measured from the box rather
  // than hardcoded, so the map frames itself the same way on a phone and on a
  // desktop. Re-fits on resize only while the reader hasn't moved the view.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const base = Math.min(w / VIEW.w, h / VIEW.h);
      baseRef.current = base;
      setBaseScale(base);
      if (pristine.current) setView(fitTo(base));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitTo]);

  // ── Gesture bookkeeping ────────────────────────────────────────────────────
  // Refs, not state: a setState per pointermove would re-render 55 coins at
  // 60Hz. Only `view` is state, written once per frame's worth of movement.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panned = useRef(false);
  const pinchRef = useRef<{ dist: number } | null>(null);

  /** Zoom to `nextScale`, keeping the content under (clientX, clientY) put.
   *  The layer transform is `translate(tx,ty) scale(base*s)` from origin 0 0,
   *  so tx/ty are plain screen pixels and the arithmetic is direct. */
  const zoomAt = useCallback((nextScale: number, clientX: number, clientY: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    pristine.current = false;
    setView((v) => {
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
      const k = baseRef.current * v.s;
      const k2 = baseRef.current * s;
      const lx = (clientX - r.left - v.tx) / k;
      const ly = (clientY - r.top - v.ty) / k;
      return { s, tx: clientX - r.left - lx * k2, ty: clientY - r.top - ly * k2 };
    });
  }, []);

  const zoomCentre = useCallback(
    (factor: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      zoomAt(viewRef.current.s * factor, r.left + r.width / 2, r.top + r.height / 2);
    },
    [zoomAt],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) panned.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
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
      const start = pinchRef.current;
      if (start && start.dist > 0) {
        zoomAt(viewRef.current.s * (dist / start.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      pinchRef.current = { dist };
      return;
    }

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) panned.current = true;
    pristine.current = false;
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
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
        pristine.current = false;
        setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoomAt]);

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

  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (burstTimer.current) clearTimeout(burstTimer.current);
  }, []);

  async function mark(nodeId: string, status: ManualStatus | null) {
    setBusy(true);
    try {
      const res = await fetch(`/api/books/discworld/${nodeId}`, {
        method: status ? "POST" : "DELETE",
        headers: status ? { "Content-Type": "application/json" } : undefined,
        body: status ? JSON.stringify({ status }) : undefined,
      });
      if (!res.ok) throw new Error(String(res.status));
      if (status === "read") {
        setBurst(nodeId);
        if (burstTimer.current) clearTimeout(burstTimer.current);
        burstTimer.current = setTimeout(() => setBurst(null), BURST_MS);
      }
      router.refresh();
    } catch {
      // Nothing optimistic to roll back — the sheet keeps showing the old
      // state, which is the truth until the server says otherwise.
    } finally {
      setBusy(false);
    }
  }

  // ── Derived drawing data ───────────────────────────────────────────────────

  /** Connections, trimmed back to the coin rims so the arrowhead lands on the
   *  edge instead of under the next coin, and bowed slightly for minor links.
   *  🔴 The trims are scaled down when an edge is shorter than they are: the
   *  closest pair on the poster sits 129 units apart against a 132-unit trim,
   *  which without this makes the arrow point BACKWARDS. Asserted by
   *  check:books:discworld. */
  const edges = useMemo(
    () =>
      DISCWORLD_EDGES.map((e, i) => {
        const a = byId.get(e.from)?.node;
        const b = byId.get(e.to)?.node;
        if (!a || !b) return null;
        const x1 = px(a.x, CELL_X);
        const y1 = px(a.y, CELL_Y);
        const x2 = px(b.x, CELL_X);
        const y2 = px(b.y, CELL_Y);
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const ux = (x2 - x1) / len;
        const uy = (y2 - y1) / len;
        // Shared with check:books:discworld — see trimEdge's comment for why
        // the trims have to be clamped at all.
        const { sx, sy, ex, ey } = trimEdge(x1, y1, x2, y2);
        const bow = e.kind === "direct" ? 0 : (i % 2 ? 1 : -1) * 16;
        const mx = (sx + ex) / 2 - uy * bow;
        const my = (sy + ey) / 2 + ux * bow;
        // A second, fainter pass of the same stroke on a slightly different
        // bow — the pen retracing its line. This is the hand-inked look done
        // CHEAPLY: an feTurbulence+feDisplacementMap roughen was considered
        // and rejected, because a displacement filter over the whole edge
        // layer re-rasterises ~1900×1440 units on paint and janks pinch-zoom
        // on the phone, which is the primary device.
        const bow2 = bow + (i % 2 ? -7 : 7);
        const mx2 = (sx + ex) / 2 - uy * bow2;
        const my2 = (sy + ey) / 2 + ux * bow2;
        const both =
          byId.get(e.from)?.status === "finished" && byId.get(e.to)?.status === "finished";
        return {
          key: `${e.from}-${e.to}`,
          d: `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
          d2: `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx2.toFixed(1)} ${my2.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
          // Deterministic per-edge width jitter — an inked line is never one
          // uniform weight across a whole sheet.
          w: (e.kind === "direct" ? 5.5 : 4.5) + (((i * 13) % 3) - 1) * 0.4,
          dash: e.kind === "direct" ? undefined : "0.1 15",
          op: both ? 1 : e.kind === "direct" ? 0.78 : 0.62,
        };
      }).filter((e): e is NonNullable<typeof e> => e != null),
    [byId],
  );

  /** One short arrow from each margin label into the row it names. */
  const seqArrows = useMemo(() => {
    const out: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = [];
    for (const s of DISCWORLD_SEQUENCES) {
      if (s.anchor !== "end") continue;
      const X = px(s.x, CELL_X) - SEQ_SHIFT;
      const Y = px(s.y, CELL_Y);
      const row = states
        .map((st) => st.node)
        .filter((n) => Math.abs(px(n.y, CELL_Y) - Y) < 2 && px(n.x, CELL_X) > X);
      if (!row.length) continue;
      const first = Math.min(...row.map((n) => n.x));
      const { x1, x2, drawn } = seqArrowSpan(s, first);
      if (!drawn) continue;
      out.push({ key: s.key, x1, y1: Y, x2, y2: Y });
    }
    return out;
  }, [states]);

  const pct = novels.total > 0 ? Math.round((novels.read / novels.total) * 100) : 0;

  return (
    <div>
      {/* ── Progress ─────────────────────────────────────────────────────── */}
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p
            className="font-fantasy-sc text-[1rem] tracking-[0.06em]"
            style={{ color: "var(--dw-heading)" }}
          >
            {novels.read} of {novels.total} novels
            {novels.reading > 0 && ` · ${novels.reading} in progress`}
          </p>
          <span
            className="rounded-[3px] px-2 py-0.5 font-mono text-[0.68rem] tracking-[0.1em]"
            style={{ background: "var(--dw-pct-bg)", color: "var(--dw-pct-fg)" }}
          >
            {pct}%
          </span>
        </div>
        <div
          className="relative mt-2 h-[15px] rounded-[3px] border"
          style={{
            background: "var(--dw-bar-track)",
            borderColor: "var(--dw-bar-track-border)",
            boxShadow: "var(--dw-bar-track-inset)",
          }}
        >
          <div
            className="absolute left-0 top-0 h-full rounded-[3px] transition-[width] duration-500"
            style={{
              width: `${Math.max(pct, 2)}%`,
              background: "var(--dw-bar-fill)",
              boxShadow: "var(--dw-bar-fill-shadow)",
            }}
          >
            {/* The knob rides the end of the bar and bobs — the one flourish
                that reads as "there is further to go" at a glance. */}
            <div
              className="absolute -right-[13px] -top-[6px] h-[26px] w-[26px] rounded-full border-2"
              style={{
                background: "var(--dw-bar-knob)",
                borderColor: "var(--dw-bar-knob-border)",
                boxShadow: "var(--dw-bar-knob-shadow)",
                animation: "dw-bob 2.8s ease-in-out infinite",
              }}
            />
          </div>
        </div>
        <p className="mt-2 text-[0.82rem] text-cream-dimmer">
          {all.read} of {all.total} works on the guide, counting the short stories, science books
          and companion volumes.
        </p>
      </div>

      {/* ── The map ──────────────────────────────────────────────────────── */}
      <div
        className="relative overflow-hidden rounded"
        style={{
          background: "var(--dw-surface-bg)",
          border: "1px solid var(--dw-surface-border)",
          boxShadow: "var(--dw-surface-inset)",
        }}
      >
        {/* Candle-light / edge burn. Purely a wash, never intercepts a tap.
            dw-flicker breathes its opacity like a real flame — the amplitude
            vars are 1 in the light theme, so daylight parchment stays still
            with no theme branch here. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: "var(--dw-surface-wash)",
            opacity: "var(--dw-surface-wash-op)" as unknown as number,
            animation: "dw-flicker 6.8s ease-in-out infinite",
          }}
        />

        <div
          ref={wrapRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => zoomAt(viewRef.current.s * 1.6, e.clientX, e.clientY)}
          className="relative h-[68vh] max-h-[820px] min-h-[400px] w-full cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing"
        >
          {/* 🔴 One transformed layer holding BOTH the SVG and an HTML text
              overlay. The titles are real HTML so they get `text-wrap: balance`
              and the browser's own line breaking — markedly better than hand-
              broken <tspan>s — and putting the pan/zoom on this wrapper rather
              than on an SVG <g> keeps the two perfectly in register. */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: `${VIEW.w}px`,
              height: `${VIEW.h}px`,
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${baseScale * view.s})`,
              transformOrigin: "0 0",
            }}
          >
            <svg
              width={VIEW.w}
              height={VIEW.h}
              viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
              className="absolute left-0 top-0 overflow-visible"
              role="img"
              aria-label="The Discworld reading order, as a map"
            >
              <defs>
                <marker
                  id="dw-arrowhead"
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="3.4"
                  markerHeight="3.4"
                  orient="auto-start-reverse"
                >
                  <path d="M 0.5 1.2 L 9 5 L 0.5 8.8 z" style={{ fill: "var(--dw-arrow)" }} />
                </marker>
                {/* Wax shading: a lit crown falling away to a dark edge. The
                    stops read theme vars, so night wax and day wax stay one
                    implementation. objectBoundingBox units, so the same
                    gradient shades the blob and each drip independently. */}
                <radialGradient id="dw-seal-grad" cx="0.36" cy="0.3" r="0.75">
                  <stop offset="0" style={{ stopColor: "var(--dw-seal-hi)" }} />
                  <stop offset="0.55" style={{ stopColor: "var(--dw-seal-fill)" }} />
                  <stop offset="1" style={{ stopColor: "var(--dw-seal-lo)" }} />
                </radialGradient>
                {/* Coin curvature: one gradient does the dome — a soft light
                    on the crown, a falling-away darkening at the edge. Stop
                    colours are theme-independent; only the overlay's opacity
                    differs per theme (--dw-dome-op). */}
                <radialGradient id="dw-coin-dome" cx="0.38" cy="0.3" r="0.85">
                  <stop offset="0" stopColor="#fffbe8" stopOpacity="0.3" />
                  <stop offset="0.42" stopColor="#fffbe8" stopOpacity="0" />
                  <stop offset="0.78" stopColor="#2b1608" stopOpacity="0" />
                  <stop offset="1" stopColor="#2b1608" stopOpacity="0.38" />
                </radialGradient>
              </defs>

              {/* Connections, under the coins. Each is two passes: the faint
                  retrace first, then the main stroke with the arrowhead. */}
              <g>
                {edges.map((e) => (
                  <path
                    key={`${e.key}-re`}
                    d={e.d2}
                    fill="none"
                    style={{ stroke: "var(--dw-arrow)" }}
                    strokeWidth={e.w * 0.55}
                    strokeLinecap="round"
                    strokeDasharray={e.dash}
                    opacity={e.op * 0.4}
                  />
                ))}
                {edges.map((e) => (
                  <path
                    key={e.key}
                    d={e.d}
                    fill="none"
                    style={{ stroke: "var(--dw-arrow)" }}
                    strokeWidth={e.w}
                    strokeLinecap="round"
                    strokeDasharray={e.dash}
                    opacity={e.op}
                    markerEnd="url(#dw-arrowhead)"
                  />
                ))}
              </g>

              {/* Arrows from each margin label into its row — same two-pass
                  ink as the connections. */}
              <g>
                {seqArrows.map((a) => (
                  <line
                    key={`${a.key}-re`}
                    x1={a.x1}
                    y1={a.y1 + 1.5}
                    x2={a.x2 - 4}
                    y2={a.y2 + 1.5}
                    style={{ stroke: "var(--dw-arrow)" }}
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    opacity={0.35}
                  />
                ))}
                {seqArrows.map((a) => (
                  <line
                    key={a.key}
                    x1={a.x1}
                    y1={a.y1}
                    x2={a.x2}
                    y2={a.y2}
                    style={{ stroke: "var(--dw-arrow)" }}
                    strokeWidth={5}
                    strokeLinecap="round"
                    markerEnd="url(#dw-arrowhead)"
                  />
                ))}
              </g>

              <g>
                {states.map((st, i) => (
                  <Coin
                    key={st.node.id}
                    state={st}
                    index={i}
                    selected={selected === st.node.id}
                    bursting={burst === st.node.id}
                    onSelect={() => setSelected((cur) => (cur === st.node.id ? null : st.node.id))}
                  />
                ))}
              </g>
            </svg>

            {/* Titles + series names, as HTML over the SVG. */}
            <div
              className="pointer-events-none absolute left-0 top-0"
              style={{ width: `${VIEW.w}px`, height: `${VIEW.h}px` }}
            >
              {states.map((st, i) => (
                <CoinLabel key={st.node.id} state={st} index={i} />
              ))}
              {DISCWORLD_SEQUENCES.map((s) => (
                <div
                  key={s.key}
                  className="absolute flex flex-col justify-center whitespace-pre-line font-fantasy-sc"
                  style={{
                    left: `${px(s.x, CELL_X) + OX - (s.anchor === "end" ? 300 + SEQ_SHIFT : 0)}px`,
                    top: `${px(s.y, CELL_Y) + OY - 60}px`,
                    width: "300px",
                    height: "120px",
                    alignItems: s.anchor === "end" ? "flex-end" : "flex-start",
                    textAlign: s.anchor === "end" ? "right" : "left",
                    fontSize: `${LAYOUT.labelSize}px`,
                    lineHeight: 1.1,
                    letterSpacing: "0.04em",
                    color: "var(--dw-seq)",
                    textShadow: "var(--dw-seq-shadow)",
                  }}
                >
                  {s.lines.join("\n")}
                </div>
              ))}
            </div>

            {/* The ageing sheet — topmost child of the pan/zoom layer, so the
                mottling, foxing and water rings multiply over EVERYTHING
                (coins, ink, titles) and travel with the paper when you pan.
                🔴 It overhangs the poster by AGE_OVERHANG on every side: sized
                exactly to VIEW it leaves a visible seam at Fit where the aged
                rectangle meets clean surface (measured on a screenshot — the
                texture ended in a hard edge either side of the poster). The
                overhang covers the whole container even at MIN_SCALE, so the
                sheet reads as one continuous piece of parchment. The one-off
                stains are positioned in px relative to the enlarged box so
                they still land ON the poster. See AGE_TEXTURE / AGE_STAINS. */}
            <div
              className="pointer-events-none absolute"
              style={{
                left: `${-AGE_OVERHANG}px`,
                top: `${-AGE_OVERHANG}px`,
                width: `${VIEW.w + 2 * AGE_OVERHANG}px`,
                height: `${VIEW.h + 2 * AGE_OVERHANG}px`,
                mixBlendMode: "multiply",
                opacity: "var(--dw-age-op)" as unknown as number,
                backgroundImage: `${AGE_TEXTURE}, ${AGE_STAINS}`,
                backgroundRepeat: "repeat, no-repeat, no-repeat, no-repeat, no-repeat, no-repeat",
                backgroundSize:
                  "640px 640px, 360px 320px, 300px 270px, 460px 340px, 380px 300px, 520px 420px",
                backgroundPosition: [
                  "0 0",
                  `${AGE_OVERHANG + 190}px ${AGE_OVERHANG + 200}px`,
                  `${AGE_OVERHANG + 1360}px ${AGE_OVERHANG + 940}px`,
                  `${AGE_OVERHANG + 1520}px ${AGE_OVERHANG + 60}px`,
                  `${AGE_OVERHANG + 40}px ${AGE_OVERHANG + 1120}px`,
                  `${AGE_OVERHANG + 960}px ${AGE_OVERHANG + 520}px`,
                ].join(", "),
              }}
            />
          </div>
        </div>

        {/* Controls. Always visible, never hover-revealed — the BooksClient
            star rule: a hover-only control is unreachable on the phone. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3">
          <MapButton onClick={() => setShowLegend((v) => !v)}>
            {showLegend ? "Hide key" : "Key"}
          </MapButton>
          <div className="pointer-events-auto flex items-center gap-1.5">
            <MapButton square label="Zoom out" onClick={() => zoomCentre(0.8)}>
              −
            </MapButton>
            <MapButton onClick={fit}>Fit</MapButton>
            <MapButton square label="Zoom in" onClick={() => zoomCentre(1.25)}>
              +
            </MapButton>
          </div>
        </div>

        {showLegend && <Legend />}

        {selectedState && (
          <NodeSheet
            state={selectedState}
            busy={busy}
            onClose={() => setSelected(null)}
            onMark={(s) => mark(selectedState.node.id, s)}
          />
        )}
      </div>

      {unmatched.length > 0 && (
        <p
          className="mt-3 border-l-2 pl-3 text-[0.78rem] text-cream-dim"
          style={{ borderColor: "var(--dw-arrow)" }}
        >
          {unmatched.length} Discworld book{unmatched.length === 1 ? "" : "s"} in your library
          {unmatched.length === 1 ? " isn't" : " aren't"} on this map:{" "}
          {unmatched.map((b) => b.title).join(", ")}. Its title and series number don&apos;t match
          any node, so the map can&apos;t see your progress on it.
        </p>
      )}
    </div>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────────

function MapButton({
  onClick,
  children,
  square,
  label,
}: {
  onClick: () => void;
  children: React.ReactNode;
  square?: boolean;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`pointer-events-auto rounded font-fantasy-sc tracking-[0.06em] transition-colors ${
        square ? "h-[34px] w-[34px] text-[1.1rem]" : "px-3 py-[5px] text-[0.95rem]"
      }`}
      style={{
        border: "2px solid var(--dw-btn-border)",
        background: "var(--dw-btn-bg)",
        color: "var(--dw-btn-fg)",
        boxShadow: "var(--dw-btn-shadow)",
      }}
    >
      {children}
    </button>
  );
}

// ── One coin ─────────────────────────────────────────────────────────────────

/** Deterministic hand-pinned tilt: the poster's coins aren't square to the
 *  page. Derived from the index so the server and the client always agree. */
const wobbleOf = (i: number): number => ((((i * 97) % 13) - 6) / 6) * WOBBLE;

/** A lumpy closed blob for the wax seal — ten radius-perturbed points smoothed
 *  with Catmull-Rom, so no two seals share an outline. Perturbations come from
 *  the node's index (same rule as wobbleOf): deterministic, so the server and
 *  the client render the identical blob. */
function waxBlobPath(cx: number, cy: number, r: number, seed: number): string {
  const N = 10;
  const pts: Array<[number, number]> = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * Math.PI * 2;
    const wob = 1 + (((((seed + 1) * 89 + i * 37) % 11) - 5) / 5) * 0.09;
    return [cx + Math.cos(a) * r * wob, cy + Math.sin(a) * r * wob];
  });
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % N];
    const p3 = pts[(i + 2) % N];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d + " Z";
}

/** Where the wax ran when the seal was pressed: one drip always, a second
 *  smaller one on every third coin. Angles are confined to the lower half so
 *  the run-out obeys gravity; distances keep the drip's inner edge under the
 *  blob so the join never shows a seam. */
function waxDrips(
  cx: number,
  cy: number,
  r: number,
  seed: number,
): Array<{ x: number; y: number; r: number }> {
  const a1 = ((40 + ((seed * 67) % 100)) * Math.PI) / 180;
  const drips = [{ x: cx + Math.cos(a1) * (r + 2), y: cy + Math.sin(a1) * (r + 2), r: 4.6 }];
  if (seed % 3 === 0) {
    const a2 = ((100 + ((seed * 31) % 55)) * Math.PI) / 180;
    drips.push({ x: cx + Math.cos(a2) * (r + 4), y: cy + Math.sin(a2) * (r + 4), r: 2.8 });
  }
  return drips;
}

function Coin({
  state,
  index,
  selected,
  bursting,
  onSelect,
}: {
  state: NodeState;
  index: number;
  selected: boolean;
  bursting: boolean;
  onSelect: () => void;
}) {
  const { node, status } = state;
  const cx = px(node.x, CELL_X);
  const cy = px(node.y, CELL_Y);
  const colour = KIND_COLOR[node.kind];
  const faded = status === "absent" || status === "skipped";
  const bx = cx + R * 0.72;
  const by = cy - R * 0.72;
  // Two concentric circles, at deliberately different circumferences: the
  // orbiting dashed ring says "in progress", the arc on the coin's own rim
  // says how far.
  const ringR = 71;
  const rimLength = 2 * Math.PI * R;

  return (
    <g
      data-node-id={node.id}
      transform={`rotate(${wobbleOf(index).toFixed(2)} ${cx} ${cy})`}
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
      <g
        className="dw-coin"
        style={{
          animation: "dw-pop-in .5s cubic-bezier(.2,1.5,.4,1) backwards",
          animationDelay: `${index * 13}ms`,
        }}
      >
        {/* Candlelight bloom — dark theme only (the light theme sets it to 0). */}
        <circle
          cx={cx}
          cy={cy}
          r={82}
          fill={colour}
          style={{ opacity: GLOW_VAR[status] as unknown as number }}
        />
        <ellipse cx={cx} cy={cy + 9} rx={56} ry={52} style={{ fill: "var(--dw-shadow)" }} />
        <circle
          cx={cx}
          cy={cy}
          r={R}
          fill={colour}
          style={{
            fillOpacity: FILL_VAR[status] as unknown as number,
            stroke: "var(--dw-rim)",
            strokeOpacity: (faded
              ? "var(--dw-rim-op-faded)"
              : "var(--dw-rim-op)") as unknown as number,
          }}
          strokeWidth={3.5}
          // 🔴 The dash is the ONE thing kept from the pre-restyle map: it is
          // what separates "in your library, unread" from "not in your library"
          // at a glance. The design distinguishes them by rim opacity alone,
          // which is not legible at Fit across 55 coins.
          strokeDasharray={status === "owned" ? "9 6" : undefined}
        />
        {/* Dome shading — see the dw-coin-dome gradient in defs. Sits under
            the gloss ellipse, which stays the specular hit. */}
        <circle
          cx={cx}
          cy={cy}
          r={R}
          fill="url(#dw-coin-dome)"
          style={{
            opacity: (faded
              ? "var(--dw-dome-op-faded)"
              : "var(--dw-dome-op)") as unknown as number,
          }}
        />
        <ellipse
          cx={cx}
          cy={cy - 22}
          rx={40}
          ry={24}
          style={{
            fill: "var(--dw-gloss)",
            opacity: (faded
              ? "var(--dw-gloss-op-faded)"
              : "var(--dw-gloss-op)") as unknown as number,
          }}
        />
        {/* Inner bevel — light theme only. */}
        <circle
          cx={cx}
          cy={cy}
          r={52}
          fill="none"
          style={{ stroke: "var(--dw-shade)", strokeOpacity: "var(--dw-shade-op)" as unknown as number }}
          strokeWidth={7}
        />

        {status === "reading" && (
          <>
            {/* 🔴 The two circles are deliberately DIFFERENT sizes. They used
                to share a radius — the arc under the dashes — so that the read
                part read as a continuous gold band. It doesn't: at a small
                percentage the arc simply hides beneath a dash, and at any
                percentage the two are one ring you have to decode. The arc now
                rides the coin's own RIM (r = R, against the ring's 71), so the
                book visibly fills in with gold from the top as it is read,
                while the orbiting dashes stay the "in progress" identity.
                The rim was chosen over a second ring outside the dashes
                because the closest pair of coins is 129 units apart against a
                58-unit radius — anything beyond r ≈ 71 crosses into the
                neighbour. Two bands 5 units apart are invisible (measured);
                these are 7 apart edge to edge, at different weights. */}
            {state.percentage != null && (
              <circle
                cx={cx}
                cy={cy}
                r={R}
                fill="none"
                style={{ stroke: "var(--dw-ring)" }}
                strokeWidth={5}
                strokeDasharray={`${rimLength * Math.max(0.02, state.percentage)} ${rimLength}`}
                transform={`rotate(-90 ${cx} ${cy})`}
                opacity={0.95}
                pointerEvents="none"
              />
            )}
            <g className="dw-spin" style={{ animation: "dw-spin-ring 10s linear infinite" }}>
              <circle
                cx={cx}
                cy={cy}
                r={ringR}
                fill="none"
                style={{ stroke: "var(--dw-ring)" }}
                strokeWidth={7}
                strokeLinecap="round"
                strokeDasharray="26 18"
                opacity={0.95}
              />
            </g>
          </>
        )}

        {status === "finished" && (
          <g
            style={{
              animation: "dw-seal-in .45s cubic-bezier(.2,1.4,.4,1) backwards",
              animationDelay: `${index * 13 + 120}ms`,
              transformBox: "fill-box",
              transformOrigin: "center",
              pointerEvents: "none",
            }}
          >
            {/* The seal is built like the object: a shadow on the page, wax
                that ran where it was pressed (the drips, under the blob so the
                join never shows), the lumpy blob itself under the dw-seal-grad
                wax gradient, the pressed matrix impression (dark upper ring,
                lit lower ring — a depression lit from above), a specular gleam
                on the crown, and the check pressed IN (its lit lower edge
                drawn first). Blob, drips and tilt are all deterministic from
                the node's index, so no two seals match and the server and the
                client agree. */}
            <g transform={`rotate(${((index * 47) % 25) - 12} ${bx} ${by})`}>
              <ellipse
                cx={bx + 1.5}
                cy={by + 3.5}
                rx={23}
                ry={21}
                style={{ fill: "var(--dw-shadow)" }}
              />
              {waxDrips(bx, by, 21, index).map((d, k) => (
                <circle
                  key={k}
                  cx={d.x}
                  cy={d.y}
                  r={d.r}
                  fill="url(#dw-seal-grad)"
                  style={{ stroke: "var(--dw-seal-stroke)", strokeOpacity: 0.4 }}
                  strokeWidth={1}
                />
              ))}
              <path
                d={waxBlobPath(bx, by, 21, index)}
                fill="url(#dw-seal-grad)"
                style={{ stroke: "var(--dw-seal-stroke)", strokeOpacity: 0.5 }}
                strokeWidth={1.5}
              />
              <circle
                cx={bx}
                cy={by - 0.9}
                r={14}
                fill="none"
                style={{ stroke: "var(--dw-seal-lo)" }}
                strokeOpacity={0.65}
                strokeWidth={2}
              />
              <circle
                cx={bx}
                cy={by + 1}
                r={14}
                fill="none"
                style={{ stroke: "var(--dw-seal-hi)" }}
                strokeOpacity={0.4}
                strokeWidth={1.2}
              />
              <ellipse
                cx={bx - 7}
                cy={by - 9}
                rx={7.5}
                ry={4.5}
                transform={`rotate(-28 ${bx - 7} ${by - 9})`}
                style={{ fill: "var(--dw-seal-inner)" }}
                opacity={0.5}
              />
              <path
                d={`M ${bx - 8} ${by + 1.2} l 6 6 l 10 -12`}
                fill="none"
                style={{ stroke: "var(--dw-seal-hi)" }}
                strokeOpacity={0.45}
                strokeWidth={4.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={`M ${bx - 8} ${by} l 6 6 l 10 -12`}
                fill="none"
                style={{ stroke: "var(--dw-seal-check)" }}
                strokeWidth={4.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
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

        {/* The reader's own mark, called out — a gold stud pressed into the
            coin. Anything the sync didn't decide should say so. */}
        {state.manual && (
          <circle
            cx={cx - R * 0.72}
            cy={cy - R * 0.72}
            r={8}
            style={{ fill: "var(--dw-stud-fill)", stroke: "var(--dw-stud-stroke)" }}
            strokeWidth={2}
            pointerEvents="none"
          />
        )}

        {selected && (
          <circle
            cx={cx}
            cy={cy}
            r={78}
            fill="none"
            style={{ stroke: "var(--dw-select)" }}
            strokeWidth={4}
            strokeDasharray="12 11"
            strokeLinecap="round"
            opacity={0.9}
          />
        )}

        {bursting && (
          <g
            style={{
              animation: `dw-burst-out ${BURST_MS}ms ease-out forwards`,
              transformBox: "fill-box",
              transformOrigin: "center",
              pointerEvents: "none",
            }}
          >
            {Array.from({ length: 7 }, (_, k) => {
              const a = (k / 7) * Math.PI * 2;
              return (
                <circle
                  key={k}
                  cx={cx + Math.cos(a) * (R + 24)}
                  cy={cy + Math.sin(a) * (R + 24)}
                  r={k % 2 ? 5 : 8}
                  style={{ fill: k % 2 ? "var(--dw-spark-b)" : "var(--dw-spark-a)" }}
                />
              );
            })}
          </g>
        )}
      </g>
    </g>
  );
}

/** The coin's title, as HTML so the browser can balance the line breaks. */
function CoinLabel({ state, index }: { state: NodeState; index: number }) {
  const { node, status } = state;
  const cx = px(node.x, CELL_X);
  const cy = px(node.y, CELL_Y);
  const faded = status === "absent" || status === "skipped";
  // The purple and red coins are dark enough that ink-coloured type on them is
  // unreadable; everything else takes the dark ink.
  const lightText = !faded && (node.kind === "science" || node.kind === "ya");
  return (
    <div
      className="absolute flex items-center justify-center text-center font-fantasy font-bold"
      style={{
        left: `${cx + OX - R}px`,
        top: `${cy + OY - R}px`,
        width: `${2 * R}px`,
        height: `${2 * R}px`,
        padding: "0 7px",
        boxSizing: "border-box",
        fontSize: `${labelSize(node.title)}px`,
        lineHeight: 1.18,
        textWrap: "balance",
        transform: `rotate(${wobbleOf(index).toFixed(2)}deg)`,
        color: faded
          ? "var(--dw-label-faded)"
          : lightText
            ? "var(--dw-label-light)"
            : "var(--dw-label)",
        textShadow: faded
          ? "var(--dw-label-shadow-faded)"
          : lightText
            ? "var(--dw-label-shadow-light)"
            : "var(--dw-label-shadow)",
      }}
    >
      {node.title}
    </div>
  );
}

// ── The key ──────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-16 px-3 sm:inset-x-auto sm:bottom-auto sm:left-3 sm:top-3 sm:px-0">
      <div
        className="pointer-events-auto rounded p-4 sm:w-[430px]"
        style={{
          background: "var(--dw-panel-bg)",
          border: "2px solid var(--dw-panel-border)",
        }}
      >
        <ul className="grid grid-cols-3 gap-3">
          {(Object.keys(KIND_COLOR) as NodeKind[]).map((k) => (
            <li key={k} className="flex flex-col items-center gap-1.5 text-center">
              {/* The poster's own shield swatch, not a dot. */}
              <svg width="34" height="44" viewBox="0 0 34 44" className="overflow-visible">
                <path
                  d="M 2 2 L 32 2 L 32 27 L 17 42 L 2 27 Z"
                  fill={KIND_COLOR[k]}
                  fillOpacity={0.92}
                  style={{ stroke: "var(--dw-legend-shield-stroke)" }}
                  strokeWidth={2.5}
                />
                <ellipse
                  cx="17"
                  cy="12"
                  rx="10"
                  ry="6"
                  style={{
                    fill: "var(--dw-gloss)",
                    opacity: "var(--dw-legend-gloss-op)" as unknown as number,
                  }}
                />
              </svg>
              <span
                className="font-fantasy-sc text-[0.78rem] leading-tight tracking-[0.04em]"
                style={{ color: "var(--dw-panel-fg)" }}
              >
                {KIND_LABEL[k]}
              </span>
            </li>
          ))}
        </ul>
        <div
          className="mt-3.5 flex flex-wrap gap-x-6 gap-y-2 border-t pt-3"
          style={{ borderColor: "var(--dw-panel-rule)" }}
        >
          {[
            { label: "Direct connection", dash: undefined },
            { label: "Minor connection", dash: "0.1 9" },
          ].map((c) => (
            <div key={c.label} className="flex items-center gap-2">
              <svg width="46" height="10" viewBox="0 0 46 10">
                <line
                  x1="2"
                  y1="5"
                  x2="44"
                  y2="5"
                  style={{ stroke: "var(--dw-arrow)" }}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeDasharray={c.dash}
                />
              </svg>
              <span
                className="font-fantasy-sc text-[0.78rem] tracking-[0.04em]"
                style={{ color: "var(--dw-panel-fg)" }}
              >
                {c.label}
              </span>
            </div>
          ))}
        </div>
        <p
          className="mt-3 text-[0.8rem] leading-relaxed"
          style={{ color: "var(--dw-panel-prose)" }}
        >
          A full-gloss coin is read and a wax seal marks it; a gold ring means in progress, and the
          gold filling the coin’s own rim is how far. A dashed rim means the book is in your library but unread, a
          pale coin that it isn&apos;t there yet, and a gold stud that you marked it by hand. Drag
          to pan, pinch or ctrl-scroll to zoom, tap a coin to mark it.
        </p>
      </div>
    </div>
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
    <div className="absolute inset-x-0 bottom-0 z-40 animate-slide-up p-3.5">
      <div
        className="mx-auto max-w-[560px] overflow-hidden rounded"
        style={{
          background: "var(--dw-sheet-bg)",
          border: "2px solid var(--dw-sheet-border)",
          boxShadow: "0 20px 40px -22px rgba(0,0,0,.75)",
        }}
      >
        <div
          className="flex items-start justify-between gap-3 border-b px-4 py-3"
          style={{ background: "var(--dw-sheet-head-bg)", borderColor: "var(--dw-sheet-rule)" }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="h-[30px] w-[30px] flex-none rounded-full"
              style={{
                background: KIND_COLOR[node.kind],
                border: "2px solid var(--dw-chip-ring)",
                boxShadow:
                  "inset 0 4px 6px rgba(255,250,236,.5), inset 0 -4px 6px rgba(0,0,0,.25)",
              }}
            />
            <div className="min-w-0">
              <p
                className="font-mono text-[0.62rem] uppercase tracking-kicker"
                style={{ color: "var(--dw-sheet-meta)" }}
              >
                {KIND_LABEL[node.kind]}
                {node.pubOrder != null && ` · #${node.pubOrder}`} · {node.year}
              </p>
              <h2
                className="mt-0.5 font-fantasy text-[1.35rem] font-bold leading-tight"
                style={{ color: "var(--dw-heading)" }}
              >
                {node.title}
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex-none font-mono text-sm"
            style={{ color: "var(--dw-sheet-meta)" }}
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-3.5">
          <p
            className="font-fantasy-sc text-[0.95rem] tracking-[0.04em]"
            style={{ color: "var(--dw-sheet-fg)" }}
          >
            {STATUS_LABEL[status]}
            {state.percentage != null && status !== "finished" && (
              <> · {Math.round(state.percentage * 100)}%</>
            )}
          </p>

          {/* Honesty carry: when the reader's mark and the sync disagree, say
              so plainly rather than quietly showing only the winner. */}
          {manual && (
            <p className="mt-1 text-[0.78rem]" style={{ color: "var(--dw-sheet-meta)" }}>
              Marked by hand
              {auto !== "absent" && auto !== resolvedAuto(manual) && (
                <> · your library says &ldquo;{STATUS_LABEL[auto].toLowerCase()}&rdquo;</>
              )}
            </p>
          )}
          {!manual && status === "finished" && (
            <p className="mt-1 text-[0.78rem]" style={{ color: "var(--dw-sheet-meta)" }}>
              From your reading sync.
            </p>
          )}
          {!manual && status === "absent" && (
            <p className="mt-1 text-[0.78rem]" style={{ color: "var(--dw-sheet-meta)" }}>
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
              className="mt-3 inline-block font-fantasy-sc text-[0.9rem] tracking-[0.05em] hover:underline"
              style={{ color: "var(--dw-heading)" }}
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
      className="rounded px-3.5 py-1.5 font-fantasy-sc text-[0.95rem] tracking-[0.05em] transition-colors disabled:opacity-50"
      style={{
        border: `2px solid ${active ? "var(--dw-btn-on-border)" : "var(--dw-btn-border)"}`,
        background: active ? "var(--dw-btn-on-bg)" : "var(--dw-btn-bg)",
        color: active ? "var(--dw-btn-on-fg)" : "var(--dw-btn-fg)",
        boxShadow: active ? "var(--dw-btn-on-shadow)" : "var(--dw-btn-shadow)",
      }}
    >
      {children}
    </button>
  );
}
