// The CAGED system as a chord explorer: for any chord (root + quality), where
// can you play it up and down the neck using the five C-A-G-E-D shapes?
//
// Nothing here is hardcoded tab. A CAGED shape is modeled as a *fret window*
// anchored to the chord root on one string; the voicing is simply "every chord
// tone that falls inside that window." For triads this reproduces the canonical
// barre shapes exactly; for 7ths the ♭7/7 just appears wherever it lands in the
// window. Every position is derived from pitch-class math against standard
// tuning (lib/practice/theory.ts) and is checked by verifyCaged() — the same
// engine that powers the scale companion, so the two can never disagree.

import type { FretboardNote, FretboardRole } from "@/components/fretboard/types";
import {
  KEYS,
  OPEN_STRING_PITCH,
  keyPitchClass,
  noteNameAt,
  type KeyName,
} from "@/lib/practice/theory";

export type CagedShapeName = "C" | "A" | "G" | "E" | "D";
export type ChordQuality = "major" | "minor" | "dom7" | "maj7" | "min7";
export type CagedLabelMode = "interval" | "note";

// One movable window per shape. `anchorString` is the string whose root defines
// where the shape sits (6 = low E … 1 = high E); the window spans
// [anchorRootFret + lowOff, anchorRootFret + highOff]. `openChord` is the
// open-position chord the shape is the moved-up form of. Offsets derived from
// the open chord voicings: C/G shapes sit below their anchor root (negative
// lowOff), A/E/D shapes sit above it.
type ShapeDef = {
  shape: CagedShapeName;
  anchorString: number;
  lowOff: number;
  highOff: number;
  openChord: string;
};

const SHAPE_DEFS: ShapeDef[] = [
  { shape: "C", anchorString: 5, lowOff: -3, highOff: 0, openChord: "C" },
  { shape: "A", anchorString: 5, lowOff: 0, highOff: 2, openChord: "A" },
  { shape: "G", anchorString: 6, lowOff: -3, highOff: 0, openChord: "G" },
  { shape: "E", anchorString: 6, lowOff: 0, highOff: 2, openChord: "E" },
  { shape: "D", anchorString: 4, lowOff: 0, highOff: 3, openChord: "D" },
];

// Canonical CAGED ordering, used for the shape selector.
export const CAGED_SHAPE_ORDER: CagedShapeName[] = ["C", "A", "G", "E", "D"];

type Tone = { semis: number; label: string; role: FretboardRole };

// Root = root color; 3rd and 7th are the "guide tones" and share the chord
// color; the 5th gets the scale color. Interval labels are unambiguous, so the
// shared color for 3/7 reads fine alongside the label.
const R: Tone = { semis: 0, label: "R", role: "root" };
const FIFTH: Tone = { semis: 7, label: "5", role: "scale" };
const MAJ3: Tone = { semis: 4, label: "3", role: "chord" };
const MIN3: Tone = { semis: 3, label: "♭3", role: "chord" };
const DOM7: Tone = { semis: 10, label: "♭7", role: "chord" };
const MAJ7: Tone = { semis: 11, label: "7", role: "chord" };

const QUALITY_TONES: Record<ChordQuality, Tone[]> = {
  major: [R, MAJ3, FIFTH],
  minor: [R, MIN3, FIFTH],
  dom7: [R, MAJ3, FIFTH, DOM7],
  maj7: [R, MAJ3, FIFTH, MAJ7],
  min7: [R, MIN3, FIFTH, DOM7],
};

const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  major: "",
  minor: "m",
  dom7: "7",
  maj7: "maj7",
  min7: "m7",
};

export const QUALITIES: { value: ChordQuality; label: string }[] = [
  { value: "major", label: "Maj" },
  { value: "minor", label: "Min" },
  { value: "dom7", label: "7" },
  { value: "maj7", label: "maj7" },
  { value: "min7", label: "m7" },
];

