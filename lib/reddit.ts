import DOMPurify from "isomorphic-dompurify";
import type {
  PostMedia,
  RedditComment,
  RedditPost,
  RedditSort,
  RedditTopWindow,
} from "@/lib/reddit-types";

const UA = "keith-hub/1.0 (personal reader)";
const BASE = "https://www.reddit.com";

const LIST_TTL_MS = 45_000;
const DETAIL_TTL_MS = 20_000;

type CacheEntry = { data: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

async function redditFetch(path: string, ttl: number): Promise<unknown> {
  const key = path;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.data;

  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Reddit ${res.status} for ${path}`);
  }
  const data = (await res.json()) as unknown;
  cache.set(key, { data, expiresAt: now + ttl });
  return data;
}

// Reddit HTML-encodes media URLs inside JSON (e.g. &amp;), which breaks
// <img src>. Same helper covers the handful of entities Reddit emits.
function decodeEntities(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&#x2F;", "/");
}

const ALLOWED_TAGS = [
  "a", "p", "br", "em", "strong", "blockquote",
  "ul", "ol", "li", "code", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "sup", "hr", "del", "span", "div", "table", "thead", "tbody", "tr", "td", "th",
];

// Module-load side effect: DOMPurify hook to force every anchor to open in a
// new tab with a safe rel. Reddit links often point to arbitrary external
// domains, so noopener + noreferrer is mandatory.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function sanitizeRedditHtml(raw: string | null | undefined): string {
  if (!raw) return "";
  const decoded = decodeEntities(raw);
  return DOMPurify.sanitize(decoded, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "class"],
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = any;

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      return u.pathname.slice(1).split("/")[0] || null;
    }
    if (u.hostname.endsWith("youtube.com") || u.hostname.endsWith("youtube-nocookie.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      const embedIdx = parts.indexOf("embed");
      if (embedIdx >= 0 && parts[embedIdx + 1]) return parts[embedIdx + 1];
      const shortsIdx = parts.indexOf("shorts");
      if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];
    }
  } catch {
    // fallthrough
  }
  return null;
}

function pickPreviewImage(
  data: AnyObj,
): { url: string; width: number; height: number } | null {
  const src = data?.preview?.images?.[0]?.source;
  if (!src?.url) return null;
  return {
    url: decodeEntities(src.url as string),
    width: (src.width as number) ?? 0,
    height: (src.height as number) ?? 0,
  };
}

function pickGifVideo(
  data: AnyObj,
): { mp4_url: string; width: number; height: number } | null {
  const mp4 = data?.preview?.images?.[0]?.variants?.mp4?.source;
  if (!mp4?.url) return null;
  return {
    mp4_url: decodeEntities(mp4.url as string),
    width: (mp4.width as number) ?? 0,
    height: (mp4.height as number) ?? 0,
  };
}

function pickGalleryImages(data: AnyObj): PostMedia | null {
  if (!data.is_gallery || !data.gallery_data?.items || !data.media_metadata) {
    return null;
  }
  const items = data.gallery_data.items as AnyObj[];
  const meta = data.media_metadata as Record<string, AnyObj>;
  const images = items
    .map((it) => {
      const m = meta[it.media_id];
      if (!m || m.status !== "valid") return null;
      const s = m.s;
      if (!s?.u && !s?.gif) return null;
      return {
        url: decodeEntities((s.u as string) ?? (s.gif as string)),
        width: (s.x as number) ?? 0,
        height: (s.y as number) ?? 0,
        alt: (it.caption as string) || undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (images.length === 0) return null;
  return { kind: "gallery", images };
}

function pickRedditVideo(data: AnyObj): PostMedia | null {
  const v = data?.secure_media?.reddit_video ?? data?.media?.reddit_video;
  if (!v?.hls_url && !v?.fallback_url) return null;
  return {
    kind: "reddit_video",
    hls_url: decodeEntities((v.hls_url as string) || ""),
    fallback_url: decodeEntities((v.fallback_url as string) || ""),
    width: (v.width as number) ?? 0,
    height: (v.height as number) ?? 0,
    has_audio: v.has_audio !== false,
  };
}

function classifyMedia(data: AnyObj): PostMedia {
  if (data.is_self) return { kind: "none" };

  const gallery = pickGalleryImages(data);
  if (gallery) return gallery;

  if (data.is_video || data?.secure_media?.reddit_video) {
    const rv = pickRedditVideo(data);
    if (rv) return rv;
  }

  const rawUrl = (data.url as string) || "";
  const ytId = extractYouTubeId(rawUrl);
  if (ytId) {
    const preview = pickPreviewImage(data);
    return { kind: "youtube", video_id: ytId, thumb: preview?.url ?? null };
  }

  if (data.post_hint === "image") {
    const preview = pickPreviewImage(data);
    if (preview) {
      return { kind: "image", url: preview.url, width: preview.width, height: preview.height };
    }
  }

  // Animated-GIF-like links (imgur .gifv, tenor, etc.) that Reddit has
  // transcoded to MP4. Treat as a gif-video before falling back to external.
  const gif = pickGifVideo(data);
  if (gif && (data.post_hint === "rich:video" || /\.(gif|gifv)$/i.test(rawUrl))) {
    return { kind: "gif_video", mp4_url: gif.mp4_url, width: gif.width, height: gif.height };
  }

  if (rawUrl && !data.is_self) {
    const preview = pickPreviewImage(data);
    return {
      kind: "external",
      url: rawUrl,
      title: (data.title as string) || null,
      domain: (data.domain as string) || safeDomain(rawUrl),
      thumb: preview?.url ?? null,
    };
  }

  return { kind: "none" };
}

function normalizeThumb(data: AnyObj): string | null {
  const t = data.thumbnail as string | undefined;
  if (!t || t === "self" || t === "default" || t === "nsfw" || t === "spoiler" || t === "") {
    // Fall through to preview.
    const p = pickPreviewImage(data);
    if (p) {
      // Prefer a small resolution if available to avoid pulling full-size
      // images into the list view.
      const resolutions = (data?.preview?.images?.[0]?.resolutions as AnyObj[]) || [];
      const small = resolutions.find((r) => r.width >= 160 && r.width <= 320) ?? resolutions[0];
      if (small?.url) return decodeEntities(small.url as string);
      return p.url;
    }
    return null;
  }
  return t;
}

function normalizePost(raw: AnyObj): RedditPost {
  const data = raw.data as AnyObj;
  return {
    id: data.id as string,
    title: (data.title as string) || "",
    author: (data.author as string) || "[unknown]",
    subreddit: (data.subreddit as string) || "",
    flair: (data.link_flair_text as string) || null,
    score: (data.score as number) ?? 0,
    num_comments: (data.num_comments as number) ?? 0,
    created_utc: (data.created_utc as number) ?? 0,
    permalink: (data.permalink as string) || "",
    url: (data.url as string) || "",
    is_self: !!data.is_self,
    selftext_html: (data.selftext_html as string) || null,
    thumb: normalizeThumb(data),
    media: classifyMedia(data),
    domain: (data.domain as string) || "",
    stickied: !!data.stickied,
    over_18: !!data.over_18,
    distinguished:
      data.distinguished === "moderator" || data.distinguished === "admin"
        ? (data.distinguished as "moderator" | "admin")
        : null,
  };
}

function normalizeCommentTree(raw: AnyObj, depth: number): RedditComment | null {
  if (!raw) return null;
  if (raw.kind === "more") {
    return {
      id: (raw.data?.id as string) || "more",
      author: "",
      score: 0,
      created_utc: 0,
      body_html: "",
      depth,
      replies: [],
      more_count: (raw.data?.count as number) ?? 0,
      stickied: false,
      distinguished: null,
      permalink: null,
    };
  }
  if (raw.kind !== "t1") return null;
  const data = raw.data as AnyObj;

  const repliesListing = data.replies;
  const children =
    repliesListing && typeof repliesListing === "object" && repliesListing.data?.children
      ? (repliesListing.data.children as AnyObj[])
      : [];
  const replies = children
    .map((c) => normalizeCommentTree(c, depth + 1))
    .filter((c): c is RedditComment => c !== null);

  return {
    id: (data.id as string) || "",
    author: (data.author as string) || "[unknown]",
    score: (data.score as number) ?? 0,
    created_utc: (data.created_utc as number) ?? 0,
    body_html: (data.body_html as string) || "",
    depth,
    replies,
    more_count: null,
    stickied: !!data.stickied,
    distinguished:
      data.distinguished === "moderator" || data.distinguished === "admin"
        ? (data.distinguished as "moderator" | "admin")
        : null,
    permalink: (data.permalink as string) || null,
  };
}

export async function fetchSubreddit(
  name: string,
  opts: { sort: RedditSort; t?: RedditTopWindow; limit?: number } = { sort: "hot" },
): Promise<RedditPost[]> {
  const limit = opts.limit ?? 50;
  const qs = new URLSearchParams({ limit: String(limit), raw_json: "1" });
  if (opts.sort === "top" && opts.t) qs.set("t", opts.t);
  const path = `/r/${name}/${opts.sort}.json?${qs.toString()}`;
  const json = (await redditFetch(path, LIST_TTL_MS)) as AnyObj;
  const children = (json?.data?.children as AnyObj[]) || [];
  return children
    .filter((c) => c.kind === "t3")
    .map(normalizePost);
}

export async function fetchPostWithComments(
  id: string,
): Promise<{ post: RedditPost; comments: RedditComment[] }> {
  const qs = new URLSearchParams({ limit: "200", raw_json: "1" });
  const path = `/comments/${id}.json?${qs.toString()}`;
  const json = (await redditFetch(path, DETAIL_TTL_MS)) as AnyObj[];
  if (!Array.isArray(json) || json.length < 2) {
    throw new Error("Unexpected Reddit response shape");
  }
  const postListing = json[0]?.data?.children as AnyObj[] | undefined;
  const commentListing = json[1]?.data?.children as AnyObj[] | undefined;
  if (!postListing?.[0]) throw new Error("Post not found");

  const post = normalizePost(postListing[0]);
  const comments = (commentListing ?? [])
    .map((c) => normalizeCommentTree(c, 0))
    .filter((c): c is RedditComment => c !== null);
  return { post, comments };
}
