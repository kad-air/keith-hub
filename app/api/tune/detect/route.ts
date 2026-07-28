import { NextRequest, NextResponse } from "next/server";
import Parser from "rss-parser";
import type { SourceConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 10_000;
const parser = new Parser();

export interface DetectResult {
  kind: "rss" | "podcast" | "bluesky_account" | "bluesky_feed";
  title: string;
  itemTitles: string[];
  suggested: Partial<SourceConfig>;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function fetchText(url: string): Promise<{ text: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TheFeed/0.1 (personal RSS reader)" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return { text: await res.text(), contentType: res.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeXml(text: string, contentType: string): boolean {
  if (/xml|rss|atom/i.test(contentType)) return true;
  const head = text.slice(0, 300).trimStart();
  return head.startsWith("<?xml") || head.startsWith("<rss") || head.startsWith("<feed");
}

// Find <link rel="alternate" type="application/rss+xml|atom+xml" href="…">
// in an HTML document. Attribute order varies, so match the link tag first
// and then pick attributes out of it.
function findFeedLink(html: string, baseUrl: string): string | null {
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    if (!/rel=["']?alternate["']?/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml["']?/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
  }
  return null;
}

async function detectFromFeedXml(xml: string, feedUrl: string): Promise<DetectResult> {
  const feed = await parser.parseString(xml);
  const items = feed.items ?? [];
  // Podcast heuristic: audio enclosures or feed-level itunes metadata.
  const hasAudio = items.some((it) => it.enclosure?.type?.startsWith("audio"));
  const feedItunes = (feed as Record<string, unknown>).itunes as
    | Record<string, unknown>
    | undefined;
  const isPodcast = hasAudio || Boolean(feedItunes?.owner || feedItunes?.author);
  const title = feed.title?.trim() || feedUrl;

  return {
    kind: isPodcast ? "podcast" : "rss",
    title,
    itemTitles: items.slice(0, 3).map((it) => it.title?.trim() ?? "(untitled)"),
    suggested: {
      id: slugify(title) || "new-source",
      name: title,
      type: isPodcast ? "podcast" : "rss",
      url: feedUrl,
    },
  };
}

// Bluesky account preview via the public (unauthenticated) AppView API —
// best-effort; a failure still returns the suggestion, just without titles.
async function blueskyAccountPreview(handle: string): Promise<string[]> {
  try {
    const { text } = await fetchText(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=3&filter=posts_no_replies`
    );
    const data = JSON.parse(text) as {
      feed?: Array<{ post?: { record?: { text?: string } } }>;
    };
    return (data.feed ?? [])
      .map((f) => f.post?.record?.text?.slice(0, 120) ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as { input?: string };
    const input = (body.input ?? "").trim();
    if (!input) {
      return NextResponse.json({ error: "Paste a feed URL, site URL, Bluesky handle, or Apple Podcasts link" }, { status: 400 });
    }

    // Bluesky algorithmic feed URI
    if (input.startsWith("at://")) {
      const result: DetectResult = {
        kind: "bluesky_feed",
        title: "Bluesky feed",
        itemTitles: [],
        suggested: {
          id: slugify(input.split("/").pop() ?? "bluesky-feed") || "bluesky-feed",
          name: "Bluesky feed",
          type: "bluesky",
          mode: "feed",
          feed_uri: input,
          category: "bluesky",
        },
      };
      return NextResponse.json(result);
    }

    // Bluesky handle: "@handle.tld" or a bare domain-ish string with no path
    const handleMatch = input.match(/^@?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})$/i);
    if (handleMatch && !/^https?:\/\//i.test(input)) {
      const handle = handleMatch[1].toLowerCase();
      const result: DetectResult = {
        kind: "bluesky_account",
        title: `@${handle}`,
        itemTitles: await blueskyAccountPreview(handle),
        suggested: {
          id: slugify(`bsky-${handle}`),
          name: `@${handle}`,
          type: "bluesky",
          mode: "account",
          handle,
          category: "bluesky",
        },
      };
      return NextResponse.json(result);
    }

    if (!/^https?:\/\//i.test(input)) {
      return NextResponse.json(
        { error: "Not a URL or Bluesky handle. Paste an http(s) URL, @handle, or at:// feed URI." },
        { status: 400 }
      );
    }

    // Apple Podcasts link → resolve the RSS feed via the iTunes lookup API
    // (also captures apple_id for the tap-to-app handoff on podcast cards).
    const appleMatch = input.match(/podcasts\.apple\.com\/.*\/id(\d+)/i);
    if (appleMatch) {
      const appleId = appleMatch[1];
      const { text } = await fetchText(`https://itunes.apple.com/lookup?id=${appleId}&entity=podcast`);
      const data = JSON.parse(text) as {
        results?: Array<{ feedUrl?: string; collectionName?: string }>;
      };
      const feedUrl = data.results?.[0]?.feedUrl;
      if (!feedUrl) {
        return NextResponse.json({ error: "Apple Podcasts lookup found no RSS feed for that show" }, { status: 422 });
      }
      const { text: xml } = await fetchText(feedUrl);
      const result = await detectFromFeedXml(xml, feedUrl);
      result.kind = "podcast";
      result.suggested.type = "podcast";
      result.suggested.apple_id = appleId;
      result.suggested.category = "podcasts";
      return NextResponse.json(result);
    }

    // Plain URL: either it IS a feed, or it's an HTML page that links one.
    const { text, contentType } = await fetchText(input);
    if (looksLikeXml(text, contentType)) {
      return NextResponse.json(await detectFromFeedXml(text, input));
    }
    const feedUrl = findFeedLink(text, input);
    if (!feedUrl) {
      return NextResponse.json(
        { error: "No feed found — the page has no RSS/Atom <link rel=\"alternate\"> tag. Try the feed URL directly." },
        { status: 422 }
      );
    }
    const { text: xml } = await fetchText(feedUrl);
    return NextResponse.json(await detectFromFeedXml(xml, feedUrl));
  } catch (err) {
    const message = err instanceof Error
      ? err.name === "AbortError"
        ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : err.message
      : String(err);
    console.error("[api/tune/detect] Error:", message);
    return NextResponse.json({ error: `Couldn't reach that feed: ${message}` }, { status: 422 });
  }
}
