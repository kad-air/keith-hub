"use client";

import { useEffect, useRef, useState } from "react";

// Ask a question about a book in progress. The server sends the model only the
// text before the synced position (lib/books/ask.ts); this component just holds
// the conversation, which lives in memory and is gone on reload.

type Turn = { role: "user" | "assistant"; content: string };
type Info = { configured: boolean; words: number; totalWords: number; percentage: number };

export default function BookAsk({ bookId }: { bookId: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/books/${bookId}/ask`)
      .then(async (res) => {
        const data = await res.json();
        if (!live) return;
        if (!res.ok) setUnavailable(data?.error ?? `HTTP ${res.status}`);
        else setInfo(data);
      })
      .catch(() => live && setUnavailable("Couldn't check whether questions are available."));
    return () => {
      live = false;
      abortRef.current?.abort();
    };
  }, [bookId]);

  async function ask() {
    const q = question.trim();
    if (!q || answering) return;
    const history = turns;
    setTurns([...history, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setQuestion("");
    setError(null);
    setAnswering(true);
    const abort = new AbortController();
    abortRef.current = abort;

    let answer = "";
    let failed: string | null = null;
    try {
      const res = await fetch(`/api/books/${bookId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
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
            setTurns((t) => [...t.slice(0, -1), { role: "assistant", content: shown }]);
          } else if (event.t === "meta") {
            setInfo((i) => (i ? { ...i, words: event.words, totalWords: event.totalWords, percentage: event.percentage } : i));
          } else if (event.t === "error") {
            failed = event.v;
          }
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) failed = err instanceof Error ? err.message : String(err);
    } finally {
      setAnswering(false);
    }

    // A turn with no answer can't be sent back as history, so it is dropped
    // and the question returns to the box.
    if (!answer.trim()) {
      setTurns(history);
      setQuestion(q);
    }
    if (failed) setError(failed);
  }

  const shell = "mt-4 border border-rule/60 bg-ink-raised/40 px-4 py-3 text-sm";
  const heading = (
    <h2 className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
      Ask about what you&apos;ve read
    </h2>
  );

  if (unavailable) {
    return (
      <section className={shell}>
        {heading}
        <p className="mt-2 text-[0.8rem] leading-relaxed text-cream-dim">{unavailable}</p>
      </section>
    );
  }
  if (!info) return null;

  return (
    <section className={shell}>
      {heading}
      <p className="mt-2 text-[0.8rem] leading-relaxed text-cream-dim">
        Claude is given the book up to your synced position (the first{" "}
        {info.words.toLocaleString()} of {info.totalWords.toLocaleString()} words,{" "}
        {(info.percentage * 100).toFixed(1)}%) and nothing after it. It can use what it knows
        about the wider world, such as allusions, history and jargon, and is told not to use what
        it knows of the rest of this book. For a well-known book that last part is an instruction,
        not a guarantee.
      </p>

      {!info.configured ? (
        <p className="mt-2 font-mono text-[0.7rem] text-red-400">
          ANTHROPIC_API_KEY is not set on the server, so questions are switched off.
        </p>
      ) : (
        <>
          {turns.length > 0 && (
            <ol className="mt-3 space-y-3">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <li key={i} className="border-l-2 border-accent/60 pl-3 text-cream">
                    {t.content}
                  </li>
                ) : (
                  <li key={i} className="whitespace-pre-wrap leading-relaxed text-cream-dim">
                    {t.content || (answering ? "Reading…" : "")}
                  </li>
                ),
              )}
            </ol>
          )}
          <div className="mt-3 flex gap-2">
            <textarea
              rows={2}
              className="w-full border border-rule/60 bg-ink px-2 py-1 text-[0.9rem] text-cream placeholder:text-cream-dimmer focus:border-accent/60 focus:outline-none"
              value={question}
              placeholder="Who is this again? What happened at…?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask();
                }
              }}
            />
            {answering ? (
              <button
                onClick={() => abortRef.current?.abort()}
                className="shrink-0 self-start border border-rule/60 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={ask}
                disabled={!question.trim()}
                className="shrink-0 self-start border border-accent/60 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:bg-accent/10 disabled:opacity-50"
              >
                Ask
              </button>
            )}
          </div>
          {turns.length > 0 && !answering && (
            <button
              onClick={() => {
                setTurns([]);
                setError(null);
              }}
              className="mt-2 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer hover:text-accent"
            >
              Start over
            </button>
          )}
          {error && <p className="mt-2 font-mono text-[0.7rem] text-red-400">{error}</p>}
        </>
      )}
    </section>
  );
}
