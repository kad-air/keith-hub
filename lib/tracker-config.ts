import type { TrackerConfig, TrackerSlug } from "./craft-types";

export const TRACKER_CONFIGS: TrackerConfig[] = [
  {
    slug: "books",
    collectionId: "777A005F-97E3-427F-A590-9FE10590DB1A",
    label: "Books",
    titleKey: "title",
    subtitleKey: "author",
    statusOptions: ["now reading", "read", "to read", "forthcoming"],
    ratingOptions: ["😍", "👍", "😑", "👎"],
    colorClass: "text-cat-books",
    aspectClass: "aspect-[2/3]",
  },
  {
    slug: "games",
    collectionId: "83A88460-B613-417A-96D5-B00A5AEBEC8A",
    label: "Games",
    titleKey: "title",
    subtitleKey: "dev_studio",
    statusOptions: ["playing", "to play", "played"],
    ratingOptions: ["😍", "👍", "😑", "👎"],
    colorClass: "text-cat-games",
    aspectClass: "aspect-[16/9]",
  },
  {
    slug: "tv",
    collectionId: "97B100B6-741F-43B2-B0A9-38475F32A4F7",
    label: "TV",
    titleKey: "title",
    subtitleKey: "platformapp",
    statusOptions: ["watching", "to watch", "watched"],
    ratingOptions: ["😍", "👍", "😑", "👎"],
    colorClass: "text-cat-tv",
    aspectClass: "aspect-[2/3]",
  },
  {
    slug: "movies",
    collectionId: "967F8AFD-5F95-4C98-B204-6E6527AECC69",
    label: "Movies",
    titleKey: "title",
    subtitleKey: "director",
    statusOptions: ["watching", "to watch", "watched", "forthcoming"],
    ratingOptions: ["😍", "👍", "😑", "👎"],
    colorClass: "text-cat-film",
    aspectClass: "aspect-[2/3]",
  },
  {
    slug: "music",
    collectionId: "838D68A7-BE83-4E29-8D12-1F30EEBCB1E2",
    label: "Music",
    titleKey: "album_name",
    subtitleKey: "artist",
    statusOptions: ["to listen", "forthcoming", "now listening", "listened"],
    ratingOptions: ["😍", "👍", "😑", "👎"],
    colorClass: "text-cat-music",
    aspectClass: "aspect-square",
  },
];

export function getTrackerConfig(
  slug: string,
): TrackerConfig | undefined {
  return TRACKER_CONFIGS.find(
    (c) => c.slug === (slug as TrackerSlug),
  );
}
