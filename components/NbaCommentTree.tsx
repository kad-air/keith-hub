"use client";

import { useState } from "react";
import type { SanitizedComment } from "@/components/NbaPostClient";

const MAX_DEPTH = 8;
const AUTO_COLLAPSE_DEPTH = 4;

interface Props {
  comments: SanitizedComment[];
  permalink: string;
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
  return `${Math.floor(days / 30)}mo`;
}

export default function NbaCommentTree({ comments, permalink }: Props) {
  return (
    <ul className="space-y-3">
      {comments.map((c) => (
        <li key={c.id}>
          <CommentNode comment={c} permalink={permalink} />
        </li>
      ))}
    </ul>
  );
}

function CommentNode({
  comment,
  permalink,
}: {
  comment: SanitizedComment;
  permalink: string;
}) {
  const [collapsed, setCollapsed] = useState(
    () => comment.depth >= AUTO_COLLAPSE_DEPTH && comment.replies.length > 0,
  );

  // Deep thread: render as a deep-link instead of continuing to recurse.
  if (comment.depth > MAX_DEPTH) {
    return (
      <a
        href={`https://old.reddit.com${permalink}${comment.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
      >
        Continue thread on old.reddit ↗
      </a>
    );
  }

  // "more" stub
  if (comment.more_count !== null) {
    if (comment.more_count === 0) return null;
    return (
      <a
        href={`https://old.reddit.com${permalink}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
      >
        + {comment.more_count} more replies ↗
      </a>
    );
  }

  const isDeleted = comment.author === "[deleted]" || comment.body_html_sanitized === "";
  const indentClass = comment.depth > 0 ? "border-l border-rule/30 pl-3" : "";

  return (
    <div className={indentClass}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
        <span className={isDeleted ? "italic text-cream-dimmer" : "text-cream"}>
          u/{comment.author}
        </span>
        {comment.distinguished === "moderator" && (
          <span className="text-accent">MOD</span>
        )}
        <span aria-hidden>·</span>
        <span>{comment.score} pts</span>
        <span aria-hidden>·</span>
        <span>{formatAge(comment.created_utc)}</span>
        {comment.replies.length > 0 && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-cream-dimmer hover:text-accent"
          >
            {collapsed ? `[+${comment.replies.length}]` : "[−]"}
          </button>
        )}
      </div>

      {!isDeleted && !collapsed && (
        <div
          className="nba-prose mt-1 font-display text-[0.95rem] leading-relaxed text-cream-dim"
          dangerouslySetInnerHTML={{ __html: comment.body_html_sanitized }}
        />
      )}
      {isDeleted && (
        <p className="mt-1 font-display text-[0.95rem] italic text-cream-dimmer">
          [deleted]
        </p>
      )}

      {!collapsed && comment.replies.length > 0 && (
        <ul className="mt-3 space-y-3">
          {comment.replies.map((r) => (
            <li key={r.id}>
              <CommentNode comment={r} permalink={permalink} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
