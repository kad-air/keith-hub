"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chart } from "@/lib/charts";
import { parseChart, wrapBlock } from "@/lib/chord-wrap";
import { ChartForm, type FormState } from "../ChartForm";

const SPEED_MIN = 8;
const SPEED_MAX = 160;
const SPEED_STEP = 2;
const SPEED_DEFAULT = 30; // px/sec

const FONT_MIN = 6;
const FONT_MAX = 30;
const FONT_STEP = 1;
const FONT_DEFAULT = 16;

const MIN_COLS = 12; // never wrap tighter than this many characters per row

// Last-used speed (the default for a song that's never had one set) and the
// per-song override, keyed by chart id. Per-song wins so each tune scrolls at
// its own pace next time. Both live in localStorage — writable offline at a
// gig, unlike a DB column.
const SPEED_KEY = "setlist-speed";
const speedKeyFor = (id: string) => `setlist-speed:${id}`;
const FONT_KEY = "setlist-fontsize";

// Stepping into a song from a setlist arms a short, cancellable countdown
// before autoscroll kicks in — long enough to get your hands on the guitar.
const AUTO_START_SECONDS = 5;

export default function ChartViewerClient({
  chart: initialChart,
  back,
  next,
  autoStart = false,
}: {
  chart: Chart;
  back: { href: string; label: string };
  // The following song in the setlist, when opened from one. null at the end
  // of the list or when not opened from a setlist.
  next?: { href: string; title: string } | null;
  // True whenever we're in "setlist mode" — viewing a song with a setlist
  // context (?setlist=) where the song is a member. Arms the auto-start. This
  // is carried forward by the Next shortcut, so every song stepped through in
  // the setlist re-arms, not just the one entered from the setlist page.
  autoStart?: boolean;
}) {
  const router = useRouter();
  // Hold the chart locally so an in-page edit updates the view immediately
  // without a server round-trip / route refresh.
  const [chart, setChart] = useState<Chart>(initialChart);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEED_DEFAULT);
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const [progress, setProgress] = useState(0);
  // Seconds left on the pre-roll countdown, or null when not counting down.
  const [autoStartIn, setAutoStartIn] = useState<number | null>(null);
  const autoStartTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tear down the pre-roll countdown (manual interaction, navigation, edit).
  // Defined up here so the earlier callbacks (openEdit) can depend on it.
  const cancelAutoStart = useCallback(() => {
    if (autoStartTimer.current != null) {
      clearInterval(autoStartTimer.current);
      autoStartTimer.current = null;
    }
    setAutoStartIn(null);
  }, []);

  // Number of monospace columns that fit the current width at the current font
  // size — drives the chord-aligned line wrap. Null until measured on the
  // client; the SSR / pre-measure render falls back to plain char wrapping so
  // the full chart text is always present (offline cache, no-JS).
  const [cols, setCols] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

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
    cancelAutoStart();
    setEditError(null);
    setForm({
      mode: "edit",
      id: chart.id,
      title: chart.title,
      artist: chart.artist ?? "",
      content: chart.content,
    });
  }, [chart, cancelAutoStart]);

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

  // Hydrate persisted prefs (speed + font size) after mount. Speed prefers a
  // per-song value; absent that, the last-used speed; absent that, the default.
  // hydratedRef gates the save effect so this initial load can't be clobbered
  // by the default-valued first render writing back over the stored value.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const perSong = Number(localStorage.getItem(speedKeyFor(chart.id)));
    const last = Number(localStorage.getItem(SPEED_KEY));
    if (perSong >= SPEED_MIN && perSong <= SPEED_MAX) setSpeed(perSong);
    else if (last >= SPEED_MIN && last <= SPEED_MAX) setSpeed(last);
    const f = Number(localStorage.getItem(FONT_KEY));
    if (f >= FONT_MIN && f <= FONT_MAX) setFontSize(f);
    hydratedRef.current = true;
  }, [chart.id]);

  useEffect(() => {
    speedRef.current = speed;
    // Don't persist until the stored value has been loaded (see hydratedRef).
    if (!hydratedRef.current) return;
    // Remember it both as this song's pace and as the global default for the
    // next never-played song.
    localStorage.setItem(SPEED_KEY, String(speed));
    localStorage.setItem(speedKeyFor(chart.id), String(speed));
  }, [speed, chart.id]);

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
  }, [fontSize]);

  // Measure how many monospace characters fit the content width at the current
  // font size. The hidden span renders 20 chars in the same font; dividing its
  // width gives a per-character width that tracks the font automatically.
  const recomputeCols = useCallback(() => {
    const content = contentRef.current;
    const measure = measureRef.current;
    if (!content || !measure) return;
    const charW = measure.getBoundingClientRect().width / 20;
    const avail = content.clientWidth;
    if (charW <= 0 || avail <= 0) return;
    // -1 char of slack absorbs sub-pixel rounding so a row can't overflow.
    const next = Math.max(MIN_COLS, Math.floor(avail / charW) - 1);
    setCols((prev) => (prev === next ? prev : next));
  }, []);

  // Re-measure on mount, on resize (rotation / window), and whenever the font
  // size changes.
  useEffect(() => {
    recomputeCols();
    const el = contentRef.current;
    const ro = new ResizeObserver(recomputeCols);
    if (el) ro.observe(el);
    window.addEventListener("resize", recomputeCols);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recomputeCols);
    };
  }, [recomputeCols]);

  useEffect(() => {
    recomputeCols();
  }, [fontSize, recomputeCols]);

  const blocks = useMemo(() => parseChart(chart.content), [chart.content]);
  const wrapped = useMemo(
    () => (cols == null ? null : blocks.map((b) => wrapBlock(b, cols))),
    [blocks, cols],
  );

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

  // Stepping into a song from its setlist: count down, then start autoscroll.
  // Keyed on chart.id + autoStart so each song in a setlist walkthrough arms a
  // fresh countdown (the page remounts per song, but this stays correct either
  // way).
  useEffect(() => {
    if (!autoStart) return;
    setAutoStartIn(AUTO_START_SECONDS);
    autoStartTimer.current = setInterval(() => {
      setAutoStartIn((n) => {
        if (n == null) return null;
        if (n <= 1) {
          if (autoStartTimer.current != null) {
            clearInterval(autoStartTimer.current);
            autoStartTimer.current = null;
          }
          setPlaying(true);
          return null;
        }
        return n - 1;
      });
    }, 1000);
    return () => {
      if (autoStartTimer.current != null) {
        clearInterval(autoStartTimer.current);
        autoStartTimer.current = null;
      }
    };
  }, [autoStart, chart.id]);

  // Any manual scroll/touch on the page during the countdown means the user
  // wants to take over — cancel the pending auto-start. Touches on the control
  // bar are excluded so the buttons keep working.
  useEffect(() => {
    if (autoStartIn == null) return;
    const onInteract = (e: Event) => {
      if (controlsRef.current?.contains(e.target as Node)) return;
      cancelAutoStart();
    };
    window.addEventListener("wheel", onInteract, { passive: true });
    window.addEventListener("touchstart", onInteract, { passive: true });
    return () => {
      window.removeEventListener("wheel", onInteract);
      window.removeEventListener("touchstart", onInteract);
    };
  }, [autoStartIn, cancelAutoStart]);

  const toggle = useCallback(() => {
    cancelAutoStart();
    setPlaying((p) => {
      // Tapping play at the very bottom restarts from the top.
      if (!p && atBottom()) window.scrollTo({ top: 0 });
      return !p;
    });
  }, [atBottom, cancelAutoStart]);

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
      } else if (e.key === "n" && next) {
        e.preventDefault();
        router.push(next.href);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, next, router]);

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
            <div className="flex shrink-0 items-center gap-2">
              {next && (
                // Quick jump to the next song in the setlist. Keeps the
                // ?setlist= chain so the next song auto-starts in turn.
                <Link
                  href={next.href}
                  aria-label={`Next song: ${next.title}`}
                  title={`Next: ${next.title}`}
                  className="max-w-[9rem] truncate border border-cat-practice/60 bg-cat-practice/10 px-3 py-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream transition-colors hover:bg-cat-practice/20"
                >
                  Next ▸
                </Link>
              )}
              <button
                onClick={openEdit}
                disabled={!online}
                title={!online ? "Connect to edit" : undefined}
                className="border border-rule/60 px-3 py-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-40"
              >
                Edit
              </button>
            </div>
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
        // Chord-aligned line wrapping (see lib/chord-wrap.ts). We measure how
        // many monospace columns fit the current width/font, wrap each lyric
        // line on word boundaries, and slice the chord line at the same columns
        // so chords stay locked over their syllable — never scrolls sideways.
        <div
          ref={contentRef}
          style={{ fontSize: `${fontSize}px`, lineHeight: 1.5 }}
          className="relative font-mono text-cream"
        >
          {/* Hidden ruler: 20 chars in the same font → per-character width. */}
          <span
            ref={measureRef}
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 -z-10 select-none whitespace-pre opacity-0"
          >
            00000000000000000000
          </span>

          {wrapped == null ? (
            // Pre-measure / no-JS / SSR fallback: the raw text, char-wrapped so
            // it never scrolls horizontally. The full chart text is always in
            // the HTML (offline cache); JS reflows it to the aligned wrap on
            // mount.
            <pre className="whitespace-pre-wrap break-all font-mono">
              {chart.content}
            </pre>
          ) : (
            wrapped.map((rows, bi) => (
              <Fragment key={bi}>
                {rows.map((row, ri) => {
                  if (row.blank) {
                    return (
                      <div key={ri} className="whitespace-pre" aria-hidden>
                        {" "}
                      </div>
                    );
                  }
                  return (
                    <div key={ri} className="whitespace-pre">
                      {row.chord != null && (
                        <span className="block leading-tight">{row.chord}</span>
                      )}
                      {(row.text !== "" || row.chord == null) && (
                        <span className="block">{row.text || " "}</span>
                      )}
                    </div>
                  );
                })}
              </Fragment>
            ))
          )}
        </div>
      )}

      {/* Pre-roll countdown — centered, cancellable. Only the pill is
          interactive so it doesn't block reading the chart underneath. */}
      {autoStartIn != null && !form && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center px-4">
          <button
            onClick={cancelAutoStart}
            className="pointer-events-auto rounded-full border border-cat-practice/60 bg-ink/90 px-5 py-3 font-mono text-sm text-cream shadow-lg shadow-black/40 backdrop-blur transition-colors hover:bg-ink"
          >
            Autoscroll in {autoStartIn}s · tap to cancel
          </button>
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
