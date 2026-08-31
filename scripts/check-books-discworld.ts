#!/usr/bin/env node
//
// 🔴 THE DISCWORLD READING-MAP GATE.
//
//   npm run check:books:discworld   (standalone)
//   npm run build                   (via prebuild)
//
// This feature's failure mode is that it is QUIETLY WRONG and looks fine. A
// node that fails to match its library row renders as a faded coin, which is
// indistinguishable from "you haven't read that one" — the reader's own
// progress silently disappears and the map still looks like a map. A manual
// mark overwritten by a sync looks like nothing at all. There is no error
// surface anywhere in it.
//
// Everything below is anchored on something true INDEPENDENTLY of this code:
//
//   · Discworld publication order and the publication years — external facts
//     about the world, written down here a SECOND time and compared, so a
//     transposition in lib/books/discworld.ts has to break this file too.
//   · Terry Pratchett died in 2015, so no novel can postdate The Shepherd's
//     Crown. The canon is closed and the check knows it.
//   · books-fixture/discworld-opf.json — metadata read out of the reader's
//     REAL epub files by Python (scripts/gen_discworld_opf_reference.py),
//     never by this codebase. Men at Arms's own dc:title is mangled, so the
//     title path cannot rescue it; only series_index can.
//   · geometry: two coins drawn closer than their own diameter overlap, and a
//     node hidden underneath another one is a node nobody can ever tick.
//
// It also asserts the LANDMINES stay fixed: the manual mark must beat the
// sync in BOTH directions, an absent book can never read as finished, and the
// finish threshold must not be re-declared here (a second copy of 0.97 can
// drift away from the one the streak and the heatmap use).
//
// Hermetic: temp cwd before the first getDb().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Types only — erased before the module ever runs, so this does not break the
// "chdir to a temp cwd before the first getDb()" rule the value imports follow.
import type { DiscworldLibraryBook, ManualStatus } from "../lib/books/discworld.ts";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const sourceOf = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), "utf8");
/** Source with comments removed. The structural assertions below are about
 *  CODE — a prose mention of 0.97 in a comment explaining why 0.97 must not be
 *  written here is not a violation, and a comment must never be able to
 *  satisfy an assertion either. */
const codeOf = (rel: string) =>
  sourceOf(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const opfFixture = JSON.parse(sourceOf("books-fixture/discworld-opf.json")) as {
  books: Array<{
    sourceFile: string;
    opfTitle: string | null;
    opfSeries: string | null;
    opfSeriesIndex: number | null;
  }>;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "discworld-check-"));
process.chdir(tmp);

