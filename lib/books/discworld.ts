// The Discworld Reading Order Guide — the graph, and the rules that decide
// whether a node is read.
//
// PURE: no fs, no DB, no React. The impure edge is discworldData.ts. Keeping
// this side dependency-free is what lets scripts/check-books-discworld.ts
// drive the REAL matching and status rules rather than a re-implementation of
// them, the same arrangement stats.ts / statsData.ts already use.
//
// 🔴 The graph is a TRANSCRIPTION of the printed poster ("The Discworld
// Reading Order Guide 3.0", Krzysztof Kietzman / Jakub Oleksów / Andrés Peña),
// not a derivation from anything. Node positions are the poster's layout in
// grid units; edges are the poster's solid ("direct") and dotted ("minor")
// connections as drawn. It is meant to be hand-edited — if a connection here
// disagrees with the poster, the poster is right and this file is a typo.
//
// 🔴 `pubOrder` is a DIFFERENT thing from the poster and is NOT editable to
// taste: it is Discworld publication order, an external fact about the world,
// and it is the primary key the library match runs on (a hub book row carries
// series='Discworld' + series_index=<pubOrder>). It is non-null for exactly
// the 41 canon novels; the science books, short stories and companion volumes
// on the poster are not novels and carry null. check:books:discworld pins the
// 41, their order, and their publication years.

/** Poster legend, verbatim. Drives the node fill colour. */
export type NodeKind =
  | "starter"
  | "standard"
  | "ya"
  | "short"
  | "science"
  | "illustrated";

/** Poster legend: a solid line is a direct connection, dotted is minor. */
export type EdgeKind = "direct" | "minor";

export type DiscworldNode = {
  id: string;
  title: string;
  kind: NodeKind;
  /** Discworld publication number, 1–41. Null for everything that is not one
   *  of the 41 novels (science books, short stories, companion volumes). */
  pubOrder: number | null;
  /** First publication year — an external fact, asserted monotonic against
   *  pubOrder by the gate so a transposed pair can't sit here unnoticed. */
  year: number;
  /** Poster layout, in grid units. x is the column, y the row; both are
   *  fractional because the poster's minor works sit between rows. */
  x: number;
  y: number;
  /** Extra titles a library row might legitimately carry for this book —
   *  the match falls back to these when series_index is absent. Compared
   *  after normalizeTitle(), so case/punctuation/articles are already gone. */
  aliases?: string[];
};

export type DiscworldEdge = { from: string; to: string; kind: EdgeKind };

/** A named reading line on the poster, set in the margin beside its row. */
export type DiscworldSequence = {
  key: string;
  /** Set on two lines like the poster does, so the label fits the margin
   *  instead of running across the row it names. Explicit rather than
   *  auto-wrapped: "Moist von Lipwig" is one line on the poster and
   *  "Ancient Civilizations" is two. */
  lines: string[];
  /** Where the text is pinned. "end" pins its RIGHT edge, so the label grows
   *  leftwards into empty margin and can never creep over the first coin. */
  anchor: "start" | "end";
  x: number;
  y: number;
};

/**
 * The drawing geometry, shared by the renderer and the gate.
 *
 * 🔴 It lives here, not in the component, so check:books:discworld can assert
 * things about the PICTURE — that no two coins overlap, that no sequence label
 * lands on top of one, that nothing is drawn outside the canvas. Those are
 * real failures (a coin hidden under another can never be tapped, so it can
 * never be ticked) and they are invisible to every other kind of test.
 */
