export type RedditSort = "hot" | "new" | "top";
export type RedditTopWindow = "hour" | "day" | "week" | "month" | "year" | "all";

export type PostMedia =
  | { kind: "none" }
  | {
      kind: "image";
      url: string;
      width: number;
      height: number;
      alt?: string;
    }
  | {
      kind: "gallery";
      images: {
        url: string;
        width: number;
        height: number;
        alt?: string;
      }[];
    }
  | {
      kind: "reddit_video";
      hls_url: string;
      fallback_url: string;
      width: number;
      height: number;
      has_audio: boolean;
    }
  | {
      kind: "gif_video";
      mp4_url: string;
      width: number;
      height: number;
    }
  | {
      kind: "youtube";
      video_id: string;
      thumb: string | null;
    }
  | {
      kind: "external";
      url: string;
      title: string | null;
      domain: string;
      thumb: string | null;
    };

export type RedditPost = {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  flair: string | null;
  score: number;
  num_comments: number;
  created_utc: number;
  permalink: string;
  url: string;
  is_self: boolean;
  selftext_html: string | null;
  thumb: string | null;
  media: PostMedia;
  domain: string;
  stickied: boolean;
  over_18: boolean;
  distinguished: "moderator" | "admin" | null;
};

export type RedditComment = {
  id: string;
  author: string;
  score: number;
  created_utc: number;
  body_html: string;
  depth: number;
  replies: RedditComment[];
  more_count: number | null;
  stickied: boolean;
  distinguished: "moderator" | "admin" | null;
  permalink: string | null;
};
