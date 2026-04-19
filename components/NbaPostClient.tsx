"use client";

import Link from "next/link";
import type { RedditComment, RedditPost } from "@/lib/reddit-types";
import NbaPostMedia from "@/components/NbaPostMedia";
import NbaCommentTree from "@/components/NbaCommentTree";

export type SanitizedComment = Omit<RedditComment, "replies"> & {
  body_html_sanitized: string;
  replies: SanitizedComment[];
};

interface Props {
  post: RedditPost;
  selftextSanitized: string;
  comments: SanitizedComment[];
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
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function NbaPostClient({ post, selftextSanitized, comments }: Props) {
  const oldRedditUrl = `https://old.reddit.com${post.permalink}`;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <nav className="mb-5 flex items-center justify-between gap-3">
        <Link
          href="/nba"
          className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
        >
          ← r/nba
        </Link>
        <a
          href={oldRedditUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer hover:text-accent"
        >
          View on reddit.com ↗
        </a>
      </nav>

      <header className="mb-5">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          r/{post.subreddit}
          {post.flair ? ` · ${post.flair}` : ""}
          {post.stickied ? " · Pinned" : ""}
        </p>
        <h1 className="mt-1 font-display text-[1.6rem] leading-snug text-cream">
          {post.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
          <span>{formatScore(post.score)} pts</span>
          <span aria-hidden>·</span>
          <span>{post.num_comments} comments</span>
          <span aria-hidden>·</span>
          <span>{formatAge(post.created_utc)}</span>
          <span aria-hidden>·</span>
          <span>u/{post.author}</span>
          {post.distinguished === "moderator" && (
            <span className="text-accent">· MOD</span>
          )}
        </div>
      </header>

      <section className="mb-6">
        <NbaPostMedia media={post.media} permalink={post.permalink} />
      </section>

      {selftextSanitized && (
        <section
          className="nba-prose mb-8 font-display text-[1rem] leading-relaxed text-cream-dim"
          dangerouslySetInnerHTML={{ __html: selftextSanitized }}
        />
      )}

      <hr className="my-6 border-rule/40" />

      <section>
        <h2 className="mb-4 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Comments ({post.num_comments})
        </h2>
        {comments.length === 0 ? (
          <p className="text-sm text-cream-dim">No comments yet.</p>
        ) : (
          <NbaCommentTree comments={comments} permalink={post.permalink} />
        )}
      </section>
    </article>
  );
}
