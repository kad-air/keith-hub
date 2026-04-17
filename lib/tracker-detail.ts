import type {
  CraftItemProperties,
  CraftSchemaProperty,
  TrackerConfig,
} from "./craft-types";

// Picks a friendly label for the external CTA based on the link's domain.
// Covers the handful of platforms our trackers actually link to; anything
// else falls back to the bare domain.
const PLATFORM_LABELS: Array<[RegExp, string]> = [
  [/music\.apple\.com/, "Open in Apple Music"],
  [/open\.spotify\.com|spotify\.com/, "Open in Spotify"],
  [/podcasts\.apple\.com/, "Open in Apple Podcasts"],
  [/apps\.apple\.com/, "Open in App Store"],
  [/tv\.apple\.com/, "Open in Apple TV"],
  [/imdb\.com/, "Open on IMDb"],
  [/themoviedb\.org/, "Open on TMDb"],
  [/letterboxd\.com/, "Open on Letterboxd"],
  [/goodreads\.com/, "Open on Goodreads"],
  [/bookshop\.org/, "Open on Bookshop"],
  [/amazon\.(com|co\.uk)/, "Open on Amazon"],
  [/(?:app\.)?plex\.tv/, "Open in Plex"],
  [/store\.steampowered\.com|steampowered\.com/, "Open on Steam"],
  [/youtube\.com|youtu\.be/, "Open on YouTube"],
];

export function getExternalLinkLabel(url: string): string {
  for (const [pattern, label] of PLATFORM_LABELS) {
    if (pattern.test(url)) return label;
  }
  try {
    return `Open on ${new URL(url).hostname.replace(/^www\./, "")}`;
  } catch {
    return "Open external link";
  }
}

export interface ExtraProp {
  key: string;
  name: string;
  type: CraftSchemaProperty["type"];
  value: string | number | boolean | string[];
}

// Turns the Craft schema + raw properties into the list of extra fields to
// render on the item page, skipping anything that's already surfaced as
// primary UI (title/subtitle/status/rating/ranking/release date). Returns
// empty-value fields filtered out so the page never renders bare labels.
export function buildExtraProps(
  schemaProperties: CraftSchemaProperty[],
  properties: CraftItemProperties,
  config: TrackerConfig,
): ExtraProp[] {
  const skip = new Set<string>([
    config.titleKey,
    config.subtitleKey,
    "status",
    "rating",
    "ranking",
    "release_date",
  ]);
  // Books uses publication_year as its release date — don't duplicate it.
  if (config.slug === "books") skip.add("publication_year");

  const out: ExtraProp[] = [];
  for (const p of schemaProperties) {
    if (skip.has(p.key)) continue;
    const raw = properties[p.key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string" && raw.trim() === "") continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    // Hide `false` booleans — they read as "no, this thing isn't true" and
    // only add noise. True booleans render as a presence badge.
    if (typeof raw === "boolean" && raw === false) continue;
    out.push({
      key: p.key,
      name: p.name,
      type: p.type,
      value: raw,
    });
  }
  return out;
}
