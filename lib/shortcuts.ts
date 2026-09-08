import { SECTIONS, type Section } from "@/lib/sections";

/**
 * The user-facing keyboard map, in one place.
 *
 * Three layers, and the help overlay (`components/KeyboardHelp.tsx`) renders
 * all three for whatever section you are standing in:
 *
 *  1. GLOBAL — bound once in `components/GlobalKeys.tsx` (mounted by the
 *     Masthead, so it is live on every route): `g <letter>` jumps to a
 *     section, `[` / `]` step through the sections in order, `?` toggles the
 *     help, `⌘K` / `g g` open Contents, `/` focuses the page's search box,
 *     and `j` / `k` / `o` rove over any list whose rows carry `data-kb-item`.
 *  2. SECTION — what a section binds itself (Feed's triage keys, the chart
 *     viewer's transport, the map's zoom). Listed here so the overlay can
 *     show them; the bindings live in the section's own client.
 *  3. TABS — number keys that switch a section's in-page tabs. Bound by
 *     `components/SectionTabKeys.tsx` where the section renders its tab row.
 *
 * `data-kb-item` on a row is the contract for layer 1: an `<a>` or
 * `<button>` carrying it is focusable, `j`/`k` walk the visible ones in
 * document order, and Enter (native) or `o` activates the focused one.
 * `data-kb-search` on an input is what `/` focuses.
 */

export type ShortcutRow = { keys: string[]; label: string };
export type ShortcutGroup = { section: string; rows: ShortcutRow[] };

export const GLOBAL_SHORTCUTS: ShortcutGroup[] = [
  {
    section: "Everywhere",
    rows: [
      { keys: ["j"], label: "Next item" },
      { keys: ["k"], label: "Previous item" },
      { keys: ["o"], label: "Open the focused item" },
      { keys: ["enter"], label: "Open the focused item" },
      { keys: ["/"], label: "Search on this page" },
      { keys: ["]"], label: "Next section" },
      { keys: ["["], label: "Previous section" },
      { keys: ["⌘ k"], label: "Contents (jump anywhere)" },
      { keys: ["g", "g"], label: "Contents (jump anywhere)" },
      { keys: ["?"], label: "Toggle this help" },
      { keys: ["esc"], label: "Close overlays" },
    ],
  },
];

/** Rows for the "Go to" group, derived from the sections so the two can't drift. */
export function sectionJumpRows(): ShortcutRow[] {
  return SECTIONS.filter((s) => s.hotkey).map((s) => ({
    keys: ["g", s.hotkey],
    label: `Go to ${s.name}`,
  }));
}

const TRIAGE: ShortcutRow[] = [
  { keys: ["o"], label: "Open in new tab" },
  { keys: ["enter"], label: "Open in new tab" },
  { keys: ["s"], label: "Save / unsave" },
  { keys: ["x"], label: "Dismiss" },
  { keys: ["e"], label: "Dismiss" },
];

/**
 * Per-section rows, keyed by `Section.key`. Sub-pages inherit their
 * section's rows; a page can add its own under a path-specific key
 * (`getSectionShortcuts` checks the exact path prefix first).
 */
