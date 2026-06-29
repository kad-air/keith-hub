"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Chart } from "@/lib/charts";
import { ChartForm, type FormState } from "../ChartForm";

const SPEED_MIN = 8;
const SPEED_MAX = 160;
const SPEED_STEP = 2;
const SPEED_DEFAULT = 30; // px/sec

const FONT_MIN = 6;
const FONT_MAX = 30;
const FONT_STEP = 1;
const FONT_DEFAULT = 16;

const SPEED_KEY = "setlist-speed";
const FONT_KEY = "setlist-fontsize";

export default function ChartViewerClient({
  chart: initialChart,
  back,
}: {
  chart: Chart;
  back: { href: string; label: string };
}) {
  // Hold the chart locally so an in-page edit updates the view immediately
  // without a server round-trip / route refresh.
  const [chart, setChart] = useState<Chart>(initialChart);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEED_DEFAULT);
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const [progress, setProgress] = useState(0);

  // Editing — moved here from the library page so a chart is edited from its
  // own page. Saving needs the network, so it's disabled offline.
  const [online, setOnline] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const openEdit = useCallback(() => {
    setPlaying(false);
    setEditError(null);
    setForm({
      mode: "edit",
      id: chart.id,
      title: chart.title,
      artist: chart.artist ?? "",
      content: chart.content,
    });
  }, [chart]);

  const closeEdit = useCallback(() => {
    setForm(null);
    setEditError(null);
  }, []);

  const handleEditFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setForm((f) => {
      if (!f) return f;
      const title = f.title.trim() || file.name.replace(/\.[^.]+$/, "").trim();
      return { ...f, content: text, title };
    });
  }, []);

  const saveEdit = useCallback(async () => {
    if (!form) return;
    if (!form.title.trim() || !form.content.trim()) {
      setEditError("Title and chart text are required.");
      return;
    }
    setBusy(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/charts/${form.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          artist: form.artist,
          content: form.content,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      const { chart: updated } = (await res.json()) as { chart: Chart };
      setChart(updated);
      closeEdit();
    } catch {
      setEditError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }, [form, closeEdit]);

  const speedRef = useRef(speed);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const accRef = useRef(0);
  // Minimal local shape — avoids depending on WakeLock lib.dom types being
  // present, which vary by TS version.
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  // Hydrate persisted prefs (speed + font size) after mount.
  useEffect(() => {
    const s = Number(localStorage.getItem(SPEED_KEY));
    if (s >= SPEED_MIN && s <= SPEED_MAX) setSpeed(s);
    const f = Number(localStorage.getItem(FONT_KEY));
    if (f >= FONT_MIN && f <= FONT_MAX) setFontSize(f);
  }, []);

  useEffect(() => {
    speedRef.current = speed;
    localStorage.setItem(SPEED_KEY, String(speed));
  }, [speed]);

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
  }, [fontSize]);

  const atBottom = useCallback(
    () =>
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 2,
    [],
  );

  // Screen wake lock — best effort. Keeps the phone awake while a chart
  // autoscrolls so it doesn't sleep mid-song. Not supported everywhere.
  const requestWake = useCallback(async () => {
    try {
      const wl = (
        navigator as unknown as {
          wakeLock?: {
            request: (t: "screen") => Promise<{ release: () => Promise<void> }>;
          };
        }
      ).wakeLock;
      if (wl?.request) wakeRef.current = await wl.request("screen");
    } catch {
      /* ignore — wake lock is a nicety, not required */
    }
  }, []);
  const releaseWake = useCallback(() => {
    try {
      void wakeRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeRef.current = null;
  }, []);

  // The autoscroll loop. rAF-driven, dt-based so speed is wall-clock px/sec
  // regardless of frame rate. Sub-pixel travel accumulates so slow speeds
  // still move smoothly. Reading speed from a ref means the slider retunes
  // live without restarting the loop.
  useEffect(() => {
    if (!playing) return;
    if (atBottom()) {
      setPlaying(false);
      return;
    }
    void requestWake();
    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      accRef.current += speedRef.current * dt;
      const whole = Math.floor(accRef.current);
      if (whole >= 1) {
        accRef.current -= whole;
        window.scrollBy(0, whole);
      }
      if (atBottom()) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
      accRef.current = 0;
      releaseWake();
    };
  }, [playing, atBottom, requestWake, releaseWake]);

  // Re-acquire the wake lock when returning to the tab while still playing —
  // the browser drops it automatically on visibility loss.
  useEffect(() => {
    const onVis = () => {
      if (playing && document.visibilityState === "visible") void requestWake();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [playing, requestWake]);

  // Track scroll position for the progress bar.
  useEffect(() => {
    const onScroll = () => {
      const max =
        document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max <= 0 ? 1 : Math.min(1, window.scrollY / max));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toggle = useCallback(() => {
    setPlaying((p) => {
      // Tapping play at the very bottom restarts from the top.
      if (!p && atBottom()) window.scrollTo({ top: 0 });
      return !p;
    });
  }, [atBottom]);

  // While playing, a manual wheel/touch on the page pauses so the user can
  // reposition. Touches on the control bar itself are excluded so the buttons
  // and slider keep working.
  useEffect(() => {
    if (!playing) return;
    const maybePause = (e: Event) => {
      if (controlsRef.current?.contains(e.target as Node)) return;
      setPlaying(false);
    };
    window.addEventListener("wheel", maybePause, { passive: true });
    window.addEventListener("touchstart", maybePause, { passive: true });
    return () => {
      window.removeEventListener("wheel", maybePause);
      window.removeEventListener("touchstart", maybePause);
    };
  }, [playing]);

  // Keyboard: space = play/pause, ↑/↓ = speed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSpeed((s) => Math.min(SPEED_MAX, s + SPEED_STEP));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSpeed((s) => Math.max(SPEED_MIN, s - SPEED_STEP));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <article className="mx-auto max-w-[820px] px-4 pb-40 pt-6 sm:px-6">
      <header className="mb-5">
        <div className="flex items-start justify-between gap-3">
          <Link
            href={back.href}
            className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer hover:text-cream"
          >
            {back.label}
          </Link>
          {!form && (
            <button
              onClick={openEdit}
              disabled={!online}
              title={!online ? "Connect to edit" : undefined}
              className="shrink-0 border border-rule/60 px-3 py-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-40"
            >
              Edit
            </button>
          )}
        </div>
        <h1 className="mt-2 font-display text-2xl text-cream">{chart.title}</h1>
        {chart.artist && (
          <p className="mt-0.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim">
            {chart.artist}
          </p>
        )}
      </header>

      {form ? (
        <ChartForm
          form={form}
          setForm={setForm}
          busy={busy}
          error={editError}
          onSave={saveEdit}
          onCancel={closeEdit}
          onPickFile={() => fileRef.current?.click()}
          fileRef={fileRef}
          onFile={handleEditFile}
        />
      ) : (
        // One element per physical line so long lines wrap instead of scrolling
        // horizontally. The hanging indent (padding-left + negative text-indent)
        // pushes wrapped continuations in by 1.5em so they read as a carry-over
        // of the same line rather than a new chord/lyric line. `break-words`
        // catches any single token too wide for the viewport. Empty lines get a
        // non-breaking space to preserve their height.
        <div
          style={{ fontSize: `${fontSize}px`, lineHeight: 1.55 }}
          className="font-mono text-cream"
        >
          {chart.content.split("\n").map((line, i) => (
            <div
              key={i}
              className="whitespace-pre-wrap break-words"
              style={{ paddingLeft: "1.5em", textIndent: "-1.5em" }}
            >
              {line || " "}
            </div>
          ))}
        </div>
      )}

      {/* Fixed control bar — hidden while editing. */}
      {!form && (
      <div
        ref={controlsRef}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-rule/60 bg-ink/95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div
          className="h-0.5 bg-cat-practice transition-[width] duration-150"
          style={{ width: `${Math.round(progress * 100)}%` }}
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
        <div className="mx-auto flex max-w-[820px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <button
            onClick={toggle}
            aria-label={playing ? "Pause autoscroll" : "Start autoscroll"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-cat-practice/60 bg-cat-practice/15 text-cream transition-colors hover:bg-cat-practice/30"
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>

          <div className="flex min-w-[180px] flex-1 items-center gap-2">
            <span className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
              Speed
            </span>
            <input
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={SPEED_STEP}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              aria-label="Autoscroll speed"
              className="h-1 flex-1 cursor-pointer accent-cat-practice"
            />
            <span className="w-7 text-right font-mono text-[0.7rem] tabular-nums text-cream-dim">
              {speed}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <CtrlBtn
              label="Smaller text"
              onClick={() =>
                setFontSize((f) => Math.max(FONT_MIN, f - FONT_STEP))
              }
            >
              A−
            </CtrlBtn>
            <CtrlBtn
              label="Larger text"
              onClick={() =>
                setFontSize((f) => Math.min(FONT_MAX, f + FONT_STEP))
              }
            >
              A+
            </CtrlBtn>
            <CtrlBtn
              label="Scroll to top"
              onClick={() => {
                setPlaying(false);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              ↑
            </CtrlBtn>
          </div>
        </div>
      </div>
      )}
    </article>
  );
}

function CtrlBtn({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="flex h-8 min-w-8 items-center justify-center px-1.5 font-mono text-xs text-cream-dim transition-colors hover:text-cream"
    >
      {children}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.5v11l9-5.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="3.5" y="2.5" width="3" height="11" />
      <rect x="9.5" y="2.5" width="3" height="11" />
    </svg>
  );
}
