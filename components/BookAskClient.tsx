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

/** Inline marks: **bold**, *italic*, `code`. */
function inline(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|`[^`\n]+`)/g).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

type Block =
  | { kind: "p" | "h" | "quote"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

/** The Markdown an answer actually uses: paragraphs, headings, lists, quotes. */
export function answerBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  const close = () => {
    open = null;
  };
  const start = (b: Block) => {
    blocks.push(b);
    open = b;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      close();
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      close();
      continue; // a rule: the spacing between blocks already says it
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line) ?? /^\s*\*\*([^*]+)\*\*:?\s*$/.exec(line);
    if (heading) {
      close();
      blocks.push({ kind: "h", text: heading[1].replace(/\s*#+\s*$/, "").replace(/^\*\*(.+)\*\*$/, "$1") });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      const item = (bullet ?? numbered)![1];
      const cur = open as Block | null;
      if (cur && cur.kind === kind) cur.items.push(item);
      else start({ kind, items: [item] });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const cur = open as Block | null;
      if (cur && cur.kind === "quote") cur.text += "\n" + quote[1];
      else start({ kind: "quote", text: quote[1] });
      continue;
    }
    const cur = open as Block | null;
    if (cur && (cur.kind === "ul" || cur.kind === "ol") && /^\s{2,}\S/.test(raw)) {
      cur.items[cur.items.length - 1] += " " + line.trim(); // a wrapped list item
    } else if (cur && cur.kind === "p") {
      cur.text += " " + line.trim();
    } else {
      start({ kind: "p", text: line.trim() });
    }
  }
  return blocks;
}

function Answer({ text }: { text: string }) {
  return (
    <div className="space-y-4">
      {answerBlocks(text).map((b, i) => {
        if (b.kind === "h") {
          return (
            <h3 key={i} className="pt-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim first:pt-0">
              {inline(b.text)}
            </h3>
          );
        }
        if (b.kind === "quote") {
          return (
            <blockquote key={i} className="whitespace-pre-line border-l-2 border-rule pl-4 italic text-cream-dim">
              {inline(b.text)}
            </blockquote>
          );
        }
        if (b.kind === "ul") {
          return (
            <ul key={i} className="space-y-2">
              {b.items.map((item, k) => (
                <li key={k} className="relative pl-5 before:absolute before:left-0 before:text-cream-dimmer before:content-['–']">
                  {inline(item)}
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === "ol") {
          return (
            <ol key={i} className="space-y-2">
              {b.items.map((item, k) => (
                <li key={k} className="relative pl-7">
                  <span className="absolute left-0 font-mono text-[0.75em] leading-[2.2] text-cream-dimmer">{k + 1}</span>
                  {inline(item)}
                </li>
              ))}
            </ol>
          );
        }
        return <p key={i}>{inline((b as { text: string }).text)}</p>;
      })}
    </div>
  );
}

const ANSWER = "font-display text-[1.075rem] leading-[1.6] text-cream sm:text-[1.125rem]";
const QUESTION =
  "scroll-mt-28 border-l-2 border-accent pl-4 font-display text-[1.3rem] italic leading-snug text-cream sm:text-[1.45rem]";

/** The line above a question: where the conversation starts, or the reading done since the last one. */
function Progress({ before, words, at }: { before: number | null; words: number | null; at: number }) {
  const note = words == null ? null : progressNote(before, words);
  if (!note) return null;
  return (
    <li className="flex items-center gap-3 pt-4 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer first:pt-0">
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
  const listRef = useRef<HTMLOListElement>(null);
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

  // Bring the newest question to the top of the screen: on arriving, and when
  // one is asked. Never follow the answer as it streams — it is being read from
  // its first line, and a page that moves under the reader is worse than a tap.
  const lastQuestionId = [...turns].reverse().find((t) => t.role === "user")?.id ?? null;
  const anchorKey = live ? "live" : lastQuestionId;
  useEffect(() => {
    if (anchorKey == null) return;
    const el = listRef.current?.querySelector<HTMLElement>("[data-last-question]");
    el?.scrollIntoView({ block: "start" });
  }, [anchorKey]);

  // The box grows with what is typed, up to a few lines.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 168)}px`;
  }, [question]);

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

  const lastIndex = turns.reduce((at, t, i) => (t.role === "user" ? i : at), -1);

  return (
    // A column as tall as the screen under the masthead: the thread grows, the
    // box sits at the foot of it. The box is `sticky`, not `fixed` — on iOS a
    // fixed bar is left stranded mid-screen when the keyboard goes away.
    <div className="flex min-h-[calc(100dvh-3.75rem)] flex-col">
      <div className="mx-auto w-full max-w-[40rem] flex-1 px-5 pt-5 sm:px-6 sm:pt-8">
        <header className="border-b border-rule/60 pb-4">
          <div className="flex items-baseline justify-between gap-4 font-mono text-[0.65rem] uppercase tracking-kicker">
            <Link href={`/books/${bookId}`} className="text-cream-dimmer hover:text-accent">
              ← Book
            </Link>
            {turns.length > 0 && !busy && (
              <button onClick={clear} className="shrink-0 uppercase tracking-kicker text-cream-dimmer hover:text-red-400">
                Clear
              </button>
            )}
          </div>
          <h1 className="mt-3 font-display text-[1.6rem] leading-tight text-cream sm:text-[1.9rem]">{title}</h1>
          <p className="mt-1.5 font-mono text-[0.68rem] leading-relaxed text-cream-dim">
            {author ? `${author} · ` : ""}
            {status?.words != null && status.totalWords != null && status.percentage != null
              ? `read to ${pct(status.percentage)} · Claude sees those ${status.words.toLocaleString()} words and no further`
              : "asking from what you've read"}
          </p>
        </header>

        {empty && (
          <div className="mt-10 font-display text-[1.075rem] leading-[1.6] text-cream-dim">
            <p>
              Ask about anything up to where you are: who someone is, what happened earlier, what an
              allusion or a foreign phrase means.
            </p>
            <p className="mt-4 font-mono text-[0.7rem] leading-relaxed text-cream-dimmer">
              Claude is sent the book up to your synced position and nothing after it. It can use
              what it knows about the wider world, and is told not to use what it knows of the rest
              of this book. For a well-known book that last part is an instruction, not a guarantee.
            </p>
          </div>
        )}

        <ol ref={listRef} className="mt-8 space-y-7">
          {turns.map((t, i) => (
            <Fragment key={t.id}>
              {t.role === "user" && (
                <Progress before={i === 0 ? null : turns[i - 1].words} words={t.words} at={t.createdAt * 1000} />
              )}
              {t.role === "user" ? (
                <li className={QUESTION} {...(!live && i === lastIndex ? { "data-last-question": "" } : {})}>
                  {t.content}
                </li>
              ) : (
                <li className={ANSWER}>
                  <Answer text={t.content} />
                </li>
              )}
            </Fragment>
          ))}
          {live && (
            <>
              <Progress before={turns.length > 0 ? turns[turns.length - 1].words : null} words={live.words} at={live.at} />
              <li className={QUESTION} data-last-question="">
                {live.question}
              </li>
              <li className={ANSWER}>{live.answer ? <Answer text={live.answer} /> : <Thinking />}</li>
            </>
          )}
          {waiting && (
            <li className={ANSWER}>
              <Thinking />
            </li>
          )}
        </ol>
        {error && <p className="mt-6 font-mono text-[0.7rem] text-red-400">{error}</p>}
        {/* Room for the newest question to reach the top of the screen. */}
        {!empty && <div aria-hidden className="h-[45dvh]" />}
      </div>

      <div className="sticky bottom-0 z-20 border-t border-rule/60 bg-ink/95 backdrop-blur">
        <div className="mx-auto max-w-[40rem] px-5 pb-[max(0.875rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
          {blocked ? (
            <p className="text-[0.8rem] leading-relaxed text-cream-dim">{blocked}</p>
          ) : (
            <div className="flex items-end gap-1 border border-rule bg-ink-raised/60 pl-3 focus-within:border-accent/70">
              <textarea
                ref={boxRef}
                rows={1}
                className="min-h-[2.75rem] w-full resize-none bg-transparent py-2.5 font-display text-[1.075rem] leading-snug text-cream placeholder:text-cream-dimmer focus:outline-none"
                value={question}
                placeholder={empty ? "Ask about what you've read" : "Ask a follow-up"}
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
                className="h-[2.75rem] shrink-0 px-4 font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:bg-accent/10 disabled:text-cream-dimmer"
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

function Thinking() {
  return <span className="animate-pulse font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">Reading</span>;
}