const {
  DISCWORLD_NODES,
  DISCWORLD_EDGES,
  DISCWORLD_SEQUENCES,
  LAYOUT,
  autoStatus,
  computeDiscworldProgress,
  matchLibrary,
  normalizeTitle,
  resolveStatus,
} = await import("../lib/books/discworld.ts");
const { FINISH_THRESHOLD } = await import("../lib/books/stats.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("check:books:discworld — the Discworld reading-map gate\n");

// ── 1. The canon ─────────────────────────────────────────────────────────────
// An independent write-down of Discworld publication order and first
// publication years. If this list and lib/books/discworld.ts ever disagree,
// one of them is a typo and the build says so instead of the map quietly
// pointing "#15" at the wrong book.

const CANON: Array<[order: number, title: string, year: number]> = [
  [1, "The Colour of Magic", 1983],
  [2, "The Light Fantastic", 1986],
  [3, "Equal Rites", 1987],
  [4, "Mort", 1987],
  [5, "Sourcery", 1988],
  [6, "Wyrd Sisters", 1988],
  [7, "Pyramids", 1989],
  [8, "Guards! Guards!", 1989],
  [9, "Faust Eric", 1990],
  [10, "Moving Pictures", 1990],
  [11, "Reaper Man", 1991],
  [12, "Witches Abroad", 1991],
  [13, "Small Gods", 1992],
  [14, "Lords and Ladies", 1992],
  [15, "Men at Arms", 1993],
  [16, "Soul Music", 1994],
  [17, "Interesting Times", 1994],
  [18, "Maskerade", 1995],
  [19, "Feet of Clay", 1996],
  [20, "Hogfather", 1996],
  [21, "Jingo", 1997],
  [22, "The Last Continent", 1998],
  [23, "Carpe Jugulum", 1998],
  [24, "The Fifth Elephant", 1999],
  [25, "The Truth", 2000],
  [26, "Thief of Time", 2001],
  [27, "The Last Hero", 2001],
  [28, "The Amazing Maurice and his Educated Rodents", 2001],
  [29, "Night Watch", 2002],
  [30, "The Wee Free Men", 2003],
  [31, "Monstrous Regiment", 2003],
  [32, "A Hat Full of Sky", 2004],
  [33, "Going Postal", 2004],
  [34, "Thud!", 2005],
  [35, "Wintersmith", 2006],
  [36, "Making Money", 2007],
  [37, "Unseen Academicals", 2009],
  [38, "I Shall Wear Midnight", 2010],
  [39, "Snuff", 2011],
  [40, "Raising Steam", 2013],
  [41, "The Shepherd's Crown", 2015],
];

console.log("The canon — publication order and years");

const novels = DISCWORLD_NODES.filter((n) => n.pubOrder != null).sort(
  (a, b) => a.pubOrder! - b.pubOrder!,
);
assert(novels.length === 41, `exactly 41 novels carry a publication number (got ${novels.length})`);
assert(
  novels.every((n, i) => n.pubOrder === i + 1),
  "publication numbers are 1–41 with no gaps and no duplicates",
);

const canonMismatch = CANON.filter(([order, title, year]) => {
  const node = novels.find((n) => n.pubOrder === order);
  return !node || normalizeTitle(node.title) !== normalizeTitle(title) || node.year !== year;
});
assert(
  canonMismatch.length === 0,
  `every novel matches the independent canon list${
    canonMismatch.length ? ` — off: ${canonMismatch.map(([o, t]) => `#${o} ${t}`).join(", ")}` : ""
  }`,
);

// Mathematics over the external fact: a later book cannot have come out first.
const nonMonotone = novels.filter((n, i) => i > 0 && n.year < novels[i - 1].year);
assert(
  nonMonotone.length === 0,
  `publication years never go backwards along the order${
    nonMonotone.length ? ` — off: ${nonMonotone.map((n) => n.title).join(", ")}` : ""
  }`,
);

// 🔴 The canon is CLOSED. Pratchett died in 2015 and The Shepherd's Crown was
// the last novel; a 42nd entry, or a year past 2015, means someone has added
// something that is not a Discworld novel.
assert(
  DISCWORLD_NODES.every((n) => n.year <= 2015),
  "🔴 nothing on the guide postdates 2015 — the canon closed with Pratchett",
);
assert(
  novels[40].title === "The Shepherd's Crown" && novels[40].year === 2015,
  "🔴 #41 is The Shepherd's Crown (1948–2015)",
);

// ── 2. The graph ─────────────────────────────────────────────────────────────

console.log("\nThe graph");

const ids = DISCWORLD_NODES.map((n) => n.id);
assert(new Set(ids).size === ids.length, "no duplicate node ids");

const known = new Set(ids);
const danglingEdges = DISCWORLD_EDGES.filter((e) => !known.has(e.from) || !known.has(e.to));
assert(
  danglingEdges.length === 0,
  `every connection joins two real nodes${
    danglingEdges.length ? ` — dangling: ${danglingEdges.map((e) => `${e.from}→${e.to}`).join(", ")}` : ""
  }`,
);

const connected = new Set(DISCWORLD_EDGES.flatMap((e) => [e.from, e.to]));
const orphans = DISCWORLD_NODES.filter((n) => !connected.has(n.id));
assert(
  orphans.length === 0,
  `no node floats unconnected${orphans.length ? ` — orphans: ${orphans.map((n) => n.id).join(", ")}` : ""}`,
);

// 🔴 Geometry, not taste. Two centres closer than a coin's own diameter
// overlap — and a node drawn under another one is unreachable: it can never be
// tapped, so it can never be ticked, and the map is silently missing a book.
const MIN_SEPARATION = (2 * LAYOUT.r) / LAYOUT.cellX;
let closest = { pair: "", d: Infinity };
for (let i = 0; i < DISCWORLD_NODES.length; i++) {
  for (let j = i + 1; j < DISCWORLD_NODES.length; j++) {
    const a = DISCWORLD_NODES[i];
    const b = DISCWORLD_NODES[j];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < closest.d) closest = { pair: `${a.id} / ${b.id}`, d };
  }
}
assert(
  closest.d >= MIN_SEPARATION,
  `no two coins overlap — closest is ${closest.pair} at ${closest.d.toFixed(3)} (need ${MIN_SEPARATION.toFixed(3)})`,
);
assert(DISCWORLD_SEQUENCES.length > 0, "the poster's sequence labels are present");

