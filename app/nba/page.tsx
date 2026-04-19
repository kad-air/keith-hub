import type { Metadata } from "next";
import Link from "next/link";
import { fetchSubreddit } from "@/lib/reddit";
import type { RedditPost, RedditSort, RedditTopWindow } from "@/lib/reddit-types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "r/nba — hub" };

type SortKey = "hot" | "new" | "top-day";

const SORT_TABS: { key: SortKey; label: string; sort: RedditSort; t?: RedditTopWindow }[] = [
  { key: "hot", label: "Hot", sort: "hot" },
  { key: "new", label: "New", sort: "new" },
  { key: "top-day", label: "Top · Day", sort: "top", t: "day" },
];

function parseSortKey(raw: string | undefined): SortKey {
  if (raw === "new" || raw === "top-day") return raw;
  return "hot";
}

function formatAge(createdUtc: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - createdUtc));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const mos = Math.floor(days / 30);
  if (mos < 12) return `${mos}mo`;
  return `${Math.floor(mos / 12)}y`;
}

function formatScore(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function PostCard({ post }: { post: RedditPost }) {
  const thumb = post.thumb;
  const kicker =
    post.stickied
      ? "Pinned"
      : post.flair
      ? post.flair
      : post.is_self
      ? "Text"
      : post.media.kind === "reddit_video" || post.media.kind === "youtube" || post.media.kind === "gif_video"
      ? "Video"
      : post.media.kind === "image" || post.media.kind === "gallery"
      ? "Image"
      : post.domain || "Link";

  return (
    <li>
      <Link
        href={`/nba/${post.id}`}
        className="flex gap-3 border border-rule/60 bg-ink-raised/40 px-4 py-3 transition-colors hover:border-accent/60 hover:bg-ink-raised/70"
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="h-20 w-20 flex-shrink-0 rounded-sm object-cover sm:h-24 sm:w-24"
          />
        ) : (
          <div className="h-20 w-20 flex-shrink-0 rounded-sm border border-rule/40 bg-ink/60 sm:h-24 sm:w-24" />
        )}
        <div className="min-w-0 flex-1">
          <div
            className={[
              "font-mono text-[0.68rem] uppercase tracking-kicker",
              post.stickied ? "text-accent" : "text-cream-dimmer",
            ].join(" ")}
          >
            {kicker}
          </div>
          <h2 className="mt-1 font-display text-[1rem] leading-snug text-cream line-clamp-3">
            {post.title}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
            <span>{formatScore(post.score)} pts</span>
            <span aria-hidden>·</span>
            <span>{post.num_comments} comments</span>
            <span aria-hidden>·</span>
            <span>{formatAge(post.created_utc)}</span>
            <span aria-hidden>·</span>
            <span>u/{post.author}</span>
          </div>
        </div>
      </Link>
    </li>
  );
}

interface Props {
  searchParams: { sort?: string };
}

export default async function NbaIndexPage({ searchParams }: Props) {
  const sortKey = parseSortKey(searchParams.sort);
  const tab = SORT_TABS.find((t) => t.key === sortKey) ?? SORT_TABS[0];

  let posts: RedditPost[] = [];
  let errorMessage: string | null = null;
  try {
    posts = await fetchSubreddit("nba", { sort: tab.sort, t: tab.t });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Failed to load posts";
  }

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Subreddit
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">r/nba</h1>
        <p className="mt-1 text-sm text-cream-dim">
          Read-only browser. Tap a post to read comments inline.
        </p>
      </header>

      <nav className="mb-5 flex items-center gap-1.5">
        {SORT_TABS.map((t) => {
          const active = t.key === sortKey;
          const href = t.key === "hot" ? "/nba" : `/nba?sort=${t.key}`;
          return (
            <Link
              key={t.key}
              href={href}
              className={[
                "px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
                active
                  ? "border border-accent/60 bg-accent/10 text-accent"
                  : "border border-rule/40 text-cream-dim hover:border-rule-strong hover:text-cream",
              ].join(" ")}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {errorMessage ? (
        <div className="border border-rule/60 bg-ink-raised/40 px-4 py-6 text-sm text-cream-dim">
          <p className="font-display">Couldn&apos;t load r/nba.</p>
          <p className="mt-1 font-mono text-[0.7rem] text-cream-dimmer">{errorMessage}</p>
        </div>
      ) : posts.length === 0 ? (
        <p className="text-sm text-cream-dim">No posts found.</p>
      ) : (
        <ul className="space-y-3">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
        </ul>
      )}
    </article>
  );
}