export const LAYOUT = {
  /** Grid units → viewBox units. */
  cellX: 150,
  cellY: 150,
  /** Coin radius, in viewBox units. */
  r: 58,
  /** Sequence-label type size and line spacing, in viewBox units. */
  labelSize: 34,
  labelLineHeight: 37,
  /**
   * Per-character width used to bound a sequence label's footprint for the
   * collision and containment assertions.
   *
   * 🔴 MEASURED in the browser across all nine labels at labelSize, then
   * rounded UP to the worst case: Almendra SC ranges from 16.1 units/char on
   * "Civilizations" to 21.8 on "Novels", because character count is a poor
   * proxy for the width of proportional type. The bound has to hold for the
   * WIDEST ratio or the assertion can pass on a label that actually overflows,
   * so 22 it is — deliberately loose on long words, and the canvas carries the
   * extra margin that costs (see `view`). Re-measure if the face or the size
   * changes; the check prints the margin it had, so drift surfaces early.
   */
  labelCharWidth: 22,
  /**
   * How far a margin label is pushed away from its row's first coin, leaving
   * room for the red arrow that points from the label into the row.
   * 🔴 Counted in the collision AND containment assertions — pushing "end"
   * labels further left is what can walk them off the left edge of the canvas.
   */
  seqShift: 80,
  /**
   * Connection arrows are trimmed back to the coin rims so the arrowhead
   * lands on the edge rather than under the next coin.
   *
   * 🔴 The two trims sum to more than the closest pair of coins are apart
   * (theatre-of-cruelty / guards-guards sit 129 units apart against a 132-unit
   * total trim), so an untreated trim makes that arrow point BACKWARDS. The
   * renderer scales both trims down when an edge is too short to afford them;
   * arrowMinVisible is the length that must survive. Asserted.
   */
  arrowTrimStart: 62,
  arrowTrimEnd: 70,
  arrowMinVisible: 8,
  /** The whole poster, with margin for the labels. Fixed rather than computed
   *  so "Fit" frames the same thing every time.
   *  🔴 The left edge is -470, not the -400 the layout would otherwise need:
   *  the margin labels are pinned seqShift further out and bounded by the
   *  conservative labelCharWidth above, and "Ancient / Civilizations" is the
   *  one that needs the room. Narrowing this without re-measuring walks that
   *  label off the canvas — which is why the gate asserts containment. */
  view: { x: -470, y: -110, w: 1970, h: 1440 },
} as const;

// ── Nodes ────────────────────────────────────────────────────────────────────
// Rows, top to bottom, as the poster lays them out.

