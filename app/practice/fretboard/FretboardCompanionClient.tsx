"use client";

import { useMemo, useState } from "react";
import { Fretboard } from "@/components/fretboard/Fretboard";
import {
  KEYS,
  SCALES,
  box1Window,
  scaleNotes,
  type KeyName,
  type ScaleKind,
} from "@/lib/practice/theory";

const SCALE_OPTIONS: { value: ScaleKind; label: string }[] = [
  { value: "minor_pentatonic", label: "Minor pentatonic" },
  { value: "major_pentatonic", label: "Major pentatonic" },
  { value: "blues", label: "Blues" },
  { value: "major", label: "Major" },
  { value: "natural_minor", label: "Natural minor" },
  { value: "dorian", label: "Dorian" },
  { value: "mixolydian", label: "Mixolydian" },
];

export function FretboardCompanionClient() {
  const [key, setKey] = useState<KeyName>("A");
  const [scale, setScale] = useState<ScaleKind>("minor_pentatonic");
  const [showLabels, setShowLabels] = useState(true);
  const [box1Only, setBox1Only] = useState(false);

  const notes = useMemo(() => {
    if (box1Only) {
      const { minFret, maxFret } = box1Window(key);
      return scaleNotes(key, scale, {
        minFret,
        maxFret,
        withLabels: showLabels,
      });
    }
    return scaleNotes(key, scale, { withLabels: showLabels });
  }, [key, scale, showLabels, box1Only]);

  const scaleLabel = SCALES[scale].label;
  const noteCount = notes.length;

  return (
    <article className="mx-auto max-w-[900px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
          Practice · Fretboard
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">
          {key} {scaleLabel.toLowerCase()}
        </h1>
        <p className="mt-1 text-sm text-cream-dim">
          {noteCount} notes across the first 15 frets
          {box1Only ? " · box 1 only" : ""}.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr_auto]">
        <fieldset className="flex flex-wrap items-center gap-1 rounded-sm border border-rule/60 bg-ink-raised/30 p-1">
          <legend className="sr-only">Key</legend>
          {KEYS.map((k) => {
            const active = k === key;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setKey(k)}
                aria-pressed={active}
                className={[
                  "px-2.5 py-1 font-mono text-[0.7rem] transition-colors",
                  active
                    ? "bg-cat-practice text-ink"
                    : "text-cream-dim hover:bg-ink-hover hover:text-cream",
                ].join(" ")}
              >
                {k}
              </button>
            );
          })}
        </fieldset>

        <label className="flex items-center gap-2">
          <span className="sr-only">Scale</span>
          <select
            value={scale}
            onChange={(e) => setScale(e.target.value as ScaleKind)}
            className="w-full rounded-sm border border-rule/60 bg-ink-raised/30 px-3 py-1.5 font-mono text-sm text-cream focus:border-cat-practice focus:outline-none"
          >
            {SCALE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-3">
          <ToggleButton
            active={showLabels}
            onToggle={() => setShowLabels((v) => !v)}
            label="Labels"
          />
          <ToggleButton
            active={box1Only}
            onToggle={() => setBox1Only((v) => !v)}
            label="Box 1"
          />
        </div>
      </div>

      <div className="rounded-lg border border-rule/60 bg-ink-raised/30 p-3 sm:p-4">
        <Fretboard
          notes={notes}
          frets={15}
          ariaLabel={`${key} ${scaleLabel} fretboard`}
        />
      </div>

      <p className="mt-4 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
        Root ·{" "}
        <span className="normal-case tracking-normal text-cream-dim">
          amber dots
        </span>
        {scale === "blues" && (
          <>
            {" · "}♭5 ·{" "}
            <span className="normal-case tracking-normal text-cream-dim">
              coral dots
            </span>
          </>
        )}
        {" · "}Scale tones ·{" "}
        <span className="normal-case tracking-normal text-cream-dim">
          teal dots
        </span>
      </p>
    </article>
  );
}

function ToggleButton({
  active,
  onToggle,
  label,
}: {
  active: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={[
        "whitespace-nowrap rounded-sm border px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
        active
          ? "border-cat-practice bg-cat-practice/15 text-cream"
          : "border-rule/60 bg-ink-raised/30 text-cream-dim hover:border-cat-practice/60 hover:text-cream",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