export type ShapeVoicing = {
  shape: CagedShapeName;
  openChord: string;
  lowFret: number;
  highFret: number;
  // Human position descriptor, e.g. "open position" / "frets 3–5".
  position: string;
  notes: FretboardNote[];
};

// Lowest fret in [0, 11] where `pc` sounds on a given string.
function lowestFretForPitch(stringNum: number, pc: number): number {
  return (pc - OPEN_STRING_PITCH[stringNum] + 144) % 12;
}

function describePosition(lowFret: number, highFret: number): string {
  if (lowFret === 0) return "open position";
  return `frets ${lowFret}–${highFret}`;
}

export function chordName(key: KeyName, quality: ChordQuality): string {
  return `${key}${QUALITY_SUFFIX[quality]}`;
}

// All five CAGED voicings of (key, quality), each as the chord tones inside its
// window, sorted by where they sit on the neck (ascending). Notes are colored
// by interval role and labeled by interval or note name.
export function cagedVoicings(
  key: KeyName,
  quality: ChordQuality,
  { labelMode = "interval", maxFret = 15 }: {
    labelMode?: CagedLabelMode;
    maxFret?: number;
  } = {},
): ShapeVoicing[] {
  const rootPc = keyPitchClass(key);
  const tones = QUALITY_TONES[quality];
  // pitch class → tone, for fast membership + interval lookup.
  const toneByPc = new Map<number, Tone>();
  for (const t of tones) toneByPc.set((rootPc + t.semis) % 12, t);

  const voicings: ShapeVoicing[] = SHAPE_DEFS.map((def) => {
    const anchorFret = lowestFretForPitch(def.anchorString, rootPc);
    const lowFret = Math.max(0, anchorFret + def.lowOff);
    const highFret = Math.min(maxFret, anchorFret + def.highOff);

    const notes: FretboardNote[] = [];
    for (let s = 1; s <= 6; s++) {
      for (let f = lowFret; f <= highFret; f++) {
        const pc = (OPEN_STRING_PITCH[s] + f) % 12;
        const tone = toneByPc.get(pc);
        if (!tone) continue;
        notes.push({
          string: s as FretboardNote["string"],
          fret: f,
          role: tone.role,
          label: labelMode === "note" ? noteNameAt(s, f, key) : tone.label,
        });
      }
    }

    return {
      shape: def.shape,
      openChord: def.openChord,
      lowFret,
      highFret,
      position: describePosition(lowFret, highFret),
      notes,
    };
  });

  voicings.sort((a, b) => a.lowFret - b.lowFret);
  return voicings;
}

// Correctness gate: for every shape × key × quality, every emitted note must be
// a real chord tone whose interval label matches its pitch class, and every
// shape must contain at least one root. Returns the list of violations (empty =
// all good). Called from the dev playground; cheap enough to run inline.
export function verifyCaged(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const key of KEYS) {
    const rootPc = keyPitchClass(key);
    for (const quality of Object.keys(QUALITY_TONES) as ChordQuality[]) {
      const tones = QUALITY_TONES[quality];
      const expectedLabelByPc = new Map<number, string>();
      for (const t of tones) expectedLabelByPc.set((rootPc + t.semis) % 12, t.label);

      for (const v of cagedVoicings(key, quality)) {
        if (!v.notes.some((n) => n.label === "R")) {
          errors.push(`${key}${quality} ${v.shape}: no root in shape`);
        }
        for (const n of v.notes) {
          const pc = (OPEN_STRING_PITCH[n.string] + n.fret) % 12;
          const expected = expectedLabelByPc.get(pc);
          if (expected === undefined) {
            errors.push(
              `${key}${quality} ${v.shape}: s${n.string}f${n.fret} pc${pc} is not a chord tone`,
            );
          } else if (expected !== n.label) {
            errors.push(
              `${key}${quality} ${v.shape}: s${n.string}f${n.fret} labeled ${n.label}, expected ${expected}`,
            );
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
