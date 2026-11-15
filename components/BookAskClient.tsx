"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AskTurn } from "@/lib/books/askStore";
import { progressNote } from "@/lib/books/ask";

// The conversation about one book. The thread is kept on the server
// (lib/books/askStore.ts) and the server sends the model only the text before
// the synced position (lib/books/ask.ts); this page shows the thread, streams
// the answer in, and re-reads the thread whenever it comes back into view —
// an answer finished while the phone was away is simply there.

type Status = {
  turns: AskTurn[];
  pending: boolean;
  configured: boolean;
  unavailable?: string;
  words?: number;
  totalWords?: number;
  percentage?: number;
};

const PENDING_POLL_MS = 3000;

/** **bold** and *italic*, nothing else. */
function inline(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*)/g).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-cream">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** An answer as paragraphs, with quoted passages set apart. */
function Answer({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((para, i) => {
          const lines = para.split("\n");
          if (lines.every((l) => l.startsWith(">"))) {
            return (
              <blockquote key={i} className="mt-3 border-l-2 border-rule pl-3 italic text-cream-dim first:mt-0">
                {inline(lines.map((l) => l.replace(/^>\s?/, "")).join("\n"))}
              </blockquote>
            );
          }
          return (
            <p key={i} className="mt-3 whitespace-pre-wrap first:mt-0">
              {inline(para.replace(/^#{1,6}\s+/, ""))}
            </p>
          );
        })}
    </>
  );
}

const QUESTION = "ml-8 border-l-2 border-accent/60 pl-3 font-display text-[1.05rem] leading-snug text-cream";

/** The line above a question: where the conversation starts, or the reading done since the last one. */
function Progress({ before, words, at }: { before: number | null; words: number | null; at: number }) {
  const note = words == null ? null : progressNote(before, words);
  if (!note) return null;
  return (
    <li className="flex items-center gap-3 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
      <span className="h-px flex-1 bg-rule/60" />
      {note} · {new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}
      <span className="h-px flex-1 bg-rule/60" />
    </li>
  );
}

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export default function BookAskClient({
  bookId,
  title,
  author,
  initialTurns,
}: {
  bookId: string;
  title: string;
  author: string | null;
  initialTurns: AskTurn[];
}) {
  const [turns, setTurns] = useState(initialTurns);
  const [status, setStatus] = useState<Status | null>(null);
  // The question being answered right now and what has streamed in so far.
  const [live, setLive] = useState<{ question: string; answer: string; words: number | null; at: number } | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/books/${bookId}/ask`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Status;
      setStatus(data);
      if (!liveRef.current) setTurns(data.turns);
    } catch {
      // offline: keep what is on screen
    }
  }, [bookId]);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // A question asked from here or another device whose answer is still being
  // written: look again until it lands.
  const waiting = !live && (status?.pending ?? false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const count = turns.length;
  const liveLength = live?.answer.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count, liveLength, waiting]);

  async function ask() {
    const q = question.trim();
    if (!q || liveRef.current) return;
    liveRef.current = true;
    setLive({ question: q, answer: "", words: status?.words ?? null, at: Date.now() });
    setQuestion("");
    setError(null);

    let failed: string | null = null;
    let refused = false;
    try {
      const res = await fetch(`/api/books/${bookId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok || !res.body) {
        refused = true;
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.t === "text") {
            answer += event.v;
            const shown = answer;
            setLive((l) => (l ? { ...l, answer: shown } : l));
          } else if (event.t === "meta") {
            const words = event.words as number;
            setLive((l) => (l ? { ...l, words } : l));
          } else if (event.t === "error") {
            failed = event.v;
          }
        }
      }
    } catch (err) {
      // A dropped connection is not a failed answer: the server finishes and
      // saves it, and the refresh below (or the next one) picks it up.
      if (refused) failed = err instanceof Error ? err.message : String(err);
    }

    liveRef.current = false;
    await refresh();
    setLive(null);
    if (failed) {
      setError(failed);
      if (refused) setQuestion(q);
    }
  }

  async function clear() {
    if (!window.confirm("Clear this conversation? It can't be brought back.")) return;
    const res = await fetch(`/api/books/${bookId}/ask`, { method: "DELETE" });
    if (res.ok) {
      setTurns([]);
      setError(null);
    }
  }

  const blocked = status?.unavailable ?? (status && !status.configured ? "ANTHROPIC_API_KEY is not set on the server, so questions are switched off." : null);
  const busy = live != null || waiting;
  const empty = turns.length === 0 && !live;

  return (
    <div className="pb-40">
      <div className="mx-auto max-w-[44rem] px-4 pt-4 sm:px-6">
        <div className="flex items-baseline justify-between gap-3 font-mono text-[0.7rem] uppercase tracking-kicker">
          <Link href={`/books/${bookId}`} className="text-cream-dimmer hover:text-accent">
            ← {title}
          </Link>
          {turns.length > 0 && !busy && (
            <button onClick={clear} className="shrink-0 uppercase tracking-kicker text-cream-dimmer hover:text-red-400">
              Clear
            </button>
          )}
        </div>
        <p className="mt-1 font-mono text-[0.7rem] text-cream-dim">
          {author ? `${author} · ` : ""}
          {status?.words != null && status.totalWords != null && status.percentage != null
            ? `Claude sees the first ${status.words.toLocaleString()} of ${status.totalWords.toLocaleString()} words (${pct(status.percentage)})`
            : "asking from what you've read"}
        </p>

        {empty && (
          <div className="mt-8 text-[0.95rem] leading-relaxed text-cream-dim">
            <p>
              Ask about anything up to where you are: who someone is, what happened earlier, what an
              allusion or a foreign phrase means.
            </p>
            <p className="mt-3 text-[0.8rem] text-cream-dimmer">
              Claude is sent the book up to your synced position and nothing after it. It can use
              what it knows about the wider world, and is told not to use what it knows of the rest
              of this book. For a well-known book that last part is an instruction, not a guarantee.
            </p>
          </div>
        )}

        <ol className="mt-6 space-y-6">
          {turns.map((t, i) => (
            <Fragment key={t.id}>
              {t.role === "user" && (
                <Progress before={i === 0 ? null : turns[i - 1].words} words={t.words} at={t.createdAt * 1000} />
              )}
              {t.role === "user" ? (
                <li className={QUESTION}>{t.content}</li>
              ) : (
                <li className="text-[0.95rem] leading-relaxed text-cream-dim">
                  <Answer text={t.content} />
                </li>
              )}
            </Fragment>
          ))}
          {live && (
            <>
              <Progress before={turns.length > 0 ? turns[turns.length - 1].words : null} words={live.words} at={live.at} />
              <li className={QUESTION}>{live.question}</li>
              <li className="text-[0.95rem] leading-relaxed text-cream-dim">
                {live.answer ? <Answer text={live.answer} /> : <span className="text-cream-dimmer">Reading…</span>}
              </li>
            </>
          )}
          {waiting && <li className="text-[0.95rem] text-cream-dimmer">Reading…</li>}
        </ol>
        {error && <p className="mt-4 font-mono text-[0.7rem] text-red-400">{error}</p>}
        <div ref={endRef} className="h-4" />
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-rule/60 bg-ink/95 backdrop-blur">
        <div className="mx-auto max-w-[44rem] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
          {blocked ? (
            <p className="text-[0.8rem] leading-relaxed text-cream-dim">{blocked}</p>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                ref={boxRef}
                rows={2}
                className="w-full resize-none border border-rule/60 bg-ink px-2 py-1.5 text-[1rem] text-cream placeholder:text-cream-dimmer focus:border-accent/60 focus:outline-none"
                value={question}
                placeholder={empty ? "Ask about what you've read" : "Follow up"}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask();
                  }
                }}
              />
              <button
                onClick={ask}
                disabled={busy || !question.trim()}
                className="shrink-0 border border-accent/60 px-4 py-2 font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:bg-accent/10 disabled:opacity-50"
              >
                {busy ? "…" : "Ask"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
