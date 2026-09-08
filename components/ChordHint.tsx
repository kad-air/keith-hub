"use client";

import { useEffect, useState } from "react";
import { CHORD_EVENT, type ChordEventDetail } from "@/lib/useKeyboard";
import { chordOptions, type ShortcutRow } from "@/lib/shortcuts";

/**
 * The which-key strip. Press `g` and this shows every letter that can
 * follow and where it goes; it leaves the moment the chord resolves or
 * times out (`useKeyboard` announces both). Keyboard-only by construction —
 * it never renders until a chord prefix is pressed — so it needs no
 * touch/width gating.
 */
export default function ChordHint() {
  const [state, setState] = useState<{ prefix: string; rows: ShortcutRow[] } | null>(null);

  useEffect(() => {
    function onChord(e: Event) {
      const { prefix, keys } = (e as CustomEvent<ChordEventDetail>).detail;
      if (!prefix) {
        setState(null);
        return;
      }
      const rows = chordOptions(prefix, keys);
      setState({ prefix, rows });
    }
    window.addEventListener(CHORD_EVENT, onChord);
    return () => window.removeEventListener(CHORD_EVENT, onChord);
  }, []);

  if (!state) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-[65] flex justify-center px-4 animate-fade-in"
    >
      <div className="flex max-w-[980px] flex-wrap items-center justify-center gap-x-4 gap-y-2 border border-rule-strong bg-ink-raised/95 px-4 py-2.5 shadow-2xl shadow-black/50 backdrop-blur-xl">
        <span className="inline-flex items-center gap-1.5 font-mono text-[0.62rem] uppercase tracking-[0.18em] text-cream-dim">
          <kbd className="border border-accent/70 bg-ink px-1.5 py-0.5 text-[0.62rem] text-accent">
            {state.prefix}
          </kbd>
          then
        </span>
        {state.rows.map((row) => (
          <span
            key={row.keys.join("")}
            className="inline-flex items-center gap-1.5 font-mono text-[0.62rem] uppercase tracking-[0.18em] text-cream-dimmer"
          >
            <kbd className="border border-rule-strong bg-ink px-1.5 py-0.5 text-[0.62rem] text-cream">
              {row.keys[0]}
            </kbd>
            <span className="text-cream-dim">{row.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
