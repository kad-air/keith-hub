"use client";

import { useMemo } from "react";
import type {
  FretboardNote,
  FretboardProps,
  FretboardRole,
} from "./types";

// Standard tuning, string 1 → 6 (high E to low E)
const STRING_NAMES: readonly string[] = ["E", "B", "G", "D", "A", "E"];

// Single-dot inlays on all guitars; double on octave frets.
const SINGLE_INLAYS = new Set([3, 5, 7, 9, 15, 17, 19, 21]);
const DOUBLE_INLAYS = new Set([12, 24]);

// Layout in SVG units — horizontal orientation (nut on left, string 1 on top).
// The vertical orientation transposes x/y at the group level, so all geometry
// below is written once for horizontal.
const CELL = 60;
const STRING_H = 30;
const NUT_W = 12;
const PAD_LEFT = 44;
const PAD_RIGHT = 16;
const PAD_TOP = 18;
const PAD_BOTTOM = 28;
const NOTE_R = 12;

type InternalNote = FretboardNote;

type LayoutInfo = {
  width: number;
  height: number;
  neckWidth: number;
  neckHeight: number;
};

function computeLayout(frets: number): LayoutInfo {
  const width = PAD_LEFT + NUT_W + frets * CELL + PAD_RIGHT;
  const height = PAD_TOP + 5 * STRING_H + PAD_BOTTOM;
  return {
    width,
    height,
    neckWidth: NUT_W + frets * CELL,
    neckHeight: 5 * STRING_H,
  };
}

function stringY(stringNum: number): number {
  // String 1 (high E) on top in horizontal layout.
  return PAD_TOP + (stringNum - 1) * STRING_H;
}

function fretX(fret: number): number {
  // Position of the fret bar at the end of fret `fret`. Nut is at fret 0.
  return PAD_LEFT + (fret === 0 ? 0 : NUT_W + fret * CELL);
}

function noteCenter(note: InternalNote): { x: number; y: number } {
  const y = stringY(note.string);
  if (note.fret === 0) {
    // Open-string marker sits left of the nut.
    return { x: PAD_LEFT - NUT_W - 4, y };
  }
  const x = PAD_LEFT + NUT_W + (note.fret - 0.5) * CELL;
  return { x, y };
}

function roleClasses(role: FretboardRole): {
  fill: string;
  stroke: string;
  text: string;
} {
  switch (role) {
    case "root":
      return {
        fill: "fill-cat-practice-root",
        stroke: "stroke-cat-practice-root",
        text: "fill-ink",
      };
    case "chord":
      return {
        fill: "fill-cat-practice-chord",
        stroke: "stroke-cat-practice-chord",
        text: "fill-ink",
      };
    case "scale":
      return {
        fill: "fill-cat-practice-scale",
        stroke: "stroke-cat-practice-scale",
        text: "fill-ink",
      };
    case "ghost":
      // 40% opacity scale color via Tailwind's /opacity syntax.
      return {
        fill: "fill-cat-practice-scale/40",
        stroke: "stroke-cat-practice-scale/50",
        text: "fill-cream/70",
      };
  }
}

