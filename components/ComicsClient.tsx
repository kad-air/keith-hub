"use client";

import { useCallback, useMemo, useState } from "react";
import type { Storyline } from "@/lib/comics-data";
import { useKeyboard } from "@/lib/useKeyboard";

interface Props {
  storyline: Storyline;
  initialReadIds: string[];
}

// The new Marvel Comics app (replaced Marvel Unlimited, Nov 2026). Its web
// issue pages (www.marvelcomicsapp.com/issues/{id}) are not universal links
// on iOS, so from the PWA they'd open a web page, not the app. Instead we
// build the same AppsFlyer OneLink the site's own "open in app" button
// builds, which deep-links to the issue's page in the app and falls back to
// the web otherwise. See scripts/comics-data-pipeline.md.
function marvelComicsAppUrl(appIssueId: number): string {
  const deepLink = `marvelcomicsapp://issueHome?issueId=${appIssueId}`;
  const url = new URL("https://goto.marvelcomicsapp.com/w9za");
  url.searchParams.set("pid", "MCWeb");
  url.searchParams.set("c", "WtA_IssueHome");
  url.searchParams.set("af_channel", "MoWeb");
  url.searchParams.set("af_dp", deepLink);
  url.searchParams.set("deep_link_value", deepLink);
  url.searchParams.set("issueId", String(appIssueId));
  url.searchParams.set("af_force_deeplink", "true");
  url.searchParams.set("af_ss_ui", "true");
  return url.toString();
}

export default function ComicsClient({ storyline, initialReadIds }: Props) {
  const [readIds, setReadIds] = useState<Set<string>>(
    () => new Set(initialReadIds),
  );

  const total = storyline.issues.length;
  const readCount = readIds.size;
  const pct = total === 0 ? 0 : Math.round((readCount / total) * 100);

  const setRead = useCallback(async (id: string, read: boolean) => {
    const prev = readIds;
    setReadIds((cur) => {
      const next = new Set(cur);
      if (read) next.add(id);
      else next.delete(id);
      return next;
    });
    try {
      const res = await fetch(
        `/api/comics/${id}/${read ? "read" : "unread"}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error("save failed");
    } catch {
      setReadIds(prev);
    }
  }, [readIds]);

  const handleLink = useCallback(
    (id: string) => {
      // Auto-mark read on tap. Fire-and-forget; UI updates optimistically.
      // Anchor's default navigation is allowed to proceed (no preventDefault)
      // so iOS sees a real top-level click and can hand off to the Marvel
      // Comics app.
      if (!readIds.has(id)) void setRead(id, true);
    },
    [readIds, setRead],
  );

  const handleCheckboxChange = useCallback(
    (id: string, checked: boolean) => {
      if (!checked) {
        // Going from checked -> unchecked: confirm before unmarking.
        if (!window.confirm("Mark this issue unread?")) return;
        void setRead(id, false);
      } else {
        void setRead(id, true);
      }
    },
    [setRead],
  );

  // `x` on the issue j/k landed on (the row link carries data-issue-id)
  // flips its read state, same confirm rule as the checkbox.
  useKeyboard({
    x: () => {
      const id = (document.activeElement as HTMLElement | null)?.dataset.issueId;
      if (!id) return;
      handleCheckboxChange(id, !readIds.has(id));
    },
  });

  const rows = useMemo(
    () =>
      storyline.issues.map((issue, idx) => {
        const isRead = readIds.has(issue.id);
        const url = marvelComicsAppUrl(issue.appIssueId);
        return (
          <li
            key={issue.id}
            className="flex items-center gap-3 border-b border-rule/40 py-2"
          >
            <span className="w-8 shrink-0 text-right font-mono text-[0.7rem] text-cream-dimmer">
              {idx + 1}
            </span>
            <input
              type="checkbox"
              checked={isRead}
              onChange={(e) =>
                handleCheckboxChange(issue.id, e.currentTarget.checked)
              }
              aria-label={`Mark ${issue.title} ${isRead ? "unread" : "read"}`}
              className="h-4 w-4 shrink-0 cursor-pointer accent-accent"
            />
            <a
              href={url}
              data-kb-item
              data-issue-id={issue.id}
              rel="noopener noreferrer"
              onClick={() => handleLink(issue.id)}
              className={[
                "flex-1 truncate text-[0.95rem] transition-colors",
                isRead
                  ? "text-cream-dimmer line-through"
                  : "text-cream hover:text-accent",
              ].join(" ")}
            >
              {issue.title}
            </a>
          </li>
        );
      }),
    [storyline.issues, readIds, handleCheckboxChange, handleLink],
  );

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Reading order
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">
          {storyline.title}
        </h1>
        {storyline.description && (
          <p className="mt-1 text-sm text-cream-dim">{storyline.description}</p>
        )}
        <div className="mt-4 flex items-center gap-3">
          <span className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim">
            {readCount} / {total} read
          </span>
          <div
            className="h-1 flex-1 overflow-hidden bg-rule/40"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </header>

      <ol className="list-none">{rows}</ol>
    </article>
  );
}
