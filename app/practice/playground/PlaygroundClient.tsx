"use client";

import { useState } from "react";
import { Fretboard } from "@/components/fretboard/Fretboard";
import type { FretboardNote } from "@/components/fretboard/types";

// E major open chord.
const E_MAJOR: FretboardNote[] = [
  { string: 6, fret: 0, role: "root", label: "E" },
  { string: 5, fret: 2, role: "chord", label: "B" },
  { string: 4, fret: 2, role: "root", label: "E" },
  { string: 3, fret: 1, role: "chord", label: "G♯" },
  { string: 2, fret: 0, role: "chord", label: "B" },
  { string: 1, fret: 0, role: "root", label: "E" },
];

// A minor pentatonic box 1 (5th–8th frets). Roots on string 6/4/1.
const AM_PENTATONIC_BOX1: FretboardNote[] = [
  { string: 6, fret: 5, role: "root", label: "A" },
  { string: 6, fret: 8, role: "scale", label: "C" },
  { string: 5, fret: 5, role: "scale", label: "D" },
  { string: 5, fret: 7, role: "scale", label: "E" },
  { string: 4, fret: 5, role: "scale", label: "G" },
  { string: 4, fret: 7, role: "root", label: "A" },
  { string: 3, fret: 5, role: "scale", label: "C" },
  { string: 3, fret: 7, role: "scale", label: "D" },
  { string: 2, fret: 5, role: "scale", label: "E" },
  { string: 2, fret: 8, role: "scale", label: "G" },
  { string: 1, fret: 5, role: "root", label: "A" },
  { string: 1, fret: 8, role: "scale", label: "C" },
];

// D major triad, strings 2-3-4, root position at fret 7.
const D_TRIAD_234: FretboardNote[] = [
  { string: 4, fret: 7, role: "chord", label: "A" },
  { string: 3, fret: 7, role: "root", label: "D" },
  { string: 2, fret: 7, role: "chord", label: "F♯" },
];

// Ghost-note hint example (next-note overlay).
const GHOST_EXAMPLE: FretboardNote[] = [
  { string: 5, fret: 3, role: "root", label: "C" },
  { string: 4, fret: 5, role: "scale", label: "G" },
  { string: 3, fret: 5, role: "scale", label: "C" },
  { string: 2, fret: 5, role: "ghost", label: "E" },
  { string: 1, fret: 3, role: "ghost", label: "G" },
];

export function PlaygroundClient() {
  const [tapLog, setTapLog] = useState<Array<{ s: number; f: number }>>([]);

  const handleTap = (s: 1 | 2 | 3 | 4 | 5 | 6, f: number) => {
    setTapLog((prev) => [{ s, f }, ...prev].slice(0, 6));
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-kicker text-cat-practice">
          Practice · Playground
        </p>
        <h1 className="mt-2 font-display text-3xl text-cream">
          Fretboard atom
        </h1>
        <p className="mt-2 text-sm text-cream-dim">
          Dev-only exerciser for <code>components/fretboard/Fretboard.tsx</code>
          . Production requests to this route 404.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-kicker text-cream-dim">
          Empty neck · 15 frets
        </h2>
        <div className="rounded-lg border border-rule bg-ink-raised/30 p-3">
          <Fretboard ariaLabel="Empty fretboard, 15 frets" />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-kicker text-cream-dim">
          E major · open chord (E shape)
        </h2>
        <div className="rounded-lg border border-rule bg-ink-raised/30 p-3">
          <Fretboard notes={E_MAJOR} frets={5} ariaLabel="E major open chord" />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-kicker text-cream-dim">
          A minor pentatonic · box 1 (fret 5)
        </h2>
        <div className="rounded-lg border border-rule bg-ink-raised/30 p-3">
          <Fretboard
            notes={AM_PENTATONIC_BOX1}
            frets={12}
            ariaLabel="A minor pentatonic box 1"
          />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-kicker text-cream-dim">
          D major triad · strings 2-3-4 (root position)
        </h2>
        <div className="rounded-lg border border-rule bg-ink-raised/30 p-3">
          <Fretboard notes={D_TRIAD_234} frets={9} ariaLabel="D major triad" />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-kicker text-cream-dim">
          With capo at fret 3
        </h2>
        <div className="rounded-lg border border-rule bg-ink-raised/30 p-3">
          <Fretboard
            notes={GHOST_EXAMPLE}
            frets={9}
            capo={{ fret: 3, fromString: 1, toString: 6 }}
            ariaLabel="Ghost notes with capo"
          />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-kicker text-cream-dim">
          Vertical orientation · A minor pentatonic box 1
        </h2>
        <div className="mx-auto max-w-xs rounded-lg border border-rule bg-ink-raised/30 p-3">
          <Fretboard
            notes={AM_PENTATONIC_BOX1}
            frets={12}
            orientation="vertical"
            ariaLabel="Vertical fretboard"
          />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-kicker text-cream-dim">
          Interactive · tap zones
        </h2>
        <div className="rounded-lg border border-rule bg-ink-raised/30 p-3">
          <Fretboard
            notes={tapLog.map((t, i) => ({
              string: t.s as 1 | 2 | 3 | 4 | 5 | 6,
              fret: t.f,
              role: i === 0 ? "root" : "scale",
              label: String(i + 1),
            }))}
            frets={12}
            onTap={handleTap}
            ariaLabel="Interactive fretboard"
          />
        </div>
        <p className="mt-3 font-mono text-xs text-cream-dim">
          {tapLog.length === 0
            ? "Tap anywhere on the neck. Last 6 taps will render."
            : tapLog
                .map((t) => `string ${t.s} · fret ${t.f}`)
                .join("  ·  ")}
        </p>
      </section>
    </main>
  );
}
