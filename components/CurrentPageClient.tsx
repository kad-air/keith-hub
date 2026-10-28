"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { PageWindow, Precision } from "@/lib/books/pageText";

// The current-page view: the book's text at the latest synced position, set
// large and dark-on-paper for Audible's camera page-sync to read from a second
// screen. Follows new syncs on its own; prev/next nudge the page without
// losing the way back.

type Payload = {
  sync: {
    percentage: number;
    device: string | null;
    timestamp: number;
    word: number;
    precision: Precision;
  } | null;
  window: PageWindow;
};

const POLL_MS = 10_000;
const SIZES = ["text-[1.25rem]", "text-[1.5rem]", "text-[1.75rem]", "text-[2.1rem]"];
const SIZE_KEY = "books.currentPage.size";

const PRECISION_NOTE: Partial<Record<Precision, string>> = {
  paragraph: "Synced to the paragraph — the reader sent no position inside it.",
  percentage: "Approximate — mapped from the synced percentage, the position itself didn't resolve in this file.",
  none: "Nothing synced for this file yet — showing the start of the book.",
};

export default function CurrentPageClient({
  bookId,
  title,
  author,
}: {
  bookId: string;
  title: string;
  author: string | null;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where a prev/next nudge left the page; null = following the sync.
  const [nudged, setNudged] = useState<number | null>(null);
  const [size, setSize] = useState(1);
  const lastStamp = useRef<number | null>(null);
  const nudgedRef = useRef<number | null>(null);
  nudgedRef.current = nudged;

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(SIZE_KEY));
      if (Number.isInteger(saved) && saved >= 0 && saved < SIZES.length) setSize(saved);
    } catch {
      /* storage unavailable: default size */
    }
  }, []);

  const changeSize = (delta: number) => {
    const next = Math.min(SIZES.length - 1, Math.max(0, size + delta));
    setSize(next);
    try {
      localStorage.setItem(SIZE_KEY, String(next));
    } catch {
      /* not remembered, still applied */
    }
  };

  const fetchPage = useCallback(
    async (from: number | null): Promise<Payload | null> => {
      try {
        const res = await fetch(`/api/books/${bookId}/current-text${from != null ? `?from=${from}` : ""}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(body?.error ?? `couldn't load the page (${res.status})`);
          return null;
        }
        setError(null);
        return (await res.json()) as Payload;
      } catch {
        setError("couldn't reach the hub — retrying");
        return null;
      }
    },
    [bookId],
  );

  // Follow the sync: a new position replaces the page, even a nudged one.
  const poll = useCallback(async () => {
    const synced = await fetchPage(null);
    if (!synced) return;
    const stamp = synced.sync?.timestamp ?? null;
    const moved = stamp !== lastStamp.current;
    lastStamp.current = stamp;
    if (moved || nudgedRef.current == null) {
      setNudged(null);
      setData(synced);
    } else {
      // Same position, nudged page: keep the page, refresh the status line.
      setData((d) => (d ? { ...d, sync: synced.sync } : synced));
    }
  }, [fetchPage]);

  useEffect(() => {
    poll();
    const timer = setInterval(poll, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  const go = useCallback(
    async (from: number | null) => {
      if (from == null) return;
      const page = await fetchPage(from);
      if (!page) return;
      setNudged(from);
      setData(page);
      window.scrollTo({ top: 0 });
    },
    [fetchPage],
  );

  const backToSync = useCallback(async () => {
    setNudged(null);
    await poll();
    window.scrollTo({ top: 0 });
  }, [poll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") go(data?.window.nextFrom ?? null);
      else if (e.key === "ArrowLeft") go(data?.window.prevFrom ?? null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, go]);

  const sync = data?.sync ?? null;
  const w = data?.window ?? null;
  const note = sync ? PRECISION_NOTE[sync.precision] : PRECISION_NOTE.none;

  return (
    <div className="pb-28">
      <div className="mx-auto max-w-[44rem] px-4 pt-4 sm:px-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker">
          <Link href={`/books/${bookId}`} className="text-cream-dimmer hover:text-accent">
            ← {title}
          </Link>
        </p>
        <p className="mt-1 font-mono text-[0.7rem] text-cream-dim">
          {author ? `${author} · ` : ""}
          {sync
            ? `${(sync.percentage * 100).toFixed(1)}% · ${sync.device ?? "unknown device"} · synced ${new Date(
                sync.timestamp * 1000,
              ).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : "not synced"}
          {nudged != null && w ? ` · showing ${(w.fraction * 100).toFixed(1)}%` : ""}
        </p>
        {note && <p className="mt-1 font-mono text-[0.7rem] text-amber-400">{note}</p>}
        {error && <p className="mt-1 font-mono text-[0.7rem] text-red-400">{error}</p>}
      </div>

      <article
        className={`mx-auto mt-3 max-w-[44rem] bg-paper px-5 py-6 font-display leading-[1.55] text-paper-ink sm:px-8 sm:py-8 ${SIZES[size]}`}
      >
        {!w ? (
          <p className="text-paper-ink/60">Loading…</p>
        ) : w.blocks.length === 0 ? (
          <p className="text-paper-ink/60">No text in this book.</p>
        ) : (
          w.blocks.map((b, i) => {
            const body = (
              <>
                {b.cutStart && "…"}
                {b.mark ? (
                  <>
                    {b.text.slice(0, b.mark[0])}
                    <span className="underline decoration-accent decoration-[3px] underline-offset-[6px]">
                      {b.text.slice(b.mark[0], b.mark[1])}
                    </span>
                    {b.text.slice(b.mark[1])}
                  </>
                ) : (
                  b.text
                )}
                {b.cutEnd && "…"}
              </>
            );
            return b.heading ? (
              <h2 key={i} className="mb-[0.8em] mt-[0.4em] whitespace-pre-line text-center font-semibold">
                {body}
              </h2>
            ) : (
              <p key={i} className="mb-[0.7em] whitespace-pre-line">
                {body}
              </p>
            );
          })
        )}
      </article>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-rule/60 bg-ink/95 backdrop-blur">
        <div className="mx-auto flex max-w-[44rem] items-center gap-2 px-4 py-3 font-mono text-[0.75rem] uppercase tracking-kicker">
          <button
            onClick={() => go(w?.prevFrom ?? null)}
            disabled={w?.prevFrom == null}
            className="border border-rule/60 px-4 py-2 text-cream hover:border-accent/60 hover:text-accent disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <button
            onClick={backToSync}
            disabled={nudged == null}
            className="flex-1 border border-accent/60 px-3 py-2 text-accent hover:bg-accent/10 disabled:border-rule/40 disabled:text-cream-dimmer"
          >
            {nudged == null ? "At synced spot" : "Back to synced spot"}
          </button>
          <button
            onClick={() => go(w?.nextFrom ?? null)}
            disabled={w?.nextFrom == null}
            className="border border-rule/60 px-4 py-2 text-cream hover:border-accent/60 hover:text-accent disabled:opacity-40"
          >
            Next ›
          </button>
          <span className="ml-1 flex gap-1">
            <button onClick={() => changeSize(-1)} aria-label="Smaller text"
              className="border border-rule/60 px-2 py-2 text-cream-dim hover:text-accent">A−</button>
            <button onClick={() => changeSize(1)} aria-label="Larger text"
              className="border border-rule/60 px-2 py-2 text-cream-dim hover:text-accent">A+</button>
          </span>
        </div>
      </nav>
    </div>
  );
}