// 🔴 A sequence label written across the row it names is the exact bug this
// feature shipped with in its first draft — "RINCEWIND NOVELS" straight
// through The Colour of Magic. It is invisible to every assertion above and to
// TypeScript, and only a screenshot ever showed it. So: bound each label's
// footprint (generously, in the strict direction) and require it to clear
// every coin, and to stay inside the canvas.
const labelBoxes = DISCWORLD_SEQUENCES.map((seq) => {
  const widest = Math.max(...seq.lines.map((l) => l.length));
  const w = (widest * LAYOUT.labelCharWidth) / LAYOUT.cellX;
  const h = (seq.lines.length * LAYOUT.labelLineHeight) / LAYOUT.cellY;
  return {
    key: seq.key,
    x0: seq.anchor === "end" ? seq.x - w : seq.x,
    x1: seq.anchor === "end" ? seq.x : seq.x + w,
    y0: seq.y - h / 2,
    y1: seq.y + h / 2,
  };
});

const coinR = LAYOUT.r / LAYOUT.cellX;
const labelHits = labelBoxes.flatMap((b) =>
  DISCWORLD_NODES.filter(
    (n) =>
      n.x + coinR > b.x0 && n.x - coinR < b.x1 && n.y + coinR > b.y0 && n.y - coinR < b.y1,
  ).map((n) => `${b.key} over ${n.id}`),
);
assert(
  labelHits.length === 0,
  `🔴 no sequence label is written over a coin${labelHits.length ? ` — ${labelHits.join(", ")}` : ""}`,
);

const { view } = LAYOUT;
const outside = [
  ...DISCWORLD_NODES.filter(
    (n) =>
      n.x * LAYOUT.cellX - LAYOUT.r < view.x ||
      n.x * LAYOUT.cellX + LAYOUT.r > view.x + view.w ||
      n.y * LAYOUT.cellY - LAYOUT.r < view.y ||
      n.y * LAYOUT.cellY + LAYOUT.r > view.y + view.h,
  ).map((n) => n.id),
  ...labelBoxes
    .filter(
      (b) =>
        b.x0 * LAYOUT.cellX < view.x ||
        b.x1 * LAYOUT.cellX > view.x + view.w ||
        b.y0 * LAYOUT.cellY < view.y ||
        b.y1 * LAYOUT.cellY > view.y + view.h,
    )
    .map((b) => b.key),
];
assert(
  outside.length === 0,
  `🔴 everything is inside the canvas at Fit${outside.length ? ` — off-canvas: ${outside.join(", ")}` : ""}`,
);

// ── 3. The library match, against the epubs' own metadata ────────────────────

console.log("\nThe library match — anchored on the real files' OPF metadata");

assert(opfFixture.books.length > 0, "the OPF fixture is not empty");

const fromOpf: DiscworldLibraryBook[] = opfFixture.books.map((b, i) => ({
  id: `opf-${i}`,
  title: b.opfTitle ?? "",
  series: b.opfSeries,
  seriesIndex: b.opfSeriesIndex,
  partialMd5: `hash-opf-${i}`,
}));
const opfMatch = matchLibrary(fromOpf);
assert(
  opfMatch.unmatched.length === 0,
  `every real epub resolves to a node${
    opfMatch.unmatched.length ? ` — missed: ${opfMatch.unmatched.map((b) => b.title).join(", ")}` : ""
  }`,
);
for (const b of opfFixture.books) {
  const expectedNode = DISCWORLD_NODES.find((n) => n.pubOrder === b.opfSeriesIndex);
  const got = [...opfMatch.byNode.entries()].find(
    ([, book]) => book.title === (b.opfTitle ?? ""),
  )?.[0];
  assert(
    expectedNode != null && got === expectedNode.id,
    `${b.sourceFile} → ${expectedNode?.title ?? "?"}`,
  );
}

// 🔴 The case the fixture exists for. Men at Arms's dc:title carries the
// author and the series glued to the front, so the title path CANNOT find it
// — the series index is the only thing that can, which is why it is tried
// first. Falsified by reordering the two keys in matchLibrary.
const mangled = opfFixture.books.find((b) => (b.opfTitle ?? "").includes(" - "));
if (mangled) {
  const titleOnly = matchLibrary([
    { id: "x", title: mangled.opfTitle!, series: null, seriesIndex: null, partialMd5: "h" },
  ]);
  assert(
    titleOnly.byNode.size === 0,
    `🔴 "${mangled.opfTitle}" is unmatchable by title alone — series_index is load-bearing`,
  );
  const withIndex = matchLibrary([
    {
      id: "x",
      title: mangled.opfTitle!,
      series: mangled.opfSeries,
      seriesIndex: mangled.opfSeriesIndex,
      partialMd5: "h",
    },
  ]);
  assert(withIndex.byNode.size === 1, "🔴 …and the same row DOES match once its index is there");
} else {
  assert(false, "the fixture no longer contains the mangled-title case it exists for");
}

