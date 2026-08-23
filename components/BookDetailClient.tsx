"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Book } from "@/lib/books/store";
import type { BookHistory } from "@/lib/books/statsData";
import type { BookHealth } from "@/lib/books/healthData";
import type { HealthSeverity } from "@/lib/books/health";
import type { PhraseSearchResult, PositionCandidate } from "@/lib/books/xpointer";
import { finishLabel } from "@/lib/books/stats";

const finishDate = (days: number) => finishLabel(days, Date.now());

const SEVERITY_STYLE: Record<HealthSeverity, { label: string; className: string }> = {
  red: { label: "broken", className: "text-red-400" },
  amber: { label: "degraded", className: "text-amber-400" },
  info: { label: "note", className: "text-cream-dim" },
};

type Props = {
  book: Book;
  sync: {
    progress: string;
    percentage: number;
    device: string | null;
    timestamp: number;
  } | null;
  history: BookHistory | null;
  health: BookHealth | null;
};

export default function BookDetailClient({ book, sync, history, health }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [toRead, setToRead] = useState(book.toRead);
  const [form, setForm] = useState({
    title: book.title,
    author: book.author ?? "",
    series: book.series ?? "",
    seriesIndex: book.seriesIndex != null ? String(book.seriesIndex) : "",
    description: book.description ?? "",
  });

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/books/${book.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          author: form.author || null,
          series: form.series || null,
          seriesIndex: form.seriesIndex ? Number(form.seriesIndex) : null,
          description: form.description || null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditing(false);
      setStatus("Saved");
      router.refresh();
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Optimistic: the flag is a one-column write and the only cost of a failed
  // round trip is the star flipping back.
  async function toggleToRead() {
    const next = !toRead;
    setToRead(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/books/${book.id}/to-read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toRead: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(next ? "Added to To Read — it's on the device now" : "Removed from To Read");
      router.refresh();
    } catch (err) {
      setToRead(!next);
      setStatus(`Couldn't update: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // --- Catch up (audiobook → device position) ---
  const [phrase, setPhrase] = useState("");
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<PhraseSearchResult | null>(null);
  const [catchStatus, setCatchStatus] = useState<string | null>(null);

  async function findPosition() {
    setSearching(true);
    setCatchStatus(null);
    setFound(null);
    try {
      const res = await fetch(`/api/books/${book.id}/find-position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setFound(data);
      if (data.candidates.length === 0) {
        setCatchStatus("No good match — try a longer or more distinctive stretch.");
      }
    } catch (err) {
      setCatchStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  async function setPosition(c: PositionCandidate) {
    setBusy(true);
    setCatchStatus(null);
    try {
      const res = await fetch(`/api/books/${book.id}/set-position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pointer: c.pointer, percentage: c.percentage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setFound(null);
      setPhrase("");
      setCatchStatus(
        `Position set to ${(c.percentage * 100).toFixed(1)}% — sync the device to pick it up.`,
      );
      router.refresh();
    } catch (err) {
      setCatchStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${book.title}" from the library? The synced reading position is kept.`)) {
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/books/${book.id}`, { method: "DELETE" });
    if (res.ok) router.push("/books");
    else {
      setStatus(`Delete failed: HTTP ${res.status}`);
      setBusy(false);
    }
  }

  const field =
    "w-full border border-rule/60 bg-ink px-2 py-1.5 text-sm text-cream focus:border-accent/60 focus:outline-none";

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <p className="mb-4 font-mono text-[0.7rem] uppercase tracking-kicker">
        <Link href="/books" className="text-cream-dimmer hover:text-accent">
          ← Books
        </Link>
      </p>

      <div className="flex gap-6">
        <div className="w-32 shrink-0 sm:w-40">
          <div className="aspect-[2/3] overflow-hidden border border-rule/60 bg-ink-raised">
            {book.coverName ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/books/${book.id}/cover`} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center p-2 text-center font-display text-sm text-cream-dim">
                {book.title}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          {!editing ? (
            <>
              <h1 className="font-display text-2xl text-cream">{book.title}</h1>
              {book.author && <p className="mt-1 text-sm text-cream-dim">{book.author}</p>}
              {book.series && (
                <p className="mt-0.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
                  {book.series}
                  {book.seriesIndex != null && ` #${book.seriesIndex}`}
                </p>
              )}
              {book.description && (
                <p className="mt-3 line-clamp-6 text-sm leading-relaxed text-cream-dim">
                  {book.description}
                </p>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <input className={field} value={form.title} placeholder="Title"
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <input className={field} value={form.author} placeholder="Author"
                onChange={(e) => setForm({ ...form, author: e.target.value })} />
              <div className="flex gap-2">
                <input className={field} value={form.series} placeholder="Series"
                  onChange={(e) => setForm({ ...form, series: e.target.value })} />
                <input className={`${field} w-20`} value={form.seriesIndex} placeholder="#"
                  onChange={(e) => setForm({ ...form, seriesIndex: e.target.value })} />
              </div>
              <textarea className={`${field} h-24`} value={form.description} placeholder="Description"
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!editing ? (
              <>
                <button
                  onClick={toggleToRead}
                  disabled={busy}
                  aria-pressed={toRead}
                  className={`border px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker disabled:opacity-50 ${
                    toRead
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-rule/60 text-cream-dim hover:border-accent/60 hover:text-accent"
                  }`}
                >
                  {toRead ? "★ On To Read" : "☆ To Read"}
                </button>
                <a
                  href={`/api/books/${book.id}/file`}
                  className="border border-accent/60 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:bg-accent/10"
                >
                  Download
                </a>
                <button onClick={() => setEditing(true)}
                  className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent">
                  Edit
                </button>
                <button onClick={remove} disabled={busy}
                  className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer hover:text-red-400">
                  Delete
                </button>
              </>
            ) : (
              <>
                <button onClick={save} disabled={busy}
                  className="border border-accent/60 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:bg-accent/10 disabled:opacity-50">
                  Save
                </button>
                <button onClick={() => setEditing(false)}
                  className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent">
                  Cancel
                </button>
              </>
            )}
            {status && <span className="font-mono text-[0.7rem] text-accent">{status}</span>}
          </div>
        </div>
      </div>

      <section className="mt-8 border border-rule/60 bg-ink-raised/40 px-4 py-3 text-sm">
        <h2 className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Reading position
        </h2>
        {sync ? (
          <dl className="mt-2 space-y-1 text-cream-dim">
            <div className="flex justify-between">
              <dt>Progress</dt>
              <dd className="text-cream">{(sync.percentage * 100).toFixed(1)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt>Device</dt>
              <dd className="font-mono text-[0.75rem]">{sync.device ?? "unknown"}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Synced</dt>
              <dd className="font-mono text-[0.75rem]">
                {new Date(sync.timestamp * 1000).toLocaleString()}
              </dd>
            </div>
            <div className="mt-1 border-t border-rule/40 pt-1">
              <dt className="text-cream-dimmer">Position (opaque — stored exactly as sent)</dt>
              <dd className="break-all font-mono text-[0.7rem] text-cream-dimmer">{sync.progress}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-cream-dim">
            No synced position yet — it appears after a device reads this exact file.
          </p>
        )}
      </section>

      <section className="mt-4 border border-rule/60 bg-ink-raised/40 px-4 py-3 text-sm">
        <h2 className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Catch up from the audiobook
        </h2>
        <p className="mt-2 text-[0.8rem] leading-relaxed text-cream-dim">
          Heard a line? Type or dictate it — a few distinctive words are enough. The match is
          fuzzy on purpose: spelling, punctuation and a missed word or two don&apos;t matter.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            className={field}
            value={phrase}
            placeholder="a stretch of what you just heard"
            onChange={(e) => setPhrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !searching && phrase.trim()) findPosition();
            }}
          />
          <button
            onClick={findPosition}
            disabled={searching || busy || phrase.trim().split(/\s+/).length < 3}
            className="shrink-0 border border-accent/60 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            {searching ? "Searching…" : "Find"}
          </button>
        </div>

        {found && found.candidates.length > 0 && (
          <ul className="mt-3 space-y-2">
            {found.candidates.map((c) => {
              const backwards = sync != null && c.percentage < sync.percentage;
              const grade =
                c.confidence >= 0.85 ? "strong" : c.confidence >= 0.65 ? "good" : "weak";
              return (
                <li key={c.pointer} className="border border-rule/40 bg-ink px-3 py-2">
                  <p className="text-[0.8rem] leading-relaxed text-cream-dim">{c.snippet}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.65rem] uppercase tracking-kicker">
                    <span className="text-cream">{(c.percentage * 100).toFixed(1)}%</span>
                    <span
                      className={
                        grade === "strong"
                          ? "text-accent"
                          : grade === "good"
                            ? "text-cream-dim"
                            : "text-red-400"
                      }
                    >
                      {grade} match · {c.matchedWords}/{found.queryWords} words
                    </span>
                    {backwards && (
                      <span className="text-red-400">
                        behind the device ({(sync!.percentage * 100).toFixed(1)}%)
                      </span>
                    )}
                    <button
                      onClick={() => setPosition(c)}
                      disabled={busy}
                      className="ml-auto border border-accent/60 px-2 py-0.5 text-accent hover:bg-accent/10 disabled:opacity-50"
                    >
                      Set position
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {catchStatus && (
          <p className="mt-2 font-mono text-[0.7rem] text-accent">{catchStatus}</p>
        )}
      </section>

      {history && !history.started && history.readingDaysToFinish != null && (
        <section className="mt-4 border border-rule/60 bg-ink-raised/40 px-4 py-3 text-sm text-cream-dim">
          {history.totalPages?.toLocaleString()} pages · approx.{" "}
          <span className="text-accent">
            {history.readingDaysToFinish} day{history.readingDaysToFinish === 1 ? "" : "s"} of
            reading
          </span>{" "}
          at your pace
        </section>
      )}

      {history?.started && (
        <section className="mt-4 border border-rule/60 bg-ink-raised/40 px-4 py-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
              Your history with this book
            </h2>
            <Link
              href="/books/stats"
              className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
            >
              All stats →
            </Link>
          </div>

          {/* Two tiles, not three — "Sittings" used to sit here and was
              removed: the X3 pushes progress manually, so a sitting count
              measured how often sync was tapped. */}
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
            <div>
              <dt className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                Days with progress
              </dt>
              <dd className="font-display text-xl tabular-nums text-cream">{history.daysRead}</dd>
            </div>
            <div>
              <dt className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                Pages here
              </dt>
              <dd className="font-display text-xl tabular-nums text-cream">
                {history.pages.toLocaleString()}
                {history.totalPages != null && (
                  <span className="font-mono text-[0.7rem] text-cream-dimmer">
                    {" "}
                    / {history.totalPages.toLocaleString()}
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {history.finishes.length > 0 ? (
            <p className="mt-3 border-t border-rule/40 pt-2 text-cream-dim">
              <span className="text-accent">Finished</span>{" "}
              {new Date(history.finishes[0].finishedAt * 1000).toLocaleDateString()}
              {history.finishes[0].daysTaken != null &&
                ` — ${history.finishes[0].daysTaken} day${history.finishes[0].daysTaken === 1 ? "" : "s"} start to finish`}
              {history.finishes.length > 1 && ` · read ${history.finishes.length} times`}
            </p>
          ) : history.readingDaysToFinish != null ? (
            <p className="mt-3 border-t border-rule/40 pt-2 text-cream-dim">
              {history.pagesLeft?.toLocaleString()} pages to go · approx.{" "}
              <span className="text-accent">
                {history.readingDaysToFinish} day{history.readingDaysToFinish === 1 ? "" : "s"} of
                reading
              </span>
              {history.daysToFinish != null && ` · around ${finishDate(history.daysToFinish)}`}
            </p>
          ) : (
            <p className="mt-3 border-t border-rule/40 pt-2 text-cream-dimmer">
              {history.pagesLeft != null
                ? `${history.pagesLeft.toLocaleString()} pages to go`
                : "No page count for this file"}
            </p>
          )}
        </section>
      )}

      {health && (
        <section className="mt-4 border border-rule/60 bg-ink-raised/40 px-4 py-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
              File health
            </h2>
            <span className="font-mono text-[0.65rem] text-cream-dimmer">
              checked {new Date(health.checkedAt).toLocaleDateString()}
            </span>
          </div>

          {health.findings.length === 0 ? (
            // Healthy stays quiet: one line, no dashboard.
            <p className="mt-2 text-cream-dim">
              No issues found — {health.stats.spineDocs.toLocaleString()} spine document
              {health.stats.spineDocs === 1 ? "" : "s"},{" "}
              {health.stats.words.toLocaleString()} words
              {health.stats.tocEntries != null && `, ${health.stats.tocEntries} chapters in the TOC`}
              .
            </p>
          ) : (
            <>
              <ul className="mt-2 space-y-2">
                {health.findings.map((f) => (
                  <li key={f.code}>
                    <p className="text-[0.8rem] leading-relaxed text-cream-dim">
                      <span
                        className={`mr-2 font-mono text-[0.6rem] uppercase tracking-kicker ${SEVERITY_STYLE[f.severity].className}`}
                      >
                        {SEVERITY_STYLE[f.severity].label}
                      </span>
                      {f.summary}
                    </p>
                    {f.detail && (
                      <p className="mt-0.5 pl-4 text-[0.7rem] leading-relaxed text-cream-dimmer">
                        {f.detail}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {health.findings.some((f) => f.severity !== "info") && (
                <p className="mt-3 border-t border-rule/40 pt-2 text-[0.7rem] leading-relaxed text-cream-dimmer">
                  Fixing any of this means replacing the file with a better copy — which is a new
                  book with a fresh sync identity, because devices identify a book by its exact
                  bytes.
                </p>
              )}
            </>
          )}
        </section>
      )}

      <section className="mt-4 text-cream-dimmer">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.7rem] sm:grid-cols-3">
          <div>
            <dt className="uppercase tracking-kicker">Size</dt>
            <dd>{(book.fileSize / (1 << 20)).toFixed(1)} MB</dd>
          </div>
          <div>
            <dt className="uppercase tracking-kicker">Added</dt>
            <dd>{new Date(book.addedAt).toLocaleDateString()}</dd>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <dt className="uppercase tracking-kicker">Sync hash (partial md5)</dt>
            <dd className="break-all">{book.partialMd5}</dd>
          </div>
        </dl>
        <p className="mt-3 text-[0.7rem] leading-relaxed">
          The stored file is immutable: metadata edits touch only this page, never the epub, because
          devices identify the book by a hash of its exact bytes.
        </p>
      </section>
    </article>
  );
}
