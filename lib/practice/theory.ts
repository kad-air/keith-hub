// Music theory helpers scoped to what the practice section needs:
// compute fretboard positions for a given scale in a given key.
// All math is in pitch classes (0–11); no octaves.

import type { FretboardNote } from "@/components/fretboard/types";

// Sharps by default — we'll render flats for specific keys below.
const PITCH_CLASS_NAMES_SHARP = [
  "C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B",
];
const PITCH_CLASS_NAMES_FLAT = [
  "C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B",
];

// Flat keys read better with flats; everything else gets sharps.
const FLAT_KEYS = new Set(["F", "B♭", "E♭", "A♭", "D♭", "G♭"]);

export const KEYS = [
  "C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B",
] as const;
export type KeyName = (typeof KEYS)[number];

// Pitch class of the tonic for each key name. Mixed sharps and flats to match
// how guitarists actually name keys.
const KEY_PITCH_CLASS: Record<KeyName, number> = {
  C: 0,
  "C♯": 1,
  D: 2,
  "E♭": 3,
  E: 4,
  F: 5,
  "F♯": 6,
  G: 7,
  "A♭": 8,
  A: 9,
  "B♭": 10,
  B: 11,
};

export type ScaleKind =
  | "minor_pentatonic"
  | "major_pentatonic"
  | "blues"
  | "major"
  | "natural_minor"
  | "dorian"
  | "mixolydian";

export type ScaleDef = {
  kind: ScaleKind;
  label: string;
  // Semitones above the root, including 0.
  intervals: number[];
  // Intervals that should render as "scale" vs "root". b5 is called out
  // separately so the blues scale can label it distinctly.
  blueNoteInterval?: number;
};

export const SCALES: Record<ScaleKind, ScaleDef> = {
  minor_pentatonic: {
    kind: "minor_pentatonic",
    label: "Minor pentatonic",
    intervals: [0, 3, 5, 7, 10],
  },
  major_pentatonic: {
    kind: "major_pentatonic",
    label: "Major pentatonic",
    intervals: [0, 2, 4, 7, 9],
  },
  blues: {
    kind: "blues",
    label: "Blues (minor pent + ♭5)",
    intervals: [0, 3, 5, 6, 7, 10],
    blueNoteInterval: 6,
  },
  major: {
    kind: "major",
    label: "Major (Ionian)",
    intervals: [0, 2, 4, 5, 7, 9, 11],
  },
  natural_minor: {
    kind: "natural_minor",
    label: "Natural minor (Aeolian)",
    intervals: [0, 2, 3, 5, 7, 8, 10],
  },
  dorian: {
    kind: "dorian",
    label: "Dorian",
    intervals: [0, 2, 3, 5, 7, 9, 10],
  },
  mixolydian: {
    kind: "mixolydian",
    label: "Mixolydian",
    intervals: [0, 2, 4, 5, 7, 9, 10],
  },
};

// Open-string pitch classes in standard tuning, indexed by string 1–6
// (1 = high E, 6 = low E).
const OPEN_STRING_PITCH: Record<number, number> = {
  1: 4,   // E
  2: 11,  // B
  3: 7,   // G
  4: 2,   // D
  5: 9,   // A
  6: 4,   // E
};

export function keyPitchClass(key: KeyName): number {
  return KEY_PITCH_CLASS[key];
}

export function noteNameAt(string: number, fret: number, key: KeyName): string {
  const pc = (OPEN_STRING_PITCH[string] + fret) % 12;
  const names = FLAT_KEYS.has(key)
    ? PITCH_CLASS_NAMES_FLAT
    : PITCH_CLASS_NAMES_SHARP;
  return names[pc];
}

// Compute every fretboard position in [minFret, maxFret] where a note of the
// scale lands. Roots are tagged 'root', b5 (if present) as 'chord' for extra
// visual emphasis, everything else as 'scale'. No labels by default — the
// companion turns labels on for learners.
export function scaleNotes(
  key: KeyName,
  scale: ScaleKind,
  {
    minFret = 0,
    maxFret = 15,
    withLabels = false,
  }: { minFret?: number; maxFret?: number; withLabels?: boolean } = {},
): FretboardNote[] {
  const rootPc = keyPitchClass(key);
  const def = SCALES[scale];
  const scalePcs = new Set(def.intervals.map((i) => (rootPc + i) % 12));
  const bluePc =
    def.blueNoteInterval !== undefined
      ? (rootPc + def.blueNoteInterval) % 12
      : null;

  const out: FretboardNote[] = [];
  for (let s = 1; s <= 6; s++) {
    const openPc = OPEN_STRING_PITCH[s];
    for (let f = minFret; f <= maxFret; f++) {
      const pc = (openPc + f) % 12;
      if (!scalePcs.has(pc)) continue;
      const role: FretboardNote["role"] =
        pc === rootPc ? "root" : pc === bluePc ? "chord" : "scale";
      out.push({
        string: s as FretboardNote["string"],
        fret: f,
        role,
        label: withLabels ? noteNameAt(s, f, key) : undefined,
      });
    }
  }
  return out;
}

// "Box 1" of a pentatonic lives within a 4-fret window starting on the
// 6th-string root. For A minor pentatonic that's frets 5–8, matching the
// Justin Sandercoe / box-1 convention used in our research brief.
export function box1Window(key: KeyName): { minFret: number; maxFret: number } {
  const rootPc = keyPitchClass(key);
  const root6 = (rootPc - 4 + 12) % 12; // pc-4 puts E (open 6th) at 0.
  return { minFret: root6, maxFret: root6 + 3 };
}