// 🔴 The tie-break, which is what the key ORDER decides. Nothing above can
// see it: the mangled title matches no node, so it falls through to the index
// whichever key is tried first. Only a row whose two keys point at DIFFERENT
// nodes pins the choice — and the index has to win, because it is the field
// the publisher set and the title is the field this library was caught
// mangling. Falsified by swapping the two lookups in matchLibrary.
const disagreeing = matchLibrary([
  { id: "t", title: "Mort", series: "Discworld", seriesIndex: 15, partialMd5: "h" },
]);
assert(
  disagreeing.byNode.get("men-at-arms")?.id === "t" && !disagreeing.byNode.has("mort"),
  "🔴 when a Discworld row's title and series index disagree, the INDEX wins",
);
const noSeries = matchLibrary([
  { id: "u", title: "Mort", series: null, seriesIndex: 15, partialMd5: "h" },
]);
assert(
  noSeries.byNode.get("mort")?.id === "u",
  "…but a row with no series data is placed by its title, with nothing to disagree with",
);

// The fallback path, and the reporting of a row nothing can place.
const fallbacks = matchLibrary([
  { id: "a", title: "Eric", series: null, seriesIndex: null, partialMd5: "h1" },
  { id: "b", title: "The Color of Magic", series: null, seriesIndex: null, partialMd5: "h2" },
  { id: "c", title: "Nanny Ogg's Cookbook", series: null, seriesIndex: null, partialMd5: "h3" },
  { id: "d", title: "A Blip", series: "Discworld", seriesIndex: 99, partialMd5: "h4" },
  { id: "e", title: "The Two Towers", series: "The Lord of the Rings", seriesIndex: 2, partialMd5: "h5" },
]);
assert(fallbacks.byNode.get("eric")?.id === "a", "a seriesless 'Eric' falls back to the title alias");
assert(
  fallbacks.byNode.get("colour-of-magic")?.id === "b",
  "the US spelling 'The Color of Magic' matches",
);
assert(
  fallbacks.byNode.get("nanny-oggs-cookbook")?.id === "c",
  "an apostrophe survives normalization (Nanny Ogg's Cookbook)",
);
assert(
  fallbacks.unmatched.length === 1 && fallbacks.unmatched[0].id === "d",
  "🔴 a Discworld book the map can't place is REPORTED, not silently dropped",
);
assert(
  !fallbacks.unmatched.some((b) => b.id === "e"),
  "a non-Discworld book is not reported as missing from the map",
);

// ── 4. The status rules ──────────────────────────────────────────────────────

console.log("\nThe status rules");

const book: DiscworldLibraryBook = {
  id: "b1",
  title: "Mort",
  series: "Discworld",
  seriesIndex: 4,
  partialMd5: "hash-mort",
};

assert(
  autoStatus(undefined, { percentage: 1, timestamp: 1 }, true, FINISH_THRESHOLD) === "absent",
  "🔴 a book that isn't in the library can never read as finished",
);
assert(autoStatus(book, undefined, false, FINISH_THRESHOLD) === "owned", "in the library, never synced → owned");
assert(
  autoStatus(book, { percentage: 0, timestamp: 1 }, false, FINISH_THRESHOLD) === "owned",
  "🔴 synced at 0% is still 'owned' — opening a book once is not reading it",
);
assert(
  autoStatus(book, { percentage: 0.4, timestamp: 1 }, false, FINISH_THRESHOLD) === "reading",
  "part-way through → reading",
);
assert(
  autoStatus(book, { percentage: FINISH_THRESHOLD, timestamp: 1 }, false, FINISH_THRESHOLD) === "finished",
  `at the finish threshold (${FINISH_THRESHOLD}) → finished`,
);
assert(
  autoStatus(book, { percentage: FINISH_THRESHOLD - 0.001, timestamp: 1 }, false, FINISH_THRESHOLD) === "reading",
  "a hair below it → still reading",
);
assert(
  autoStatus(book, { percentage: 0.03, timestamp: 1 }, true, FINISH_THRESHOLD) === "finished",
  "🔴 a finished book re-opened at 3% stays finished — the events log remembers the crossing",
);