export const SECTION_SHORTCUTS: Record<string, ShortcutGroup[]> = {
  feed: [
    {
      section: "Feed",
      rows: [
        ...TRIAGE,
        { keys: ["c"], label: "Clear this item and all above" },
        { keys: ["r"], label: "Refresh feeds" },
      ],
    },
  ],
  saved: [{ section: "Saved", rows: TRIAGE }],
  read: [
    {
      section: "Read",
      rows: [
        { keys: ["o"], label: "Open in new tab" },
        { keys: ["enter"], label: "Open in new tab" },
        { keys: ["s"], label: "Save / unsave" },
      ],
    },
  ],
  books: [
    {
      section: "Books",
      rows: [
        { keys: ["1"], label: "Library" },
        { keys: ["2"], label: "Stats" },
        { keys: ["3"], label: "Discworld map" },
      ],
    },
  ],
  discworld: [
    {
      section: "Discworld",
      rows: [
        { keys: ["+"], label: "Zoom in" },
        { keys: ["-"], label: "Zoom out" },
        { keys: ["0"], label: "Fit the map" },
        { keys: ["esc"], label: "Close the coin sheet" },
      ],
    },
  ],
  comics: [
    {
      section: "Comics",
      rows: [
        { keys: ["x"], label: "Toggle the focused issue read" },
      ],
    },
  ],
  hoops: [
    {
      section: "Hoops",
      rows: [
        { keys: ["1"], label: "Matchup" },
        { keys: ["2"], label: "Teams" },
        { keys: ["3"], label: "Players" },
        { keys: ["s"], label: "Sim (matchup)" },
        { keys: ["x"], label: "Swap home and away (matchup)" },
        { keys: ["r"], label: "Surprise me (matchup)" },
      ],
    },
  ],
  practice: [
    {
      section: "Practice",
      rows: [
        { keys: ["1"], label: "Today" },
        { keys: ["2"], label: "Fretboard" },
        { keys: ["3"], label: "CAGED" },
        { keys: ["4"], label: "Licks" },
      ],
    },
  ],
  charts: [
    {
      section: "Charts",
      rows: [
        { keys: ["1"], label: "Library" },
        { keys: ["2"], label: "Setlists" },
        { keys: ["space"], label: "Play / pause autoscroll (viewer)" },
        { keys: ["↑"], label: "Faster (viewer)" },
        { keys: ["↓"], label: "Slower (viewer)" },
        { keys: ["n"], label: "Next song in the setlist (viewer)" },
      ],
    },
  ],
  tune: [
    {
      section: "Tune",
      rows: [
        { keys: ["1"], label: "Sources" },
        { keys: ["2"], label: "Algorithm" },
        { keys: ["3"], label: "YAML" },
      ],
    },
  ],
};

export function getSectionShortcuts(section: Section): ShortcutGroup[] {
  return SECTION_SHORTCUTS[section.key] ?? [];
}

/**
 * What the chord hint shows once a prefix is down: for `g`, every section
 * letter plus `g g` (Contents), in that order. Unknown prefixes get the raw
 * keys with no labels.
 */
export function chordOptions(prefix: string, keys: string[]): ShortcutRow[] {
  if (prefix === "g") {
    const bySection = new Map(
      SECTIONS.filter((s) => s.hotkey).map((s) => [s.hotkey, s.name] as const),
    );
    // Sections in Contents order first, `g g` (Contents) last.
    const ordered = [...keys].sort((a, b) => {
      const ia = a === "g" ? Infinity : SECTIONS.findIndex((s) => s.hotkey === a);
      const ib = b === "g" ? Infinity : SECTIONS.findIndex((s) => s.hotkey === b);
      return ia - ib;
    });
    return ordered.map((k) => ({
      keys: [k],
      label: k === "g" ? "Contents" : bySection.get(k) ?? k,
    }));
  }
  return keys.map((k) => ({ keys: [k], label: k }));
}

/** The sections `[` / `]` step through, in Contents order. */
export function adjacentSection(current: Section, dir: 1 | -1): Section {
  const list = SECTIONS.filter((s) => s.hotkey);
  const i = list.findIndex((s) => s.key === current.key);
  const n = list.length;
  return list[((i < 0 ? 0 : i) + dir + n) % n];
}

// A duplicate letter would silently make one section unreachable by chord.
// `g g` is Contents, so no section may use it either.
{
  const seen = new Set<string>(["g"]);
  for (const s of SECTIONS) {
    if (!s.hotkey) continue;
    if (s.hotkey.length !== 1 || seen.has(s.hotkey)) {
      throw new Error(`Duplicate or invalid section hotkey "${s.hotkey}" on ${s.key}`);
    }
    seen.add(s.hotkey);
  }
}
