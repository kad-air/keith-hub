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
  desc: "Today · Saved · Read",
  match: (p) => p === "/" || p.startsWith("/saved") || p.startsWith("/read"),
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
  name: "Guitar",
  href: "/practice",
  group: "Guitar",
  desc: "Today · Fretboard · Licks",
  match: (p) => p.startsWith("/practice"),
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
    ...trackerSections,
    COMICS_SECTION,
    PRACTICE_SECTION,
  ];
  return all.map((s, i) => ({ ...s, num: String(i + 1).padStart(2, "0") }));
})();

export function getCurrentSection(pathname: string): Section {
  return SECTIONS.find((s) => s.match(pathname)) ?? FEED_SECTION;
}
