"use client";

import { useEffect, useState } from "react";

interface ToastProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

export default function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = 5000,
}: ToastProps) {
  // Progress is driven by a single CSS width transition: we render in
  // `reset` phase (width=100, transition=none), flip to `ticking` next
  // frame (width=0, transition=durationMs), and let the GPU tween between.
  // Beats a 20Hz setInterval that was re-rendering a fixed-position
  // element on top of the feed every 50ms — visibly pressuring the main
  // thread during swipes. The phase flag also means a parent re-render
  // (new onDismiss identity, new pending item) visibly restarts the bar
  // instead of freezing it at 0%.
  const [phase, setPhase] = useState<"reset" | "ticking">("reset");
  useEffect(() => {
    setPhase("reset");
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setPhase("ticking"));
    });
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
    };
  }, [durationMs, onDismiss]);

  return (
    <div
      role="status"
      className="fixed bottom-[max(1.5rem,calc(env(safe-area-inset-bottom)+0.5rem))] sm:bottom-[max(1.5rem,calc(env(safe-area-inset-bottom)+0.5rem))] max-sm:bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] left-1/2 z-50 -translate-x-1/2 animate-slide-up"
    >
      <div className="relative overflow-hidden rounded-sm border border-rule-strong bg-ink-raised/95 px-5 py-3 shadow-2xl shadow-black/60 backdrop-blur-md">
        <div className="flex items-center gap-5">
          <span className="font-display text-[0.95rem] text-cream">
            {message}
          </span>
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={() => {
                onAction();
                onDismiss();
              }}
              className="font-mono text-[0.7rem] uppercase tracking-kicker text-accent transition-colors hover:text-cream"
            >
              {actionLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="ml-1 text-cream-dimmer transition-colors hover:text-cream"
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
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        {/* Countdown progress bar — single CSS transition over the full
            duration, no JS tick. */}
        <div
          aria-hidden
          className="absolute bottom-0 left-0 h-[1px] bg-accent/70 ease-linear"
          style={{
            width: phase === "reset" ? "100%" : "0%",
            transition:
              phase === "reset" ? "none" : `width ${durationMs}ms linear`,
          }}
        />
      </div>
    </div>
  );
}
