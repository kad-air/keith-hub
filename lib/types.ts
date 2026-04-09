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

export interface ItemsResponse {
  items: Item[];
  total: number;
  hasMore: boolean;
}
