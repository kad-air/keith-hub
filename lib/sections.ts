import { TRACKER_CONFIGS } from "@/lib/tracker-config";

export type SectionGroup = "Reading" | "Tracking" | "Library" | "Guitar";

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

const COMICS_SECTION: Section = {
  key: "comics",
  num: "",
  name: "Comics",
  href: "/comics",
  group: "Library",
  desc: "Marvel Unlimited",
  match: (p) => p.startsWith("/comics"),
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
  const trackerSections: Section[] = TRACKER_CONFIGS.map((t) => ({
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
    COMICS_SECTION,
    PRACTICE_SECTION,
    CHARTS_SECTION,
  ];
  return all.map((s, i) => ({ ...s, num: String(i + 1).padStart(2, "0") }));
})();

export function getCurrentSection(pathname: string): Section {
  return SECTIONS.find((s) => s.match(pathname)) ?? FEED_SECTION;
}
