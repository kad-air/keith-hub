"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Answer } from "@/components/BookAskClient";
import type { HelperTurn } from "@/lib/christmas/helperStore";

// The list helper's conversation, adapted from the books "Ask" page
// (components/BookAskClient.tsx): the thread lives on the server and is shared
// by everyone on the list, the answer streams in, the page re-reads the thread
// when it comes back into view, and the question box sits at the foot of a
// screen-tall column (sticky, not fixed — see BookAskClient on iOS).
//
// What is new here: the helper can change the list (on the server, through
// its tools — lib/christmas/helper.ts). Each change shows under the answer as
// it lands, and an answer's changes can be undone together.

type Status = { turns: HelperTurn[]; pending: boolean; configured: boolean };

const PENDING_POLL_MS = 3000;

const STARTERS = [
  "What's left to buy?",
  "Who is over or close to budget?",
  "Suggest 3 stocking stuffers for each kid and add them as ideas",
];

const ANSWER = "font-display text-[1.075rem] leading-[1.6] text-cream sm:text-[1.125rem]";
const QUESTION =
  "scroll-mt-28 border-l-2 border-accent pl-4 font-display text-[1.25rem] italic leading-snug text-cream sm:text-[1.4rem]";

function Changes({
  lines,
  state,
  onUndo,
}: {
  lines: string[];
  state?: "idle" | "busy" | "undone" | "live";
  onUndo?: () => void;
}) {
  if (!lines.length) return null;
  const undone = state === "undone";
  return (
    <div className="mt-3 border-l-2 border-cat-xmas/50 pl-3">
      <ul className={`space-y-1 font-mono text-[0.72rem] leading-snug ${undone ? "text-cream-dimmer line-through" : "text-cream-dim"}`}>
        {lines.map((l, i) => (
          <li key={i}>
            <span className="text-cat-xmas">✓</span> {l}
          </li>
        ))}
      </ul>
      {state !== "live" && (
        <div className="mt-2 font-mono text-[0.62rem] uppercase tracking-kicker">
          {undone ? (
            <span className="text-cream-dimmer">Undone</span>
          ) : onUndo ? (
            <button type="button" onClick={onUndo} disabled={state === "busy"} className="text-accent hover:text-cream disabled:text-cream-dimmer">
              {state === "busy" ? "Undoing…" : "Undo these changes"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function HelperClient({ initial }: { initial: Status }) {
  const [turns, setTurns] = useState(initial.turns);
  const [status, setStatus] = useState<Status>(initial);
  const [live, setLive] = useState<{ question: string; answer: string; changes: string[]; at: number } | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<number | null>(null);
  const liveRef = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/christmas/helper", { cache: "no-store" });
      if (res.status === 401) {
        setError("You've been signed out of the list. Reload the page to enter the passcode again.");
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as Status;
      setStatus(data);
      if (!liveRef.current) setTurns(data.turns);
    } catch {
      // offline: keep what is on screen
    }
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // A question asked here or on the other phone, still being answered.
  const waiting = !live && status.pending;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  // The newest question goes to the top of the screen on arriving and when one
  // is asked — never while the answer streams in (BookAskClient explains why).
  const toLastQuestion = useCallback(() => {
    listRef.current?.querySelector<HTMLElement>("[data-last-question]")?.scrollIntoView({ block: "start" });
  }, []);
  useEffect(() => {
    toLastQuestion();
  }, [toLastQuestion]);
  const asking = live?.at ?? null;
  useEffect(() => {
    if (asking != null) toLastQuestion();
  }, [asking, toLastQuestion]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 168)}px`;
  }, [question]);

  async function ask(text?: string) {
    const q = (text ?? question).trim();
    if (!q || liveRef.current) return;
    liveRef.current = true;
    setLive({ question: q, answer: "", changes: [], at: Date.now() });
    setQuestion("");
    setError(null);

    let failed: string | null = null;
    let refused = false;
    try {
      const res = await fetch("/api/christmas/helper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok || !res.body) {
        refused = true;
        const data = await res.json().catch(() => null);
        throw new Error(res.status === 401 ? "You've been signed out. Reload the page to enter the passcode again." : data?.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      const changes: string[] = [];
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
          } else if (event.t === "change") {
            changes.push(event.v);
            const shown = [...changes];
            setLive((l) => (l ? { ...l, changes: shown } : l));
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

  async function undo(turnId: number) {
    setUndoing(turnId);
    try {
      const res = await fetch("/api/christmas/helper/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Couldn't undo those changes.");
      }
      await refresh();
    } finally {
      setUndoing(null);
    }
  }

  async function clear() {
    if (!window.confirm("Clear this conversation for everyone? It can't be brought back. The list itself stays as it is.")) return;
    const res = await fetch("/api/christmas/helper", { method: "DELETE" });
    if (res.ok) {
      setTurns([]);
      setError(null);
    }
  }

  const blocked = !status.configured ? "The helper is switched off: there's no Anthropic API key on the server." : null;
  const busy = live != null || waiting;
  const empty = turns.length === 0 && !live;
  const lastIndex = turns.reduce((at, t, i) => (t.role === "user" ? i : at), -1);

  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col">
      <div className="flex-1">
        {turns.length > 0 && !busy && (
          <div className="flex justify-end">
            <button onClick={clear} className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer hover:text-accent">
              Clear
            </button>
          </div>
        )}

        {empty && (
          <div className="mt-4 font-display text-[1.075rem] leading-[1.6] text-cream-dim">
            <p>
              Ask about the list, or ask for changes: “add a $40 Lego set for Hudson from Parents”, “mark the game table
              purchased at $185”, “give each kid $50 more budget”.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy || !!blocked}
                  onClick={() => ask(s)}
                  className="border border-rule/60 px-3 py-1.5 text-left font-display text-[0.95rem] italic text-cream transition-colors hover:border-cat-xmas/60 hover:text-cat-xmas disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="mt-6 font-mono text-[0.68rem] leading-relaxed text-cream-dimmer">
              Everyone on the list sees this conversation. Changes the helper makes show up on the list straight away,
              and each answer’s changes can be undone together.
            </p>
          </div>
        )}

        <ol ref={listRef} className="mt-4 space-y-7">
          {turns.map((t, i) => (
            <Fragment key={t.id}>
              {t.role === "user" ? (
                <li className={QUESTION} {...(!live && i === lastIndex ? { "data-last-question": "" } : {})}>
                  {t.content}
                </li>
              ) : (
                <li className={ANSWER}>
                  <Answer text={t.content} />
                  <Changes
                    lines={t.changes}
                    state={t.undone ? "undone" : undoing === t.id ? "busy" : "idle"}
                    onUndo={t.undoable ? () => undo(t.id) : undefined}
                  />
                </li>
              )}
            </Fragment>
          ))}
          {live && (
            <>
              <li className={QUESTION} data-last-question="">
                {live.question}
              </li>
              <li className={ANSWER}>
                {live.answer ? <Answer text={live.answer} /> : <Thinking />}
                <Changes lines={live.changes} state="live" />
              </li>
            </>
          )}
          {waiting && (
            <li className={ANSWER}>
              <Thinking />
            </li>
          )}
        </ol>
        {error && <p className="mt-6 font-mono text-[0.7rem] text-accent">{error}</p>}
        {!empty && <div aria-hidden className="h-[40dvh]" />}
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 border-t border-rule/60 bg-ink/95 backdrop-blur sm:-mx-6">
        <div className="px-4 pb-[max(0.875rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
          {blocked ? (
            <p className="text-[0.8rem] leading-relaxed text-cream-dim">{blocked}</p>
          ) : (
            <div className="flex items-end gap-1 border border-rule bg-ink-raised/60 pl-3 focus-within:border-accent/70">
              <textarea
                ref={boxRef}
                rows={1}
                maxLength={1000}
                aria-label="Message the helper"
                className="min-h-[2.75rem] w-full resize-none bg-transparent py-2.5 font-display text-[1.075rem] leading-snug text-cream placeholder:text-cream-dimmer focus:outline-none"
                value={question}
                placeholder={empty ? "Ask the helper…" : "Ask a follow-up"}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask();
                  }
                }}
              />
              <button
                onClick={() => ask()}
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
  return <span className="animate-pulse font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">Checking the list</span>;
}