export const DISCWORLD_NODES: DiscworldNode[] = [
  // Science novels (top right) + Troll Bridge.
  { id: "troll-bridge", title: "Troll Bridge", kind: "short", pubOrder: null, year: 1992, x: 3.0, y: 0 },
  { id: "science-1", title: "The Science of Discworld", kind: "science", pubOrder: null, year: 1999, x: 5.9, y: 0 },
  { id: "science-2", title: "The Science of Discworld II — The Globe", kind: "science", pubOrder: null, year: 2002, x: 6.9, y: 0, aliases: ["the science of discworld ii the globe", "the globe"] },
  { id: "science-3", title: "The Science of Discworld III — Darwin's Watch", kind: "science", pubOrder: null, year: 2005, x: 7.9, y: 0, aliases: ["the science of discworld iii darwins watch", "darwins watch"] },
  { id: "science-4", title: "The Science of Discworld IV — Judgement Day", kind: "science", pubOrder: null, year: 2013, x: 8.8, y: 0, aliases: ["the science of discworld iv judgement day", "judgement day"] },

  // Rincewind.
  { id: "colour-of-magic", title: "The Colour of Magic", kind: "starter", pubOrder: 1, year: 1983, x: 0, y: 1, aliases: ["the color of magic"] },
  { id: "light-fantastic", title: "The Light Fantastic", kind: "standard", pubOrder: 2, year: 1986, x: 1, y: 1 },
  { id: "sourcery", title: "Sourcery", kind: "standard", pubOrder: 5, year: 1988, x: 2, y: 1 },
  { id: "eric", title: "Faust Eric", kind: "illustrated", pubOrder: 9, year: 1990, x: 3, y: 1, aliases: ["eric"] },
  { id: "interesting-times", title: "Interesting Times", kind: "standard", pubOrder: 17, year: 1994, x: 4, y: 1 },
  { id: "last-continent", title: "The Last Continent", kind: "standard", pubOrder: 22, year: 1998, x: 5, y: 1 },
  { id: "last-hero", title: "The Last Hero", kind: "illustrated", pubOrder: 27, year: 2001, x: 6, y: 1 },
  { id: "unseen-academicals", title: "Unseen Academicals", kind: "standard", pubOrder: 37, year: 2009, x: 7, y: 1 },
  { id: "collegiate-casting-out", title: "A Collegiate Casting-out of Devilish Devices", kind: "short", pubOrder: null, year: 2005, x: 8, y: 1 },

  // Industrial Revolution → Moist von Lipwig.
  { id: "moving-pictures", title: "Moving Pictures", kind: "starter", pubOrder: 10, year: 1990, x: 3.35, y: 2 },
  { id: "the-truth", title: "The Truth", kind: "standard", pubOrder: 25, year: 2000, x: 4.5, y: 2 },
  { id: "monstrous-regiment", title: "Monstrous Regiment", kind: "standard", pubOrder: 31, year: 2003, x: 5.5, y: 2 },
  { id: "going-postal", title: "Going Postal", kind: "standard", pubOrder: 33, year: 2004, x: 6.5, y: 2 },
  { id: "making-money", title: "Making Money", kind: "standard", pubOrder: 36, year: 2007, x: 7.5, y: 2 },
  { id: "raising-steam", title: "Raising Steam", kind: "standard", pubOrder: 40, year: 2013, x: 8.4, y: 2 },
  { id: "mrs-bradshaws", title: "Mrs Bradshaw's Handbook", kind: "illustrated", pubOrder: null, year: 2014, x: 9.1, y: 2.7, aliases: ["mrs bradshaws handbook to travelling upon the ankh morpork and sto plains hygienic railway"] },

  // Watch.
  { id: "theatre-of-cruelty", title: "Theatre of Cruelty", kind: "short", pubOrder: null, year: 1993, x: 0.5, y: 2.7 },
  { id: "guards-guards", title: "Guards! Guards!", kind: "starter", pubOrder: 8, year: 1989, x: 0, y: 3.4 },
  { id: "men-at-arms", title: "Men at Arms", kind: "standard", pubOrder: 15, year: 1993, x: 1, y: 3.4 },
  { id: "feet-of-clay", title: "Feet of Clay", kind: "standard", pubOrder: 19, year: 1996, x: 2, y: 3.4 },
  { id: "jingo", title: "Jingo", kind: "standard", pubOrder: 21, year: 1997, x: 3, y: 3.4 },
  { id: "fifth-elephant", title: "The Fifth Elephant", kind: "standard", pubOrder: 24, year: 1999, x: 4, y: 3.4 },
  { id: "night-watch", title: "Night Watch", kind: "standard", pubOrder: 29, year: 2002, x: 5, y: 3.4 },
  { id: "thud", title: "Thud!", kind: "standard", pubOrder: 34, year: 2005, x: 6, y: 3.4 },
  { id: "snuff", title: "Snuff", kind: "standard", pubOrder: 39, year: 2011, x: 7, y: 3.4 },

  // Death, and the Watch's companion volumes on the same band.
  { id: "mort", title: "Mort", kind: "starter", pubOrder: 4, year: 1987, x: 0, y: 4.4 },
  { id: "reaper-man", title: "Reaper Man", kind: "standard", pubOrder: 11, year: 1991, x: 1, y: 4.4 },
  { id: "soul-music", title: "Soul Music", kind: "standard", pubOrder: 16, year: 1994, x: 2, y: 4.4 },
  { id: "hogfather", title: "Hogfather", kind: "standard", pubOrder: 20, year: 1996, x: 3, y: 4.4 },
  { id: "thief-of-time", title: "Thief of Time", kind: "standard", pubOrder: 26, year: 2001, x: 4, y: 4.4 },
  { id: "wheres-my-cow", title: "Where's My Cow?", kind: "illustrated", pubOrder: null, year: 2005, x: 5.9, y: 4.4 },
  { id: "minutes-of-the-meeting", title: "Minutes of the Meeting to Form the Proposed Ankh-Morpork Federation of Scouts", kind: "short", pubOrder: null, year: 2011, x: 6.8, y: 4.4 },
  { id: "world-of-poo", title: "The World of Poo", kind: "illustrated", pubOrder: null, year: 2012, x: 7.7, y: 4.4 },

  // The band between Death and Ancient Civilizations.
  { id: "death-and-what-comes-next", title: "Death and What Comes Next", kind: "short", pubOrder: null, year: 2002, x: 0.55, y: 5.4 },
  { id: "amazing-maurice", title: "The Amazing Maurice and his Educated Rodents", kind: "ya", pubOrder: 28, year: 2001, x: 4.6, y: 5.4, aliases: ["the amazing maurice and his educated rodents"] },

  // Ancient Civilizations + Tiffany Aching share a row.
  { id: "pyramids", title: "Pyramids", kind: "starter", pubOrder: 7, year: 1989, x: 0, y: 6.2 },
  { id: "small-gods", title: "Small Gods", kind: "standard", pubOrder: 13, year: 1992, x: 1, y: 6.2 },
  { id: "wee-free-men", title: "The Wee Free Men", kind: "ya", pubOrder: 30, year: 2003, x: 5.0, y: 6.2 },
  { id: "hat-full-of-sky", title: "A Hat Full of Sky", kind: "ya", pubOrder: 32, year: 2004, x: 6.0, y: 6.2 },
  { id: "wintersmith", title: "Wintersmith", kind: "ya", pubOrder: 35, year: 2006, x: 7.0, y: 6.2 },
  { id: "i-shall-wear-midnight", title: "I Shall Wear Midnight", kind: "ya", pubOrder: 38, year: 2010, x: 8.0, y: 6.2 },
  { id: "shepherds-crown", title: "The Shepherd's Crown", kind: "ya", pubOrder: 41, year: 2015, x: 8.9, y: 6.2 },

  // Witches.
  { id: "equal-rites", title: "Equal Rites", kind: "starter", pubOrder: 3, year: 1987, x: 0, y: 7.3 },
  { id: "wyrd-sisters", title: "Wyrd Sisters", kind: "standard", pubOrder: 6, year: 1988, x: 1, y: 7.3 },
  { id: "witches-abroad", title: "Witches Abroad", kind: "standard", pubOrder: 12, year: 1991, x: 2, y: 7.3 },
  { id: "lords-and-ladies", title: "Lords and Ladies", kind: "standard", pubOrder: 14, year: 1992, x: 3, y: 7.3 },
  { id: "maskerade", title: "Maskerade", kind: "standard", pubOrder: 18, year: 1995, x: 4, y: 7.3 },
  { id: "carpe-jugulum", title: "Carpe Jugulum", kind: "standard", pubOrder: 23, year: 1998, x: 4.9, y: 7.3 },
  { id: "nanny-oggs-cookbook", title: "Nanny Ogg's Cookbook", kind: "illustrated", pubOrder: null, year: 1999, x: 3.5, y: 8.1 },
  { id: "sea-and-little-fishes", title: "The Sea and Little Fishes", kind: "short", pubOrder: null, year: 1998, x: 4.5, y: 8.1 },
];

