import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchPostWithComments, sanitizeRedditHtml } from "@/lib/reddit";
import type { RedditComment } from "@/lib/reddit-types";
import NbaPostClient, { type SanitizedComment } from "@/components/NbaPostClient";

export const dynamic = "force-dynamic";

interface Props {
  params: { postId: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const { post } = await fetchPostWithComments(params.postId);
    return { title: `${post.title} — r/nba` };
  } catch {
    return { title: "r/nba — hub" };
  }
}

export default async function NbaPostPage({ params }: Props) {
  let post, comments;
  try {
    ({ post, comments } = await fetchPostWithComments(params.postId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed";
    if (msg.includes("Post not found") || msg.includes("404")) notFound();
    return (
      <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
        <div className="border border-rule/60 bg-ink-raised/40 px-4 py-6 text-sm text-cream-dim">
          <p className="font-display">Couldn&apos;t load this post.</p>
          <p className="mt-1 font-mono text-[0.7rem] text-cream-dimmer">{msg}</p>
          <Link href="/nba" className="mt-3 inline-block font-mono text-[0.7rem] uppercase tracking-kicker text-accent">
            ← Back to r/nba
          </Link>
        </div>
      </article>
    );
  }

  // Sanitize HTML server-side so the client never handles untrusted markup.
  const selftextSanitized = sanitizeRedditHtml(post.selftext_html);
  const commentsWithSanitized = sanitizeComments(comments);

  return (
    <NbaPostClient
      post={post}
      selftextSanitized={selftextSanitized}
      comments={commentsWithSanitized}
    />
  );
}

function sanitizeComments(comments: RedditComment[]): SanitizedComment[] {
  return comments.map((c) => ({
    ...c,
    body_html_sanitized: sanitizeRedditHtml(c.body_html),
    replies: sanitizeComments(c.replies),
  }));
}
