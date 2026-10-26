"use client";

import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LONG_PRESS_MS } from "@/lib/hoops/scores/spoiler";

const MOVE_CANCEL_PX = 8;

/**
 * The feed's Clear-Above hold, lifted for spoiler mode: press and hold for
 * LONG_PRESS_MS without moving and `onFire` runs; any movement, release or
 * cancel before that drops it. `holding` drives the HoldBar. Pointer events
 * so a mouse works too. The click that follows a fired hold is swallowed.
 */
export function useLongPress(onFire: () => void, enabled = true) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
    setHolding(false);
  }, []);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled || e.button !== 0) return;
    fired.current = false;
    start.current = { x: e.clientX, y: e.clientY };
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHolding(false);
      if (!start.current) return;
      start.current = null;
      fired.current = true;
      onFire();
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const s = start.current;
    if (!s) return;
    if (Math.abs(e.clientX - s.x) > MOVE_CANCEL_PX || Math.abs(e.clientY - s.y) > MOVE_CANCEL_PX) cancel();
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (fired.current) {
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return {
    holding,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onClickCapture,
    },
  };
}

/** The feed card's hold progress bar, verbatim: a 2px accent rule along the
 *  top that fills left to right over LONG_PRESS_MS and snaps back in 120ms. */
export function HoldBar({ holding }: { holding: boolean }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-[2px] origin-left bg-accent"
      style={{
        transform: holding ? "scaleX(1)" : "scaleX(0)",
        opacity: holding ? 1 : 0,
        transition: holding
          ? `transform ${LONG_PRESS_MS}ms linear, opacity 80ms ease-out`
          : "transform 120ms ease-out, opacity 120ms ease-out",
      }}
    />
  );
}