// ── Edges ────────────────────────────────────────────────────────────────────

export const DISCWORLD_EDGES: DiscworldEdge[] = [
  // Science novels.
  { from: "science-1", to: "science-2", kind: "direct" },
  { from: "science-2", to: "science-3", kind: "direct" },
  { from: "science-3", to: "science-4", kind: "direct" },

  // Rincewind.
  { from: "colour-of-magic", to: "light-fantastic", kind: "direct" },
  { from: "light-fantastic", to: "sourcery", kind: "direct" },
  { from: "sourcery", to: "eric", kind: "direct" },
  { from: "eric", to: "interesting-times", kind: "direct" },
  { from: "interesting-times", to: "last-continent", kind: "direct" },
  { from: "last-continent", to: "last-hero", kind: "direct" },
  { from: "last-hero", to: "unseen-academicals", kind: "direct" },
  { from: "unseen-academicals", to: "collegiate-casting-out", kind: "direct" },
  { from: "sourcery", to: "troll-bridge", kind: "minor" },

  // Industrial Revolution → Moist von Lipwig.
  { from: "moving-pictures", to: "the-truth", kind: "direct" },
  { from: "the-truth", to: "monstrous-regiment", kind: "direct" },
  { from: "monstrous-regiment", to: "going-postal", kind: "minor" },
  { from: "going-postal", to: "making-money", kind: "direct" },
  { from: "making-money", to: "raising-steam", kind: "direct" },
  { from: "raising-steam", to: "mrs-bradshaws", kind: "direct" },
  { from: "eric", to: "moving-pictures", kind: "minor" },
  { from: "interesting-times", to: "the-truth", kind: "minor" },
  { from: "monstrous-regiment", to: "unseen-academicals", kind: "minor" },

  // Watch.
  { from: "guards-guards", to: "men-at-arms", kind: "direct" },
  { from: "men-at-arms", to: "feet-of-clay", kind: "direct" },
  { from: "feet-of-clay", to: "jingo", kind: "direct" },
  { from: "jingo", to: "fifth-elephant", kind: "direct" },
  { from: "fifth-elephant", to: "night-watch", kind: "direct" },
  { from: "night-watch", to: "thud", kind: "direct" },
  { from: "thud", to: "snuff", kind: "direct" },
  { from: "theatre-of-cruelty", to: "guards-guards", kind: "minor" },
  { from: "fifth-elephant", to: "the-truth", kind: "minor" },
  { from: "night-watch", to: "monstrous-regiment", kind: "minor" },
  { from: "thud", to: "wheres-my-cow", kind: "direct" },
  { from: "thud", to: "minutes-of-the-meeting", kind: "minor" },
  { from: "snuff", to: "minutes-of-the-meeting", kind: "minor" },
  { from: "snuff", to: "world-of-poo", kind: "minor" },

  // Death.
  { from: "mort", to: "reaper-man", kind: "direct" },
  { from: "reaper-man", to: "soul-music", kind: "direct" },
  { from: "soul-music", to: "hogfather", kind: "direct" },
  { from: "hogfather", to: "thief-of-time", kind: "direct" },
  { from: "thief-of-time", to: "night-watch", kind: "minor" },
  { from: "thief-of-time", to: "small-gods", kind: "minor" },

  // Ancient Civilizations.
  { from: "pyramids", to: "small-gods", kind: "minor" },
  { from: "death-and-what-comes-next", to: "pyramids", kind: "minor" },
  { from: "death-and-what-comes-next", to: "small-gods", kind: "minor" },

  // Tiffany Aching.
  { from: "wee-free-men", to: "hat-full-of-sky", kind: "direct" },
  { from: "hat-full-of-sky", to: "wintersmith", kind: "direct" },
  { from: "wintersmith", to: "i-shall-wear-midnight", kind: "direct" },
  { from: "i-shall-wear-midnight", to: "shepherds-crown", kind: "direct" },
  { from: "amazing-maurice", to: "wee-free-men", kind: "minor" },
  { from: "carpe-jugulum", to: "wee-free-men", kind: "minor" },

  // Witches.
  { from: "equal-rites", to: "wyrd-sisters", kind: "minor" },
  { from: "wyrd-sisters", to: "witches-abroad", kind: "direct" },
  { from: "witches-abroad", to: "lords-and-ladies", kind: "direct" },
  { from: "lords-and-ladies", to: "maskerade", kind: "direct" },
  { from: "maskerade", to: "carpe-jugulum", kind: "direct" },
  { from: "maskerade", to: "nanny-oggs-cookbook", kind: "direct" },
  { from: "maskerade", to: "sea-and-little-fishes", kind: "minor" },
  { from: "carpe-jugulum", to: "sea-and-little-fishes", kind: "minor" },
];

