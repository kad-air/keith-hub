"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Setlist } from "@/lib/setlists";

interface Props {
  initialSetlists: Setlist[];
}

export default function SetlistsClient({ initialSetlists }: Props) {
  const [setlists, setSetlists] = useState<Setlist[]>(initialSetlists);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

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

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the setlist a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error("create failed");
      const { setlist } = (await res.json()) as { setlist: Setlist };
      setSetlists((cur) => [...cur, setlist]);
      setName("");
      setCreating(false);
    } catch {
      setError("Couldn't create the setlist. Try again.");
    } finally {
      setBusy(false);
    }
  }, [name]);

  const remove = useCallback(
    async (s: Setlist) => {
      if (
        !window.confirm(
          `Delete the setlist "${s.name}"? The charts stay in your library.`,
        )
      )
        return;
      const prev = setlists;
      setSetlists((cur) => cur.filter((x) => x.id !== s.id));
      try {
        const res = await fetch(`/api/setlists/${s.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("delete failed");
      } catch {
        setSetlists(prev);
      }
    },
    [setlists],
  );

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6 flex items-end justify-between gap-3">
        <div>
          <Link
            href="/charts"
            className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer hover:text-cream"
          >
            ← Charts
          </Link>
          <h1 className="mt-1 font-display text-2xl text-cream">Setlists</h1>
          <p className="mt-1 text-sm text-cream-dim">
            Curated, ordered collections drawn from your chart library.
          </p>
        </div>
        {!creating && (
          <button
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
            disabled={!online}
            title={!online ? "Connect to create setlists" : undefined}
            className="shrink-0 border border-cat-practice/60 bg-cat-practice/10 px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + New
          </button>
        )}
      </header>

      {creating && (
        <section className="mb-6 border border-cat-practice/40 bg-ink-raised/30 p-4">
          <label className="block">
            <span className="mb-1 block font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
              Setlist name
            </span>
            <input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
                if (e.key === "Escape") {
                  setCreating(false);
                  setName("");
                }
              }}
              placeholder="Friday night @ The Mill"
              className="w-full border border-rule/60 bg-ink px-3 py-2 text-sm text-cream outline-none focus:border-cat-practice/60"
            />
          </label>
          {error && <p className="mt-2 text-sm text-cat-music">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={create}
              disabled={busy}
              className="border border-cat-practice/60 bg-cat-practice/10 px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create"}
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setName("");
                setError(null);
              }}
              disabled={busy}
              className="border border-rule/60 px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:text-cream disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {!creating && error && (
        <p className="mb-4 text-sm text-cat-music">{error}</p>
      )}

      {setlists.length === 0 && !creating ? (
        <p className="mt-8 text-sm text-cream-dim">
          No setlists yet. Tap{" "}
          <span className="font-mono text-cream">+ New</span> to build one from
          your library.
        </p>
      ) : (
        <ol className="list-none space-y-2">
          {setlists.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-2 border border-rule/60 bg-ink-raised/40 px-3 py-2.5"
            >
              <Link href={`/charts/setlists/${s.id}`} className="min-w-0 flex-1">
                <span className="block truncate text-[0.95rem] text-cream hover:text-cat-practice">
                  {s.name}
                </span>
                <span className="block truncate font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
                  {s.chartCount} chart{s.chartCount === 1 ? "" : "s"}
                  {s.offline ? " · offline" : ""}
                </span>
              </Link>
              <button
                aria-label={`Delete ${s.name}`}
                onClick={() => remove(s)}
                disabled={!online}
                className="flex h-7 w-7 shrink-0 items-center justify-center border border-rule/50 font-mono text-xs text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-30"
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
