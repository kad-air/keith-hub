import { TRACKER_CONFIGS, TRACKERS_ENABLED } from "@/lib/tracker-config";

export type SectionGroup = "Reading" | "Tracking" | "Library" | "Guitar" | "System";

export type Section = {
  key: string;
  num: string;
  name: string;
  flavor?: string;
  href: string;
  group: SectionGroup;
  desc?: string;
  match: (pathname: string) => boolean;
};

const FEED_SECTION: Section = {
  key: "feed",
  num: "01",
  name: "Feed",
  flavor: "— today",
  href: "/",
  group: "Reading",
  desc: "Today's unread",
  match: (p) => p === "/",
};

const SAVED_SECTION: Section = {
  key: "saved",
  num: "",
  name: "Saved",
  href: "/saved",
  group: "Reading",
  desc: "Kept for later",
  match: (p) => p.startsWith("/saved"),
};

const READ_SECTION: Section = {
  key: "read",
  num: "",
  name: "Read",
  href: "/read",
  group: "Reading",
  desc: "Open history",
  match: (p) => p.startsWith("/read"),
};

const BOOKS_SECTION: Section = {
  key: "books",
  num: "",
  name: "Books",
  href: "/books",
  group: "Library",
  desc: "EPUB library · OPDS · reading sync",
  match: (p) => p.startsWith("/books"),
};

// 🔴 Must come BEFORE BOOKS_SECTION in the SECTIONS array: getCurrentSection
// returns the FIRST match, and BOOKS_SECTION matches every /books* path — so
// listed after it, the masthead would read "Books" on the map.
const DISCWORLD_SECTION: Section = {
  key: "discworld",
  num: "",
  name: "Discworld",
  href: "/books/discworld",
  group: "Library",
  desc: "Reading order map · synced progress",
  match: (p) => p.startsWith("/books/discworld"),
};

const COMICS_SECTION: Section = {
  key: "comics",
  num: "",
  name: "Comics",
  href: "/comics",
  group: "Library",
  desc: "Marvel Unlimited",
  match: (p) => p.startsWith("/comics"),
};

// The section home is the Matchup screen (milestone 3, #67) — the core verb.
// `match` covers the whole subtree, so the masthead switcher reads "Hoops" on
// every hoops route.
const HOOPS_SECTION: Section = {
  key: "hoops",
  num: "",
  name: "Hoops",
  href: "/hoops",
  group: "Library",
  desc: "NBA sim · matchup · box score · teams",
  match: (p) => p.startsWith("/hoops"),
};

const PRACTICE_SECTION: Section = {
  key: "practice",
  num: "",
  name: "Practice",
  href: "/practice",
  group: "Guitar",
  desc: "Today · Fretboard · CAGED · Licks",
  match: (p) => p.startsWith("/practice"),
};

const TUNE_SECTION: Section = {
  key: "tune",
  num: "",
  name: "Tune",
  href: "/tune",
  group: "System",
  desc: "Sources · algorithm · config",
  match: (p) => p.startsWith("/tune"),
};

const CHARTS_SECTION: Section = {
  key: "charts",
  num: "",
  name: "Charts",
  href: "/charts",
  group: "Guitar",
  desc: "Chord charts · setlists · autoscroll",
  match: (p) => p.startsWith("/charts"),
};

export const SECTIONS: Section[] = (() => {
  // Empty while the Tracking section is hidden, which drops the group from the
  // Masthead switcher and Contents (Contents filters out empty groups) and
  // renumbers everything below it.
  const trackerSections: Section[] = (
    TRACKERS_ENABLED ? TRACKER_CONFIGS : []
  ).map((t) => ({
    key: t.slug,
    num: "",
    name: t.label,
    href: `/trackers/${t.slug}`,
    group: "Tracking",
    desc: t.statusOptions.slice(0, 3).join(" · "),
    match: (p) =>
      p === `/trackers/${t.slug}` || p.startsWith(`/trackers/${t.slug}/`),
  }));

  const all = [
    FEED_SECTION,
    SAVED_SECTION,
    READ_SECTION,
    ...trackerSections,
    DISCWORLD_SECTION,
    BOOKS_SECTION,
    COMICS_SECTION,
    HOOPS_SECTION,
    PRACTICE_SECTION,
    CHARTS_SECTION,
    TUNE_SECTION,
  ];
  return all.map((s, i) => ({ ...s, num: String(i + 1).padStart(2, "0") }));
})();

export function getCurrentSection(pathname: string): Section {
  return SECTIONS.find((s) => s.match(pathname)) ?? FEED_SECTION;
}
