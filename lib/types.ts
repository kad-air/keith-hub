// Rich Bluesky post data — written by lib/bluesky.ts into the items.metadata
// JSON column, read by components/FeedCard.tsx for rendering. All fields beyond
// the basic counts/identity are optional, so old rows without rich data still
// render as plain text posts.
export interface BlueskyImage {
  thumb: string;
  fullsize: string;
  alt: string;
  aspect_ratio?: { width: number; height: number };
}

export interface BlueskyExternalCard {
  url: string;
  title: string;
  description: string;
  thumb: string | null;
  domain: string;
}

export interface BlueskyQuotedPost {
  handle: string;
  display_name?: string;
  avatar_url: string | null;
  text: string;
  indexed_at: string;
  url: string;
  images?: BlueskyImage[];
  external?: BlueskyExternalCard;
}

export interface BlueskyReplyContext {
  handle: string;
  display_name?: string;
  text: string;
}

export interface BlueskyRepostContext {
  handle: string;
  display_name?: string;
}

export interface BlueskyViewerState {
  // at-URIs of the viewer's own like/repost records, when present. Used both
  // as "has the user already done this?" and as the target for delete calls.
  like_uri?: string;
  repost_uri?: string;
  // at-URI of the viewer's follow record for the post's AUTHOR. Present = the
  // viewer already follows them. We never unfollow from this UI.
  following_uri?: string;
}

export interface BlueskyMetadata {
  handle: string;
  display_name?: string;
  avatar_url: string | null;
  like_count: number;
  reply_count: number;
  repost_count: number;
  // Post identity — needed to write likes/reposts back via the AT Protocol.
  // Optional on read so old rows written before this field existed still parse.
  uri?: string;
  cid?: string;
  // Author DID — needed for follow calls.
  did?: string;
  // Viewer-specific state from the feed response. Rewritten every poll cycle,
  // and mutated in-place by our write endpoints when the user interacts.
  viewer?: BlueskyViewerState;
  // Rich content
  images?: BlueskyImage[];
  external?: BlueskyExternalCard;
  quoted?: BlueskyQuotedPost;
  reply_to?: BlueskyReplyContext;
  reposted_by?: BlueskyRepostContext;
}

export interface Item {
  id: string;
  source_id: string;
  external_id: string | null;
  title: string | null;
  body_excerpt: string | null;
  author: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
  fetched_at: string;
  metadata: string | null;
  // Joined from sources
  source_name?: string;
  source_category?: string;
  // Joined from item_state
  read_at?: string | null;
  saved_at?: string | null;
  consumed_at?: string | null;
  notes?: string | null;
}

export interface CategoryCounts {
  all: number;
  reading: number;
  tech_review: number;
  books: number;
  music: number;
  film: number;
  podcasts: number;
  bluesky: number;
}

export interface ItemsResponse {
  items: Item[];
  total: number;
  hasMore: boolean;
  counts: CategoryCounts;
}