// 🔴 Manual wins in BOTH directions. Asserting only that a mark can ADD a read
// book would pass happily on an implementation where the sync silently
// overwrites a mark that is less advanced than it.
assert(resolveStatus("owned", "read") === "finished", "a hand mark can read a book the sync never saw");
assert(
  resolveStatus("finished", "reading") === "reading",
  "🔴 …and can also walk one BACK — the reader outranks the sync in both directions",
);
assert(resolveStatus("reading", "skipped") === "skipped", "a book can be skipped mid-read");
assert(resolveStatus("finished", undefined) === "finished", "no mark → the sync answers");
assert(
  resolveStatus("owned", undefined) === "owned",
  "🔴 clearing a mark hands the node back to the sync, it does not pin the old verdict",
);

// ── 5. End to end, through the real model ────────────────────────────────────

console.log("\nEnd to end");

const library: DiscworldLibraryBook[] = [
  book,
  { id: "b2", title: "Men at Arms", series: "Discworld", seriesIndex: 15, partialMd5: "hash-maa" },
  { id: "b3", title: "Guards! Guards!", series: "Discworld", seriesIndex: 8, partialMd5: "hash-gg" },
];
const manual = new Map<string, ManualStatus>([
  ["colour-of-magic", "read"],
  ["light-fantastic", "skipped"],
]);
const progress = computeDiscworldProgress({
  books: library,
  syncByDocument: new Map([
    ["hash-mort", { percentage: 0.99, timestamp: 10 }],
    ["hash-maa", { percentage: 0.42, timestamp: 20 }],
  ]),
  finishedDocuments: new Set(["hash-mort"]),
  manual,
  finishThreshold: FINISH_THRESHOLD,
});

const state = (id: string) => progress.states.find((s) => s.node.id === id)!;
assert(progress.states.length === DISCWORLD_NODES.length, "every node gets a state");
assert(state("mort").status === "finished" && state("mort").bookId === "b1", "Mort reads finished, and links to its book");
assert(state("men-at-arms").status === "reading", "Men at Arms reads in progress");
assert(state("men-at-arms").percentage === 0.42, "…carrying its percentage for the ring");
assert(state("guards-guards").status === "owned", "Guards! Guards! is owned but unread");
assert(state("snuff").status === "absent", "a book not in the library is absent");
assert(state("colour-of-magic").status === "finished", "the hand-marked one counts as read");
assert(state("colour-of-magic").manual === "read", "…and says it was hand-marked");
assert(state("light-fantastic").status === "skipped", "the skipped one is skipped");

// The headline number counts NOVELS, not everything on the poster: the
// science books and the cookbook are not part of "41 novels".
assert(progress.novels.total === 41, "the headline denominator is the 41 novels");
assert(progress.novels.read === 2, `2 novels read (Mort + The Colour of Magic), got ${progress.novels.read}`);
assert(progress.novels.reading === 1, "1 novel in progress");
assert(
  progress.all.total === DISCWORLD_NODES.length && progress.all.total > 41,
  "the secondary count includes the short stories and companions",
);
assert(
  !progress.states.some((s) => s.status === "finished" && s.bookId === null && s.manual == null),
  "🔴 nothing reads as finished without either a library book or a hand mark behind it",
);

// ── 6. The threshold, and purity ─────────────────────────────────────────────

console.log("\nStructure");

const dwSource = codeOf("lib/books/discworld.ts");
assert(
  !/\b0\.9[0-9]\b/.test(dwSource),
  "🔴 lib/books/discworld.ts declares no finish threshold of its own — it takes stats.ts's",
);
assert(
  !/^\s*import\s/m.test(dwSource),
  "🔴 lib/books/discworld.ts imports nothing — it stays pure, so this gate drives the REAL module and the client bundle stays small",
);
assert(
  /FINISH_THRESHOLD/.test(codeOf("lib/books/discworldData.ts")),
  "the impure edge passes stats.ts's FINISH_THRESHOLD through",
);
// 🔴 The sync path must never write the reader's marks table. reading_events
// already records what the devices say; if putProgress also stamped rows in
// discworld_state, a re-read dipping below the threshold would erase a mark
// made by hand.
assert(
  !/discworld/i.test(codeOf("lib/books/kosync.ts")),
  "🔴 the kosync write path knows nothing about discworld_state",
);
assert(
  !/discworld/i.test(codeOf("lib/books/readingEvents.ts")),
  "🔴 …and neither does the reading-events recorder",
);
// The map is a league table of the reader's own library; a filter or a sort
// must never be what decides whether a book counts.
assert(
  /ON DELETE|DELETE FROM discworld_state/.test(codeOf("lib/books/discworldData.ts")),
  "clearing a mark is a DELETE, so no stale verdict can survive it",
);

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncheck:books:discworld FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:discworld OK");
