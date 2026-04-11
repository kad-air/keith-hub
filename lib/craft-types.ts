// ─── Tracker collection config ──────────────────────────────────
export type TrackerSlug = "books" | "games" | "tv" | "movies" | "music";

export interface TrackerConfig {
  slug: TrackerSlug;
  collectionId: string;
  label: string;
  titleKey: string; // "title" or "album_name"
  subtitleKey: string; // property key for subtitle line (e.g. "author", "artist")
  statusOptions: string[];
  ratingOptions: string[];
  colorClass: string; // tailwind text color class, e.g. "text-cat-books"
  aspectClass: string; // tailwind aspect ratio class for cover image
}

// ─── Craft API response shapes ──────────────────────────────────
export interface CraftItemProperties {
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface CraftItem {
  id: string;
  title?: string;
  album_name?: string;
  properties: CraftItemProperties;
  contentPreviewMd?: string;
}

export interface CraftCollectionResponse {
  items: CraftItem[];
  schema: CraftSchema;
  collectionName: string;
}

export interface CraftSchemaProperty {
  key: string;
  name: string;
  type:
    | "text"
    | "number"
    | "date"
    | "singleSelect"
    | "multiSelect"
    | "boolean";
  options?: Array<{ name: string; id: string; color: string }>;
}

export interface CraftSchema {
  name: string;
  properties: CraftSchemaProperty[];
  contentPropDetails: { name: string; key: string };
}

// ─── Normalized tracker item (what components consume) ──────────
export interface TrackerItem {
  id: string;
  name: string;
  imageUrl: string | null;
  linkUrl: string | null;
  status: string;
  rating: string;
  ranking: number | undefined;
  subtitle: string;
  properties: CraftItemProperties;
}