// ── Sequence labels ──────────────────────────────────────────────────────────

export const DISCWORLD_SEQUENCES: DiscworldSequence[] = [
  { key: "science", lines: ["Science", "Novels"], anchor: "end", x: 5.3, y: 0 },
  { key: "rincewind", lines: ["Rincewind", "Novels"], anchor: "end", x: -0.55, y: 1 },
  { key: "industrial", lines: ["Industrial", "Revolution"], anchor: "end", x: 2.78, y: 2 },
  { key: "moist", lines: ["Moist von Lipwig"], anchor: "start", x: 6.15, y: 2.72 },
  { key: "watch", lines: ["Watch", "Novels"], anchor: "end", x: -0.55, y: 3.4 },
  { key: "death", lines: ["Death", "Novels"], anchor: "end", x: -0.55, y: 4.4 },
  { key: "ancient", lines: ["Ancient", "Civilizations"], anchor: "end", x: -0.55, y: 6.2 },
  { key: "tiffany", lines: ["Tiffany", "Aching"], anchor: "end", x: 4.42, y: 6.2 },
  { key: "witches", lines: ["Witches", "Novels"], anchor: "end", x: -0.55, y: 7.3 },
];

/**
 * A connection, trimmed back to the two coin rims so its arrowhead lands on
 * the target's edge rather than under it.
 *
 * 🔴 Lives here, in the pure module, so the renderer and the gate run the SAME
 * arithmetic — a copy of it in the check would verify the check, not the map.
 *
 * 🔴 The two trims sum to 132 units and the closest pair of coins on the
 * poster is 129 apart, so on eight of the edges they do not fit. The minimum
 * visible shaft is reserved FIRST and the trims share what is left; scaling
 * both by len/need (the obvious version) still leaves a shaft shorter than the
 * minimum on every short edge, and past that the shaft inverts and the arrow
 * points backwards down the reading order.
 */
