export type FretboardRole = "root" | "chord" | "scale" | "ghost";

// Strings numbered 1-6 per guitar convention: 1 = high E, 6 = low E.
// Fret 0 = open string (rendered at the nut).
export type FretboardNote = {
  string: 1 | 2 | 3 | 4 | 5 | 6;
  fret: number;
  label?: string;
  role: FretboardRole;
};

export type FretboardCapo = {
  fret: number;
  fromString: 1 | 2 | 3 | 4 | 5 | 6;
  toString: 1 | 2 | 3 | 4 | 5 | 6;
};

export type FretboardProps = {
  notes?: FretboardNote[];
  frets?: number;
  orientation?: "horizontal" | "vertical";
  showFretNumbers?: boolean;
  showStringNames?: boolean;
  capo?: FretboardCapo;
  onTap?: (stringNum: 1 | 2 | 3 | 4 | 5 | 6, fret: number) => void;
  className?: string;
  ariaLabel?: string;
};
