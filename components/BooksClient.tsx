"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Book } from "@/lib/books/store";

type Item = {
  book: Book;
  sync: { percentage: number; device: string | null; timestamp: number } | null;
};

type Props = {
  items: Item[];
  unmatchedCount: number;
  apiKeyConfigured: boolean;
  opdsUrl: string | null;
  kosyncUrl: string | null;
};

function fmtSize(bytes: number): string {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export default function BooksClient({
  items,
  unmatchedCount,
  apiKeyConfigured,
  opdsUrl,
  kosyncUrl,
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
      const created = body.results.filter((r: { created?: boolean }) => r.created).length;
      const dup = body.results.length - created;
      setStatus(`Added ${created}${dup ? `, ${dup} already in library` : ""}`);
      router.refresh();
    } catch (err) {
      setStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

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
              + Add epubs
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
          accept=".epub"
          multiple
          hidden
          onChange={(e) => handleUpload(e.target.files)}
        />
        {status && <p className="mt-2 font-mono text-[0.75rem] text-accent">{status}</p>}
      </header>

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
        <p className="text-sm text-cream-dim">No books yet — add an epub to start the library.</p>
      ) : (
        [...byAuthor.entries()].map(([author, authorItems]) => (
          <section key={author} className="mb-8">
            <h2 className="mb-3 border-b border-rule/40 pb-1 font-display text-lg text-cream">
              {author}
            </h2>
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
              {authorItems.map(({ book, sync }) => (
                <li key={book.id}>
                  <Link
                    href={`/books/${book.id}`}
                    className="group block border border-rule/60 bg-ink-raised/40 transition-colors hover:border-accent/60"
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
              ))}
            </ul>
          </section>
        ))
      )}
    </article>
  );
}