export function trimEdge(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { sx: number; sy: number; ex: number; ey: number; visible: number; endTrim: number } {
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  const totalTrim = LAYOUT.arrowTrimStart + LAYOUT.arrowTrimEnd;
  const avail = Math.max(0, len - LAYOUT.arrowMinVisible);
  const k = avail < totalTrim ? avail / totalTrim : 1;
  const startTrim = LAYOUT.arrowTrimStart * k;
  const endTrim = LAYOUT.arrowTrimEnd * k;
  return {
    sx: ax + ux * startTrim,
    sy: ay + uy * startTrim,
    ex: bx - ux * endTrim,
    ey: by - uy * endTrim,
    visible: len - startTrim - endTrim,
    endTrim,
  };
}

/**
 * Does this margin label have room for the red arrow that points from it into
 * the row it names? Mirrors the renderer exactly.
 * 🔴 The answer is what `seqShift` is FOR: with no shift the label sits close
 * enough to the row's first coin that the arrow is silently dropped, which
 * looks like a styling choice rather than a regression.
 */
export function seqArrowSpan(
  seq: DiscworldSequence,
  firstCoinX: number,
): { x1: number; x2: number; drawn: boolean } {
  const x1 = seq.x * LAYOUT.cellX - LAYOUT.seqShift + 12;
  const x2 = firstCoinX * LAYOUT.cellX - LAYOUT.r - 10;
  return { x1, x2, drawn: x2 - x1 >= 26 };
}

// ── The library match ────────────────────────────────────────────────────────

/** What the matcher needs from a library row. Structural on purpose: the gate
 *  drives it with committed fixture rows, the app passes real `Book`s. */
export type DiscworldLibraryBook = {
  id: string;
  title: string;
  series: string | null;
  seriesIndex: number | null;
  partialMd5: string;
};

/**
 * Fold a title down to something two sources can agree on: lowercase, no
 * diacritics, no punctuation, no leading article, "and" for "&", and no
 * trailing subtitle after a colon or dash.
 *
 * Deliberately lossy — it is a FALLBACK. The primary key is series_index,
 * which is a number and cannot be mangled by an em dash.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

const isDiscworldSeries = (series: string | null): boolean =>
  series != null && normalizeTitle(series) === "discworld";

/**
 * Which library row, if any, is each node.
 *
 * 🔴 BOTH keys are needed, and that is the load-bearing part:
 *
 *  1. series='Discworld' + series_index === pubOrder. Publication order is an
 *     external fact and the epub's own OPF carries it as a number, which
 *     survives every title variation a publisher can invent. Measured, not
 *     assumed: the reader's real Men at Arms file has the dc:title
 *     "Pratchett, Terry - Discworld 15 - Men at Arms", which matches no node
 *     at all — only its index places it.
 *  2. Normalized title, plus the node's declared aliases. Covers a book whose
 *     OPF has no series data at all — common enough to matter (see CLAUDE.md:
 *     metadata comes from the epub, never from the folder).
 *
 * When a Discworld-flagged row's two keys DISAGREE, the index wins. That is a
 * deliberate tie-break rather than a safety property: the number is what the
 * publisher set, and this library has already been caught shipping a title
 * with the author and series glued to the front. A row with no series data
 * skips straight to the title, where there is nothing to disagree with.
 *
 * A row that matches nothing is returned in `unmatched` rather than dropped —
 * the page says so on screen, because a Discworld book the map can't see is
 * exactly the failure that would otherwise look like "I haven't read that one".
 */
export function matchLibrary(books: DiscworldLibraryBook[]): {
  byNode: Map<string, DiscworldLibraryBook>;
  unmatched: DiscworldLibraryBook[];
} {
  const byPubOrder = new Map<number, DiscworldNode>();
  const byTitle = new Map<string, DiscworldNode>();
  for (const n of DISCWORLD_NODES) {
    if (n.pubOrder != null) byPubOrder.set(n.pubOrder, n);
    byTitle.set(normalizeTitle(n.title), n);
    for (const alias of n.aliases ?? []) byTitle.set(normalizeTitle(alias), n);
  }

  const byNode = new Map<string, DiscworldLibraryBook>();
  const unmatched: DiscworldLibraryBook[] = [];
  for (const book of books) {
    let node: DiscworldNode | undefined;
    if (isDiscworldSeries(book.series) && book.seriesIndex != null) {
      node = byPubOrder.get(book.seriesIndex);
    }
    node ??= byTitle.get(normalizeTitle(book.title));

    // A title-only match on a book that isn't flagged Discworld is still a
    // match — but only count a row as "unmatched Discworld" when the series
    // says so, or the whole library would show up as missing from the map.
    if (node) {
      if (!byNode.has(node.id)) byNode.set(node.id, book);
    } else if (isDiscworldSeries(book.series)) {
      unmatched.push(book);
    }
  }
  return { byNode, unmatched };
}

// ── Status ───────────────────────────────────────────────────────────────────

/** Derived from the library + the sync log. Never stored. */
export type AutoStatus = "absent" | "owned" | "reading" | "finished";
/** The reader's own mark, stored in discworld_state. Wins over AutoStatus. */
export type ManualStatus = "read" | "reading" | "skipped";
/** What the map paints. */
export type NodeStatus = AutoStatus | "skipped";

export type NodeSync = {
  /** 0..1, the kosync percentage (opaque position aside — this is the number
   *  the device reports alongside it). */
  percentage: number;
  timestamp: number;
};

/**
 * The auto rule, in one place.
 *
 * `finishThreshold` is a REQUIRED parameter rather than a local constant: the
 * only correct value is stats.ts's FINISH_THRESHOLD, and a second copy of 0.97
 * in this file is a number that can drift away from the one the streak, the
 * heatmap and the finish list all use. The gate asserts this file contains no
 * literal threshold of its own.
 */
export function autoStatus(
  book: DiscworldLibraryBook | undefined,
  sync: NodeSync | undefined,
  everFinished: boolean,
  finishThreshold: number,
): AutoStatus {
  if (!book) return "absent";
  if (everFinished) return "finished";
  if (!sync) return "owned";
  if (sync.percentage >= finishThreshold) return "finished";
  // A device that has synced but hasn't moved off zero is on the title page,
  // which is "owned", not "reading" — otherwise every book pushed to the X3
  // lights up as in progress the moment it is opened once.
  return sync.percentage > 0 ? "reading" : "owned";
}

/**
 * 🔴 The manual mark wins, always, including when it is LESS advanced than the
 * sync. The reader is the authority on what they have read: the log only began
 * the day reading_events shipped (see lib/db.ts), so most of a lifetime of
 * Discworld is invisible to it and has to be assertable by hand — and a manual
 * mark that a later sync could silently overwrite would make the map lie about
 * the one thing the reader told it directly.
 *
 * Clearing the mark (no row) hands the node straight back to the sync.
 */
export function resolveStatus(auto: AutoStatus, manual: ManualStatus | undefined): NodeStatus {
  if (manual === "read") return "finished";
  if (manual === "reading") return "reading";
  if (manual === "skipped") return "skipped";
  return auto;
}

export type NodeState = {
  node: DiscworldNode;
  status: NodeStatus;
  auto: AutoStatus;
  manual: ManualStatus | null;
  bookId: string | null;
  percentage: number | null;
  lastReadAt: number | null;
};

export type DiscworldProgress = {
  states: NodeState[];
  /** Of the 41 canon novels only — the headline number. */
  novels: { read: number; reading: number; total: number };
  /** Everything on the poster, novels and companions alike. */
  all: { read: number; total: number };
  unmatched: DiscworldLibraryBook[];
};

export type DiscworldInput = {
  books: DiscworldLibraryBook[];
  /** Keyed by partial_md5 — the kosync document key (BOOKS_PLAN §4). */
  syncByDocument: Map<string, NodeSync>;
  /** partial_md5s that have ever crossed the finish threshold, from the
   *  reading-events model. A book finished and then re-opened at 2% is still
   *  finished. */
  finishedDocuments: Set<string>;
  manual: Map<string, ManualStatus>;
  finishThreshold: number;
};

/** The whole map's state, in one pass. Pure — the gate drives this directly. */
export function computeDiscworldProgress(input: DiscworldInput): DiscworldProgress {
  const { byNode, unmatched } = matchLibrary(input.books);

  const states: NodeState[] = DISCWORLD_NODES.map((node) => {
    const book = byNode.get(node.id);
    const sync = book ? input.syncByDocument.get(book.partialMd5) : undefined;
    const everFinished = book ? input.finishedDocuments.has(book.partialMd5) : false;
    const auto = autoStatus(book, sync, everFinished, input.finishThreshold);
    const manual = input.manual.get(node.id) ?? null;
    return {
      node,
      status: resolveStatus(auto, manual ?? undefined),
      auto,
      manual,
      bookId: book?.id ?? null,
      percentage: sync?.percentage ?? null,
      lastReadAt: sync?.timestamp ?? null,
    };
  });

  const novelStates = states.filter((s) => s.node.pubOrder != null);
  return {
    states,
    novels: {
      read: novelStates.filter((s) => s.status === "finished").length,
      reading: novelStates.filter((s) => s.status === "reading").length,
      total: novelStates.length,
    },
    all: {
      read: states.filter((s) => s.status === "finished").length,
      total: states.length,
    },
    unmatched,
  };
}
