"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Book } from "@/lib/books/store";

type Item = {
  book: Book;
  sync: { percentage: number; device: string | null; timestamp: number } | null;
};

type Summary = {
  hasHistory: boolean;
  streak: number;
  bankedToday: boolean;
  atRisk: boolean;
  pagesToday: number;
  pagesThisYear: number;
  booksFinishedThisYear: number;
};

type Props = {
  items: Item[];
  unmatchedCount: number;
  apiKeyConfigured: boolean;
  opdsUrl: string | null;
  kosyncUrl: string | null;
  summary: Summary;
};

function fmtSize(bytes: number): string {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** One cover in the grid. Shared by the To Read shelf and the author sections
 *  so a book looks identical wherever it appears. */
function BookCard({
  item,
  toRead,
  onToggleToRead,
}: {
  item: Item;
  toRead: boolean;
  onToggleToRead: () => void;
}) {
  const { book, sync } = item;
  return (
    <li className="relative">
      {/* 🔴 Outside the <Link>, not inside it. A button nested in an anchor is
          invalid HTML and the browser's click handling for it is inconsistent;
          keeping it a sibling positioned over the cover means the star can
          never navigate and the cover can never toggle. */}
      <button
        onClick={onToggleToRead}
        aria-pressed={toRead}
        aria-label={toRead ? `Remove ${book.title} from To Read` : `Add ${book.title} to To Read`}
        title={toRead ? "On the To Read shelf" : "Add to To Read"}
        // Always visible, never hover-revealed. A hover-only control is
        // unreachable on the phone, and a width breakpoint is the wrong proxy
        // for touch (an iPad is wide and has no hover). Dim when off, accent
        // when on — the affordance is cheap enough to just leave on screen.
        className={`absolute right-1 top-1 z-10 flex h-7 w-7 items-center justify-center border text-[0.8rem] leading-none transition-colors ${
          toRead
            ? "border-accent bg-ink/85 text-accent"
            : "border-rule/60 bg-ink/70 text-cream-dimmer hover:border-accent/60 hover:text-accent"
        }`}
      >
        {toRead ? "★" : "☆"}
      </button>
      <Link
        href={`/books/${book.id}`}
        className={`group/card group block border bg-ink-raised/40 transition-colors hover:border-accent/60 ${
          toRead ? "border-accent/50" : "border-rule/60"
        }`}
      >
        <div className="relative aspect-[2/3] overflow-hidden bg-ink-raised">
          {book.coverName ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/books/${book.id}/cover`}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-3 text-center font-display text-sm text-cream-dim">
              {book.title}
            </div>
          )}
          {sync && (
            <div
              className="absolute inset-x-0 bottom-0 h-1 bg-ink/70"
              title={`${Math.round(sync.percentage * 100)}% read`}
            >
              <div
                className="h-full bg-accent"
                style={{ width: `${Math.min(100, sync.percentage * 100)}%` }}
              />
            </div>
          )}
        </div>
        <div className="px-2 py-2">
          <p className="truncate font-display text-sm text-cream group-hover:text-accent">
            {book.title}
          </p>
          <p className="truncate font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
            {book.series
              ? `${book.series}${book.seriesIndex != null ? ` #${book.seriesIndex}` : ""}`
              : fmtSize(book.fileSize)}
            {sync && ` · ${Math.round(sync.percentage * 100)}%`}
          </p>
        </div>
      </Link>
    </li>
  );
}

/** The one-line nudge, on the page you already open. Reads as an invitation
 *  when the streak is alive and unbanked, and as a scoreboard otherwise. */
function StreakStrip({ summary }: { summary: Summary }) {
  const { streak, bankedToday, atRisk, pagesToday, pagesThisYear, booksFinishedThisYear } = summary;

  const headline =
    streak === 0
      ? "No streak going"
      : `${streak} day${streak === 1 ? "" : "s"} running`;
  const nudge =
    streak === 0
      ? "A few pages today starts one."
      : atRisk
        ? "Not read today yet."
        : `${pagesToday} page${pagesToday === 1 ? "" : "s"} today.`;

  return (
    <Link
      href="/books/stats"
      className={`mb-6 flex items-center justify-between gap-4 border px-4 py-2.5 transition-colors ${
        atRisk
          ? "border-accent/50 bg-accent/[0.06] hover:border-accent"
          : "border-rule/60 bg-ink-raised/40 hover:border-accent/60"
      }`}
    >
      <div className="flex items-baseline gap-3">
        <span
          className={`font-display text-2xl leading-none tabular-nums ${
            streak > 0 ? "text-accent" : "text-cream-dimmer"
          }`}
        >
          {streak}
        </span>
        <span className="text-sm text-cream">
          {headline} <span className="text-cream-dim">· {nudge}</span>
        </span>
      </div>
      <span className="hidden shrink-0 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer sm:block">
        {pagesThisYear.toLocaleString()} pages · {booksFinishedThisYear} finished this year
      </span>
    </Link>
  );
}

export default function BooksClient({
  items,
  unmatchedCount,
  apiKeyConfigured,
  opdsUrl,
  kosyncUrl,
  summary,
}: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  // Origin resolved client-side (empty during SSR) so the rendered setup URLs
  // are copy-pasteable absolute URLs without a hydration mismatch.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setStatus(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      const res = await fetch("/api/books/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      type UploadResult = { created?: boolean; error?: string; fileName?: string };
      const rows: UploadResult[] = body.results;
      const failed = rows.filter((r) => r.error);
      const created = rows.filter((r) => r.created).length;
      const dup = rows.length - created - failed.length;
      // A refused file used to be counted as a duplicate, which is exactly
      // backwards for the DRM guard — the whole point is that the user is
      // told why nothing was added.
      const parts = [];
      if (created) parts.push(`Added ${created}`);
      if (dup) parts.push(`${dup} already in library`);
      if (failed.length === 1) parts.push(`couldn't add ${failed[0].fileName}: ${failed[0].error}`);
      else if (failed.length > 1) parts.push(`${failed.length} couldn't be added: ${failed[0].error}`);
      setStatus(parts.length ? parts.join(" · ") : "Nothing to add");
      router.refresh();
    } catch (err) {
      setStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Optimistic per-book flag, keyed by id, so a star flips instantly and the
  // grid doesn't wait on a round trip. Falls back to the server value.
  const [toReadOverride, setToReadOverride] = useState<Record<string, boolean>>({});
  const isToRead = (b: Book) => toReadOverride[b.id] ?? b.toRead;

  async function toggleToRead(book: Book) {
    const next = !isToRead(book);
    setToReadOverride((m) => ({ ...m, [book.id]: next }));
    try {
      const res = await fetch(`/api/books/${book.id}/to-read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toRead: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      setToReadOverride((m) => ({ ...m, [book.id]: !next }));
      setStatus("Couldn't update To Read");
    }
  }

  const toReadItems = items.filter((i) => isToRead(i.book));

  // Group by author for the shelf view.
  const byAuthor = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.book.author ?? "Unknown Author";
    byAuthor.set(key, [...(byAuthor.get(key) ?? []), item]);
  }

  return (
    <article className="mx-auto max-w-[900px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Section
        </p>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="mt-1 font-display text-2xl text-cream">Books</h1>
          <div className="flex items-center gap-3">
            <Link
              href="/books/stats"
              className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
            >
              Stats
            </Link>
            <Link
              href="/books/discworld"
              className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
            >
              Discworld
            </Link>
            <button
              onClick={() => setShowSetup((v) => !v)}
              className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
            >
              Device setup
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="border border-accent/60 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-accent hover:bg-accent/10 disabled:opacity-50"
            >
              + Add books
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-cream-dim">
          {items.length} book{items.length === 1 ? "" : "s"} · served to the X3 and Readest over
          OPDS · reading position synced via KOReader sync
          {unmatchedCount > 0 && (
            <span className="text-cream-dimmer">
              {" "}
              · {unmatchedCount} synced position{unmatchedCount === 1 ? "" : "s"} for books not in
              the library
            </span>
          )}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".epub,.acsm"
          multiple
          hidden
          onChange={(e) => handleUpload(e.target.files)}
        />
        {status && <p className="mt-2 font-mono text-[0.75rem] text-accent">{status}</p>}
      </header>

      {summary.hasHistory && <StreakStrip summary={summary} />}

      {showSetup && (
        <section className="mb-8 border border-rule/60 bg-ink-raised/40 px-4 py-3 text-sm">
          <h2 className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
            Device setup
          </h2>
          {!apiKeyConfigured ? (
            <p className="mt-2 text-cream-dim">
              <code className="text-accent">BOOKS_API_KEY</code> is not set — the OPDS and sync
              endpoints refuse every request until it is. Generate one with{" "}
              <code>openssl rand -hex 32</code> and set it in the environment.
            </p>
          ) : (
            <dl className="mt-2 space-y-3 text-cream-dim">
              <div>
                <dt className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
                  OPDS catalog (CrossPoint · Readest)
                </dt>
                <dd className="mt-0.5 break-all font-mono text-[0.75rem] text-cream">
                  {origin}
                  {opdsUrl}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
                  KOReader sync server
                </dt>
                <dd className="mt-0.5 break-all font-mono text-[0.75rem] text-cream">
                  {origin}
                  {kosyncUrl}
                </dd>
              </div>
              <div>
                {/* These two fail SILENTLY when wrong — hence on-screen, not a
                    tooltip (BOOKS_PLAN §9). */}
                <dt className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
                  The two settings that fail silently
                </dt>
                <dd className="mt-0.5">
                  CrossPoint: document matching = <strong className="text-cream">Binary</strong>{" "}
                  (koMatchMethod 1). Readest: checksum method ={" "}
                  <strong className="text-cream">File Content</strong>. Same thing, two names —
                  anything else and sync never matches, with no error.
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
                  Rule that keeps sync alive
                </dt>
                <dd className="mt-0.5">
                  Always download books onto devices <em>from this library</em>. A different copy of
                  the same title has different bytes, a different hash, and will silently never
                  sync.
                </dd>
              </div>
            </dl>
          )}
        </section>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-cream-dim">No books yet — add an epub (or an Adobe .acsm) to start the library.</p>
      ) : (
        <>
          {/* The shelf, mirrored from the OPDS feed so the toggle's effect is
              visible here too — same books, same newest-first order. */}
          {toReadItems.length > 0 && (
            <section className="mb-8">
              <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-rule/40 pb-1">
                <h2 className="font-display text-lg text-cream">★ To Read</h2>
                <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
                  first folder on the X3
                </p>
              </div>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {toReadItems.map((item) => (
                  <BookCard
                    key={item.book.id}
                    item={item}
                    toRead
                    onToggleToRead={() => toggleToRead(item.book)}
                  />
                ))}
              </ul>
            </section>
          )}

          {[...byAuthor.entries()].map(([author, authorItems]) => (
            <section key={author} className="mb-8">
              <h2 className="mb-3 border-b border-rule/40 pb-1 font-display text-lg text-cream">
                {author}
              </h2>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {authorItems.map((item) => (
                  <BookCard
                    key={item.book.id}
                    item={item}
                    toRead={isToRead(item.book)}
                    onToggleToRead={() => toggleToRead(item.book)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </article>
  );
}
