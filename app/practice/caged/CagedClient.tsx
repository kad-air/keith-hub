"use client";

import { useMemo, useState } from "react";
import { Fretboard } from "@/components/fretboard/Fretboard";
import type { FretboardNote } from "@/components/fretboard/types";
import {
  CAGED_SHAPE_ORDER,
  QUALITIES,
  cagedVoicings,
  chordName,
  type CagedLabelMode,
  type CagedShapeName,
  type ChordQuality,
} from "@/lib/practice/caged";
import { KEYS, type KeyName } from "@/lib/practice/theory";

type Focus = CagedShapeName | "all";

const noteKey = (n: FretboardNote) => `${n.string}:${n.fret}`;

function dedupe(notes: FretboardNote[]): FretboardNote[] {
  const seen = new Set<string>();
  const out: FretboardNote[] = [];
  for (const n of notes) {
    const k = noteKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

export function CagedClient() {
  const [key, setKey] = useState<KeyName>("G");
  const [quality, setQuality] = useState<ChordQuality>("major");
  const [focus, setFocus] = useState<Focus>("all");
  const [labelMode, setLabelMode] = useState<CagedLabelMode>("interval");

  const voicings = useMemo(
    () => cagedVoicings(key, quality, { labelMode }),
    [key, quality, labelMode],
  );

  const focused = useMemo(
    () => (focus === "all" ? null : voicings.find((v) => v.shape === focus)),
    [voicings, focus],
  );

  // In "all" mode every voicing is colored (deduped on shared notes). In focus
  // mode the chosen shape is colored and the rest are ghosted underneath —
  // minus any positions the focused shape already occupies, so nothing
  // double-draws.
  const notes = useMemo<FretboardNote[]>(() => {
    if (focus === "all") {
      return dedupe(voicings.flatMap((v) => v.notes));
    }
    if (!focused) return [];
    const litKeys = new Set(focused.notes.map(noteKey));
    const ghosts = dedupe(
      voicings
        .filter((v) => v.shape !== focus)
        .flatMap((v) => v.notes)
        .filter((n) => !litKeys.has(noteKey(n))),
    ).map<FretboardNote>((n) => ({ ...n, role: "ghost", label: undefined }));
    return [...ghosts, ...focused.notes];
  }, [voicings, focus, focused]);

  const chord = chordName(key, quality);

  return (
    <article className="mx-auto max-w-[900px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
          Practice · CAGED
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">
          {chord} across the neck
        </h1>
        <p className="mt-1 text-sm text-cream-dim">
          The same chord, five shapes. They interlock up the neck in
          C&#8211;A&#8211;G&#8211;E&#8211;D order, each sharing notes with its
          neighbors.
        </p>
      </header>

      <div className="mb-4 space-y-3">
        <fieldset className="flex flex-wrap items-center gap-1 rounded-sm border border-rule/60 bg-ink-raised/30 p-1">
          <legend className="sr-only">Root</legend>
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

        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="flex flex-wrap items-center gap-1 rounded-sm border border-rule/60 bg-ink-raised/30 p-1">
            <legend className="sr-only">Quality</legend>
            {QUALITIES.map((q) => {
              const active = q.value === quality;
              return (
                <button
                  key={q.value}
                  type="button"
                  onClick={() => setQuality(q.value)}
                  aria-pressed={active}
                  className={[
                    "px-2.5 py-1 font-mono text-[0.7rem] transition-colors",
                    active
                      ? "bg-cat-practice text-ink"
                      : "text-cream-dim hover:bg-ink-hover hover:text-cream",
                  ].join(" ")}
                >
                  {q.label}
                </button>
              );
            })}
          </fieldset>

          <ToggleButton
            active={labelMode === "note"}
            onToggle={() =>
              setLabelMode((m) => (m === "interval" ? "note" : "interval"))
            }
            label={labelMode === "note" ? "Notes" : "Intervals"}
          />
        </div>

        <fieldset className="flex flex-wrap items-center gap-1 rounded-sm border border-rule/60 bg-ink-raised/30 p-1">
          <legend className="sr-only">Shape</legend>
          <ShapeChip
            label="All"
            active={focus === "all"}
            onClick={() => setFocus("all")}
          />
          {CAGED_SHAPE_ORDER.map((s) => (
            <ShapeChip
              key={s}
              label={s}
              active={focus === s}
              onClick={() => setFocus(s)}
            />
          ))}
        </fieldset>
      </div>

      <div className="rounded-lg border border-rule/60 bg-ink-raised/30 p-3 sm:p-4">
        <Fretboard
          notes={notes}
          frets={15}
          ariaLabel={`${chord} CAGED shapes`}
        />
      </div>

      <p className="mt-4 text-sm text-cream-dim">
        {focused ? (
          <>
            <span className="text-cream">{focused.shape} shape</span> ·{" "}
            {focused.position} · from the open {focused.openChord} chord
          </>
        ) : (
          <>All five shapes — tap a letter to isolate one.</>
        )}
      </p>

      <p className="mt-3 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
        Root ·{" "}
        <span className="normal-case tracking-normal text-cream-dim">
          amber
        </span>
        {" · "}3rd &amp; 7th ·{" "}
        <span className="normal-case tracking-normal text-cream-dim">
          coral
        </span>
        {" · "}5th ·{" "}
        <span className="normal-case tracking-normal text-cream-dim">teal</span>
      </p>
    </article>
  );
}

function ShapeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "min-w-[2.25rem] px-2.5 py-1 font-mono text-[0.75rem] transition-colors",
        active
          ? "bg-cat-practice text-ink"
          : "text-cream-dim hover:bg-ink-hover hover:text-cream",
      ].join(" ")}
    >
      {label}
    </button>
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
