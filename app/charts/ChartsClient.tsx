"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chart } from "@/lib/charts";
import { ChartForm, EMPTY_FORM, type FormState } from "./ChartForm";

interface Props {
  initialCharts: Chart[];
  setlistCount: number;
  // Offline-flagged setlists + their member charts (id + updatedAt) — drives SW
  // cache warming. updatedAt is folded into the warm key so editing a member
  // chart re-warms its page rather than serving a stale render offline.
  offlineSetlists: { id: string; charts: { id: string; updatedAt: string }[] }[];
  // True for anonymous public visitors — hides every write affordance
  // (Add/Bulk/Delete). See lib/auth.ts#isAuthenticated.
  readOnly: boolean;
}

// Library sort. The full charts list loads at once, so sorting is a cheap
// client-side reorder of the in-memory array — no API round-trip. The choice
// persists in localStorage so it survives reloads.
type LibrarySort = "added" | "updated" | "title" | "artist";
const SORT_KEY = "charts-sort";
const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: "added", label: "Recently added" },
  { value: "updated", label: "Recently updated" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
];

function lineCount(content: string): number {
  return content.split("\n").length;
}

function sortCharts(charts: Chart[], sort: LibrarySort): Chart[] {
  const out = [...charts];
  switch (sort) {
    case "title":
      return out.sort((a, b) => a.title.localeCompare(b.title));
    case "artist":
      // Charts with no artist sort to the bottom; ties break on title.
      return out.sort((a, b) => {
        if (!a.artist && !b.artist) return a.title.localeCompare(b.title);
        if (!a.artist) return 1;
        if (!b.artist) return -1;
        const byArtist = a.artist.localeCompare(b.artist);
        return byArtist !== 0 ? byArtist : a.title.localeCompare(b.title);
      });
    case "updated":
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    case "added":
    default:
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

// Derive { artist, title } from a filename. Strips the extension, then splits
// on the first " - " separator following the "Artist - Title" convention
// (everything before is the artist, everything after is the title). Files with
// no separator become a title with no artist.
function parseFilename(name: string): { artist: string | null; title: string } {
  const base = name.replace(/\.[^.]+$/, "").trim();
  const sep = base.indexOf(" - ");
  if (sep === -1) return { artist: null, title: base };
  const artist = base.slice(0, sep).trim();
  const title = base.slice(sep + 3).trim();
  // Guard against leading/trailing separators (" - Title", "Artist - ") that
  // would yield an empty half — fall back to using the whole name as title.
  if (!artist || !title) return { artist: null, title: base };
  return { artist, title };
}

export default function ChartsClient({
  initialCharts,
  setlistCount,
  offlineSetlists,
  readOnly,
}: Props) {
  const router = useRouter();
  const [charts, setCharts] = useState<Chart[]>(initialCharts);
  const [sort, setSort] = useState<LibrarySort>("added");
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [offlineReady, setOfflineReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bulkRef = useRef<HTMLInputElement>(null);
  const warmedRef = useRef<string>("");

  // Hydrate the persisted sort after mount (localStorage is client-only).
  useEffect(() => {
    const saved = localStorage.getItem(SORT_KEY) as LibrarySort | null;
    if (saved && SORT_OPTIONS.some((o) => o.value === saved)) setSort(saved);
  }, []);

  const changeSort = useCallback((next: LibrarySort) => {
    setSort(next);
    localStorage.setItem(SORT_KEY, next);
  }, []);

  const sortedCharts = useMemo(
    () => sortCharts(charts, sort),
    [charts, sort],
  );

  // Track connectivity for the offline-status line. navigator.onLine is a
  // hint (it can read "online" with no real reachability), but it's the right
  // signal for a "you're offline" reassurance badge.
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Warm the SW cache for OFFLINE-FLAGGED setlists only — the library itself
  // is online-only by default (a chart still gets cached on demand when opened
  // online via the NetworkFirst rule). For each offline setlist we fetch its
  // detail page and every member chart's page (covers cold PWA relaunch /
  // shared link) and router.prefetch their RSC payloads (covers in-app <Link>
  // navigation); both land in the `charts-pages` cache. Keyed on the offline
  // set so adds/edits/toggles re-warm, and guarded so it runs at most once per
  // unchanged set per session.
  // Fold each member chart's updatedAt into the key so an edit re-warms the
  // page (id alone would short-circuit the guard and serve a stale render).
  const offlineKey = useMemo(
    () =>
      offlineSetlists
        .map(
          (s) =>
            `${s.id}:${s.charts.map((c) => `${c.id}@${c.updatedAt}`).join("+")}`,
        )
        .join(","),
    [offlineSetlists],
  );
  const offlineChartCount = useMemo(() => {
    const ids = new Set<string>();
    for (const s of offlineSetlists) for (const c of s.charts) ids.add(c.id);
    return ids.size;
  }, [offlineSetlists]);

  useEffect(() => {
    if (!online || offlineSetlists.length === 0) return;
    if (warmedRef.current === offlineKey) {
      setOfflineReady(true);
      return;
    }
    let cancelled = false;
    setOfflineReady(false);
    (async () => {
      const pages = new Set<string>();
      for (const s of offlineSetlists) {
        pages.add(`/charts/setlists/${s.id}`);
        for (const c of s.charts) pages.add(`/charts/${c.id}`);
      }
      for (const href of Array.from(pages)) {
        if (cancelled) return;
        try {
          await fetch(href);
          router.prefetch(href);
        } catch {
          // Lost the network mid-warm — leave the ref unset so the next visit
          // retries the remaining pages.
          return;
        }
      }
      if (!cancelled) {
        warmedRef.current = offlineKey;
        setOfflineReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [online, offlineSetlists, offlineKey, router]);

  // Only speak to offline availability when something was actually warmed —
  // with zero offline-flagged setlists nothing is cached, so "saved setlists
  // available" would be a lie when the connection drops.
  const offlineStatus =
    offlineSetlists.length === 0
      ? ""
      : !online
        ? "● Offline · saved setlists available"
        : offlineReady
          ? `✓ ${offlineChartCount} chart${offlineChartCount === 1 ? "" : "s"} saved for offline`
          : "Saving setlists for offline…";

  const openNew = useCallback(() => {
    setError(null);
    setForm({ ...EMPTY_FORM });
  }, []);

  const closeForm = useCallback(() => {
    setForm(null);
    setError(null);
  }, []);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const text = await file.text();
      setForm((f) => {
        if (!f) return f;
        // Use the filename (sans extension) as a title fallback when empty.
        const title =
          f.title.trim() || file.name.replace(/\.[^.]+$/, "").trim();
        return { ...f, content: text, title };
      });
    },
    [],
  );

  // Bulk upload: one chart per selected .txt file. Title and artist are parsed
  // from each filename via the "Artist - Title" convention (artist is blank
  // when there's no separator). Reads happen client-side, then a single POST
  // creates them all.
  const handleBulk = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const entries = await Promise.all(
        Array.from(files).map(async (file) => ({
          ...parseFilename(file.name),
          content: await file.text(),
        })),
      );
      const res = await fetch("/api/charts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charts: entries }),
      });
      if (!res.ok) throw new Error("bulk upload failed");
      const { charts: created, skipped } = (await res.json()) as {
        charts: Chart[];
        skipped: string[];
      };
      setCharts((cur) => [...cur, ...created]);
      const parts = [`Added ${created.length} chart${created.length === 1 ? "" : "s"}`];
      if (skipped?.length) parts.push(`skipped ${skipped.length} empty`);
      setNotice(parts.join(", ") + ".");
    } catch {
      setError("Bulk upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  // Create-only: editing an existing chart lives on the chart's own page
  // (ChartViewerClient), so this form only ever adds new library charts.
  const save = useCallback(async () => {
    if (!form) return;
    if (!form.title.trim() || !form.content.trim()) {
      setError("Title and chart text are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/charts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          artist: form.artist,
          content: form.content,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      const { chart } = (await res.json()) as { chart: Chart };
      setCharts((cur) => [...cur, chart]);
      closeForm();
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }, [form, closeForm]);

  const remove = useCallback(async (c: Chart) => {
    if (
      !window.confirm(
        `Delete "${c.title}" from the library? It will be removed from any setlists too.`,
      )
    )
      return;
    const prev = charts;
    setCharts((cur) => cur.filter((x) => x.id !== c.id));
    try {
      const res = await fetch(`/api/charts/${c.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
    } catch {
      setCharts(prev);
    }
  }, [charts]);

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6 flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
            Guitar
          </p>
          <h1 className="mt-1 font-display text-2xl text-cream">Charts</h1>
          <p className="mt-1 text-sm text-cream-dim">
            Your full library of chord charts. Build setlists from them.
          </p>
          <Link
            href="/charts/setlists"
            className="mt-1.5 inline-block font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice hover:underline"
          >
            Setlists ({setlistCount}) →
          </Link>
          {offlineStatus && (
            <p
              className={`mt-1.5 font-mono text-[0.6rem] uppercase tracking-kicker ${
                online ? "text-cream-dimmer" : "text-cat-practice"
              }`}
            >
              {offlineStatus}
            </p>
          )}
        </div>
        {!form && !readOnly && (
          // Writes need the network; disable Add/Bulk while offline so a
          // doomed request can't fail mysteriously mid-gig.
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => bulkRef.current?.click()}
              disabled={busy || !online}
              title={!online ? "Connect to add charts" : undefined}
              className="border border-rule/60 px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:opacity-50"
            >
              {busy ? "Uploading…" : "Bulk .txt"}
            </button>
            <button
              onClick={openNew}
              disabled={!online}
              title={!online ? "Connect to add charts" : undefined}
              className="border border-cat-practice/60 bg-cat-practice/10 px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20 disabled:opacity-50"
            >
              + Add
            </button>
          </div>
        )}
      </header>

      <input
        ref={bulkRef}
        type="file"
        multiple
        accept=".txt,.chordpro,.cho,.crd,.pro,text/plain"
        className="hidden"
        onChange={(e) => {
          handleBulk(e.target.files);
          e.target.value = "";
        }}
      />

      {notice && (
        <p className="mb-4 border border-cat-practice/40 bg-cat-practice/10 px-3 py-2 text-sm text-cream">
          {notice}
        </p>
      )}
      {!form && error && <p className="mb-4 text-sm text-cat-music">{error}</p>}

      {form && (
        <ChartForm
          form={form}
          setForm={setForm}
          busy={busy}
          error={error}
          onSave={save}
          onCancel={closeForm}
          onPickFile={() => fileRef.current?.click()}
          fileRef={fileRef}
          onFile={handleFile}
        />
      )}

      {charts.length === 0 && !form ? (
        <p className="mt-8 text-sm text-cream-dim">
          {readOnly ? (
            "No charts yet."
          ) : (
            <>
              No charts yet. Tap{" "}
              <span className="font-mono text-cream">+ Add</span> to paste or
              upload a chord chart.
            </>
          )}
        </p>
      ) : (
        <>
          {!form && charts.length > 1 && (
            <div className="mb-3 flex items-center justify-end gap-2">
              <label className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
                Sort
              </label>
              <select
                value={sort}
                onChange={(e) => changeSort(e.target.value as LibrarySort)}
                className="border border-rule/60 bg-ink px-2 py-1 font-mono text-[0.7rem] text-cream-dim outline-none focus:border-cat-practice/60"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <ol className="list-none space-y-2">
            {sortedCharts.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-1.5 border border-rule/60 bg-ink-raised/40 px-2 py-2.5 sm:gap-2 sm:px-3"
              >
                <Link
                  href={`/charts/${c.id}`}
                  className="min-w-0 flex-1"
                >
                  <span className="block truncate text-[0.95rem] text-cream hover:text-cat-practice">
                    {c.title}
                  </span>
                  <span className="block truncate font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
                    {c.artist ? `${c.artist} · ` : ""}
                    {lineCount(c.content)} lines
                  </span>
                </Link>
                {!readOnly && (
                  <div className="flex shrink-0 items-center gap-1">
                    <IconBtn
                      label="Delete"
                      onClick={() => remove(c)}
                      disabled={!online}
                    >
                      ✕
                    </IconBtn>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </article>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center border border-rule/50 font-mono text-xs text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
