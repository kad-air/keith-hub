"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Chart } from "@/lib/charts";

interface Props {
  initialCharts: Chart[];
}

type FormState = {
  mode: "new" | "edit";
  id?: string;
  title: string;
  artist: string;
  content: string;
};

const EMPTY_FORM: FormState = {
  mode: "new",
  title: "",
  artist: "",
  content: "",
};

function lineCount(content: string): number {
  return content.split("\n").length;
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

export default function SetlistClient({ initialCharts }: Props) {
  const router = useRouter();
  const [charts, setCharts] = useState<Chart[]>(initialCharts);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [offlineReady, setOfflineReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bulkRef = useRef<HTMLInputElement>(null);
  const warmedRef = useRef<string>("");

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

  // Warm the service worker's setlist cache so EVERY chart is available
  // offline after one online visit to this index — not just the ones the user
  // happened to open. We fetch each chart's document (covers a cold PWA
  // relaunch / shared link) and router.prefetch its RSC payload (covers in-app
  // <Link> navigation); both responses land in the `setlist-pages` cache via
  // the SW rule. Keyed on id+updatedAt so adds/edits re-warm the changed page,
  // and guarded so it runs at most once per unchanged setlist per session.
  useEffect(() => {
    if (!online || charts.length === 0) return;
    const key = charts.map((c) => `${c.id}:${c.updatedAt}`).join(",");
    if (warmedRef.current === key) {
      setOfflineReady(true);
      return;
    }
    let cancelled = false;
    setOfflineReady(false);
    (async () => {
      for (const c of charts) {
        if (cancelled) return;
        const href = `/setlist/${c.id}`;
        try {
          await fetch(href);
          router.prefetch(href);
        } catch {
          // Lost the network mid-warm (or a transient failure). Leave the
          // ref unset so the next visit retries the remaining charts.
          return;
        }
      }
      if (!cancelled) {
        warmedRef.current = key;
        setOfflineReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [online, charts, router]);

  const offlineStatus = !online
    ? "● Offline · charts available"
    : charts.length === 0
      ? ""
      : offlineReady
        ? "✓ Saved for offline"
        : "Saving for offline…";

  const openNew = useCallback(() => {
    setError(null);
    setForm({ ...EMPTY_FORM });
  }, []);

  const openEdit = useCallback((c: Chart) => {
    setError(null);
    setForm({
      mode: "edit",
      id: c.id,
      title: c.title,
      artist: c.artist ?? "",
      content: c.content,
    });
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

  const save = useCallback(async () => {
    if (!form) return;
    if (!form.title.trim() || !form.content.trim()) {
      setError("Title and chart text are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const isEdit = form.mode === "edit";
      const url = isEdit ? `/api/charts/${form.id}` : "/api/charts";
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          artist: form.artist,
          content: form.content,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      const { chart } = (await res.json()) as { chart: Chart };
      setCharts((cur) =>
        isEdit
          ? cur.map((c) => (c.id === chart.id ? chart : c))
          : [...cur, chart],
      );
      closeForm();
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }, [form, closeForm]);

  const remove = useCallback(async (c: Chart) => {
    if (!window.confirm(`Delete "${c.title}" from the setlist?`)) return;
    const prev = charts;
    setCharts((cur) => cur.filter((x) => x.id !== c.id));
    try {
      const res = await fetch(`/api/charts/${c.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
    } catch {
      setCharts(prev);
    }
  }, [charts]);

  const move = useCallback(
    async (index: number, dir: -1 | 1) => {
      const target = index + dir;
      if (target < 0 || target >= charts.length) return;
      const next = [...charts];
      [next[index], next[target]] = [next[target], next[index]];
      const prev = charts;
      setCharts(next);
      try {
        const res = await fetch("/api/charts/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: next.map((c) => c.id) }),
        });
        if (!res.ok) throw new Error("reorder failed");
      } catch {
        setCharts(prev);
      }
    },
    [charts],
  );

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6 flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cat-practice">
            Guitar
          </p>
          <h1 className="mt-1 font-display text-2xl text-cream">Setlist</h1>
          <p className="mt-1 text-sm text-cream-dim">
            Chord charts with configurable-speed autoscroll. Hands-free.
          </p>
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
        {!form && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => bulkRef.current?.click()}
              disabled={busy}
              className="border border-rule/60 px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:opacity-50"
            >
              {busy ? "Uploading…" : "Bulk .txt"}
            </button>
            <button
              onClick={openNew}
              className="border border-cat-practice/60 bg-cat-practice/10 px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20"
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
          No charts yet. Tap{" "}
          <span className="font-mono text-cream">+ Add</span> to paste or upload
          a chord chart.
        </p>
      ) : (
        <ol className="list-none space-y-2">
          {charts.map((c, i) => (
            <li
              key={c.id}
              className="flex items-center gap-2 border border-rule/60 bg-ink-raised/40 px-3 py-2.5"
            >
              <span className="w-6 shrink-0 text-right font-mono text-[0.7rem] text-cream-dimmer">
                {i + 1}
              </span>
              <Link href={`/setlist/${c.id}`} className="min-w-0 flex-1">
                <span className="block truncate text-[0.95rem] text-cream hover:text-cat-practice">
                  {c.title}
                </span>
                <span className="block truncate font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
                  {c.artist ? `${c.artist} · ` : ""}
                  {lineCount(c.content)} lines
                </span>
              </Link>
              <div className="flex shrink-0 items-center gap-1">
                <IconBtn
                  label="Move up"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </IconBtn>
                <IconBtn
                  label="Move down"
                  disabled={i === charts.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </IconBtn>
                <IconBtn label="Edit" onClick={() => openEdit(c)}>
                  ✎
                </IconBtn>
                <IconBtn label="Delete" onClick={() => remove(c)}>
                  ✕
                </IconBtn>
              </div>
            </li>
          ))}
        </ol>
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

function ChartForm({
  form,
  setForm,
  busy,
  error,
  onSave,
  onCancel,
  onPickFile,
  fileRef,
  onFile,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState | null>>;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
  onPickFile: () => void;
  fileRef: React.RefObject<HTMLInputElement>;
  onFile: (file: File | undefined) => void;
}) {
  return (
    <section className="mb-6 border border-cat-practice/40 bg-ink-raised/30 p-4">
      <h2 className="mb-3 font-display text-lg text-cream">
        {form.mode === "edit" ? "Edit chart" : "New chart"}
      </h2>
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex-1">
            <span className="mb-1 block font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
              Title
            </span>
            <input
              value={form.title}
              onChange={(e) =>
                setForm((f) => (f ? { ...f, title: e.target.value } : f))
              }
              placeholder="Song title"
              className="w-full border border-rule/60 bg-ink px-3 py-2 text-sm text-cream outline-none focus:border-cat-practice/60"
            />
          </label>
          <label className="flex-1">
            <span className="mb-1 block font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
              Artist (optional)
            </span>
            <input
              value={form.artist}
              onChange={(e) =>
                setForm((f) => (f ? { ...f, artist: e.target.value } : f))
              }
              placeholder="Artist"
              className="w-full border border-rule/60 bg-ink px-3 py-2 text-sm text-cream outline-none focus:border-cat-practice/60"
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 flex items-center justify-between font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
            <span>Chart text</span>
            <button
              type="button"
              onClick={onPickFile}
              className="text-cat-practice hover:underline"
            >
              Upload .txt
            </button>
          </span>
          <textarea
            value={form.content}
            onChange={(e) =>
              setForm((f) => (f ? { ...f, content: e.target.value } : f))
            }
            placeholder={"[Verse 1]\nG            C\nPaste the chart here..."}
            rows={12}
            spellCheck={false}
            className="w-full resize-y whitespace-pre border border-rule/60 bg-ink px-3 py-2 font-mono text-[0.8rem] leading-relaxed text-cream outline-none focus:border-cat-practice/60"
          />
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.chordpro,.cho,.crd,.pro,text/plain"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        {error && <p className="text-sm text-cat-music">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            onClick={onSave}
            disabled={busy}
            className="border border-cat-practice/60 bg-cat-practice/10 px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="border border-rule/60 px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:text-cream disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}