export function Fretboard({
  notes = [],
  frets = 15,
  orientation = "horizontal",
  showFretNumbers = true,
  showStringNames = true,
  capo,
  onTap,
  className,
  ariaLabel,
}: FretboardProps) {
  const layout = useMemo(() => computeLayout(frets), [frets]);

  // Horizontal viewBox is the source of truth. Vertical is the same SVG
  // rotated 90° counter-clockwise, so the top of the vertical view is the
  // nut (fret 0) and string 6 ends up on the left, string 1 on the right —
  // matching chord-chart convention.
  const viewBox = `0 0 ${layout.width} ${layout.height}`;
  const rotateGroup = orientation === "vertical";

  // When rotating, swap the outer dimensions so the SVG lays out correctly.
  const svgWidth = rotateGroup ? layout.height : layout.width;
  const svgHeight = rotateGroup ? layout.width : layout.height;
  const svgViewBox = rotateGroup
    ? `0 0 ${layout.height} ${layout.width}`
    : viewBox;

  // Transform that rotates the entire inner group for vertical orientation.
  // Rotate 90° around origin, then translate so the resulting box starts at 0,0.
  const innerTransform = rotateGroup
    ? `rotate(90) translate(0 ${-layout.height})`
    : undefined;

  const fretNumbersToShow = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i <= frets; i++) {
      if (SINGLE_INLAYS.has(i) || DOUBLE_INLAYS.has(i) || i === 1) out.push(i);
    }
    return out;
  }, [frets]);

  const inlays = useMemo(() => {
    const out: Array<{ fret: number; double: boolean }> = [];
    for (let i = 1; i <= frets; i++) {
      if (DOUBLE_INLAYS.has(i)) out.push({ fret: i, double: true });
      else if (SINGLE_INLAYS.has(i)) out.push({ fret: i, double: false });
    }
    return out;
  }, [frets]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={svgViewBox}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      className={className}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      style={{ maxWidth: svgWidth, maxHeight: svgHeight }}
    >
      <g transform={innerTransform}>
        {/* Fretboard background */}
        <rect
          x={PAD_LEFT}
          y={PAD_TOP - 4}
          width={layout.neckWidth}
          height={layout.neckHeight + 8}
          className="fill-ink-raised"
          rx={2}
        />

        {/* Inlays (dots) — drawn before strings so they sit behind */}
        {inlays.map(({ fret, double }) => {
          const cx = PAD_LEFT + NUT_W + (fret - 0.5) * CELL;
          if (double) {
            const y1 = stringY(2) + STRING_H / 2;
            const y2 = stringY(4) + STRING_H / 2;
            return (
              <g key={`inlay-${fret}`}>
                <circle cx={cx} cy={y1} r={4} className="fill-rule-strong" />
                <circle cx={cx} cy={y2} r={4} className="fill-rule-strong" />
              </g>
            );
          }
          const cy = PAD_TOP + 2.5 * STRING_H;
          return (
            <circle
              key={`inlay-${fret}`}
              cx={cx}
              cy={cy}
              r={4}
              className="fill-rule-strong"
            />
          );
        })}

        {/* Frets (bars) */}
        {Array.from({ length: frets }, (_, i) => {
          const f = i + 1;
          const x = fretX(f);
          return (
            <line
              key={`fret-${f}`}
              x1={x}
              y1={PAD_TOP}
              x2={x}
              y2={PAD_TOP + layout.neckHeight}
              className="stroke-rule-strong"
              strokeWidth={1.5}
            />
          );
        })}

        {/* Nut */}
        <rect
          x={PAD_LEFT}
          y={PAD_TOP - 2}
          width={NUT_W}
          height={layout.neckHeight + 4}
          className="fill-cream-dim"
          rx={1}
        />

        {/* Strings */}
        {Array.from({ length: 6 }, (_, i) => {
          const s = i + 1;
          const y = stringY(s);
          // Slightly thicker for bass strings.
          const w = 0.8 + (s - 1) * 0.18;
          return (
            <line
              key={`string-${s}`}
              x1={PAD_LEFT}
              y1={y}
              x2={PAD_LEFT + layout.neckWidth}
              y2={y}
              className="stroke-cream-dim"
              strokeWidth={w}
            />
          );
        })}

        {/* Capo */}
        {capo && capo.fret > 0 && capo.fret <= frets && (
          <rect
            x={fretX(capo.fret) - CELL / 2 - 4}
            y={
              stringY(Math.min(capo.fromString, capo.toString)) -
              8
            }
            width={12}
            height={
              Math.abs(capo.toString - capo.fromString) * STRING_H + 16
            }
            className="fill-accent/80"
            rx={3}
          />
        )}

        {/* String name labels */}
        {showStringNames &&
          STRING_NAMES.map((name, idx) => {
            const s = idx + 1;
            const y = stringY(s);
            const transform = rotateGroup
              ? `rotate(-90 ${PAD_LEFT - NUT_W - 16} ${y})`
              : undefined;
            return (
              <text
                key={`sn-${s}`}
                x={PAD_LEFT - NUT_W - 16}
                y={y + 4}
                textAnchor="middle"
                transform={transform}
                className="fill-cream-dim font-mono text-[11px]"
              >
                {name}
              </text>
            );
          })}

        {/* Fret number labels */}
        {showFretNumbers &&
          fretNumbersToShow.map((f) => {
            const x = PAD_LEFT + NUT_W + (f - 0.5) * CELL;
            const y = PAD_TOP + layout.neckHeight + 18;
            const transform = rotateGroup
              ? `rotate(-90 ${x} ${y})`
              : undefined;
            return (
              <text
                key={`fn-${f}`}
                x={x}
                y={y}
                textAnchor="middle"
                transform={transform}
                className="fill-cream-dimmer font-mono text-[10px]"
              >
                {f}
              </text>
            );
          })}

        {/* Notes */}
        {notes.map((note, i) => {
          const { x, y } = noteCenter(note);
          const cls = roleClasses(note.role);
          const transform = rotateGroup
            ? `rotate(-90 ${x} ${y})`
            : undefined;
          return (
            <g
              key={`note-${i}-${note.string}-${note.fret}`}
              data-role={note.role}
              data-string={note.string}
              data-fret={note.fret}
            >
              <circle
                cx={x}
                cy={y}
                r={NOTE_R}
                className={`${cls.fill} ${cls.stroke}`}
                strokeWidth={1.5}
              />
              {note.label && (
                <text
                  x={x}
                  y={y + 4}
                  textAnchor="middle"
                  transform={transform}
                  className={`${cls.text} font-mono text-[10px] font-semibold`}
                >
                  {note.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Invisible tap zones — only rendered when onTap is provided */}
        {onTap &&
          Array.from({ length: 6 }, (_, si) =>
            Array.from({ length: frets + 1 }, (_, fi) => {
              const s = (si + 1) as 1 | 2 | 3 | 4 | 5 | 6;
              const f = fi; // 0 … frets
              let x: number;
              let w: number;
              if (f === 0) {
                x = PAD_LEFT - NUT_W - 12;
                w = NUT_W + 12;
              } else {
                x = PAD_LEFT + NUT_W + (f - 1) * CELL;
                w = CELL;
              }
              const y = stringY(s) - STRING_H / 2;
              const h = STRING_H;
              return (
                <rect
                  key={`tap-${s}-${f}`}
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  fill="transparent"
                  className="cursor-pointer"
                  onClick={() => onTap(s, f)}
                  data-tap-string={s}
                  data-tap-fret={f}
                />
              );
            }),
          ).flat()}
      </g>
    </svg>
  );
}
