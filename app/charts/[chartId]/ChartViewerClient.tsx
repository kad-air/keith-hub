"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chart } from "@/lib/charts";
import { parseChart, wrapBlock } from "@/lib/chord-wrap";
import { LyricMatcher, extractLyricWords } from "@/lib/lyric-follow";
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
const MODE_KEY = "setlist-scrollmode";

// Two ways the chart can move: the classic constant-speed autoscroll, and
// Voice follow — the mic listens to the words being SUNG (not played) and the
// chart tracks the singer, highlighting the current line.
type ScrollMode = "auto" | "voice";

// Where the active line sits in the viewport while voice-following: far
// enough down to keep the just-sung context visible, high enough that the
// next lines are readable.
const VOICE_ANCHOR = 0.35;
// SpeechRecognition sessions end on their own (silence, engine hiccups);
// while following we restart after this pause.
const VOICE_RESTART_MS = 300;

// Minimal local SpeechRecognition surface — the API isn't in every TS
// lib.dom, and Safari only exposes the webkit-prefixed constructor.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Stepping into a song from a setlist arms a short, cancellable countdown
// before autoscroll kicks in — long enough to get your hands on the guitar.
const AUTO_START_SECONDS = 5;

export default function ChartViewerClient({
  chart: initialChart,
  back,
  next,
  autoStart = false,
  readOnly,
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
  // True for anonymous public visitors — hides the Edit affordance.
  readOnly: boolean;
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

  // Voice follow state. `mode` picks which engine the play button drives;
  // `listening` is the voice-mode analog of `playing`. activeBlock is the
  // parseChart block index currently highlighted / scrolled to.
  const [mode, setMode] = useState<ScrollMode>("auto");
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const listeningRef = useRef(false);
  const voiceRestartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref indirection: openEdit (defined below, early) and the auto-start
  // countdown need to reach the voice engine, whose callbacks are defined
  // later (they depend on the wake-lock helpers).
  const stopListeningRef = useRef<() => void>(() => {});

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
    stopListeningRef.current();
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
    // Voice follow needs SpeechRecognition; without it the mode stays "auto"
    // and the Voice segment renders disabled.
    const supported = getSpeechRecognitionCtor() != null;
    setVoiceSupported(supported);
    if (supported && localStorage.getItem(MODE_KEY) === "voice")
      setMode("voice");
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

  useEffect(() => {
    if (!hydratedRef.current) return;
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

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

  // Stateful lyric-position tracker for voice follow. Rebuilt when the chart
  // text changes (an edit); position deliberately survives pause/resume.
  const matcher = useMemo(
    () => new LyricMatcher(extractLyricWords(blocks)),
    [blocks],
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

  // ——— Voice follow ———————————————————————————————————————————————————————

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    if (voiceRestartTimer.current != null) {
      clearTimeout(voiceRestartTimer.current);
      voiceRestartTimer.current = null;
    }
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    setListening(false);
    releaseWake();
  }, [releaseWake]);
  stopListeningRef.current = stopListening;

  const startListening = useCallback(() => {
    if (listeningRef.current) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceError("Voice follow isn't supported in this browser.");
      return;
    }
    if (matcher.wordCount === 0) {
      setVoiceError("No lyric lines found in this chart to follow.");
      return;
    }
    setVoiceError(null);

    const attach = (rec: SpeechRecognitionLike) => {
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";
      rec.onresult = (e) => {
        // Full session transcript (final + interim); the matcher only reads
        // the tail, so re-feeding the whole thing every event is fine and
        // keeps this trivially correct across interim revisions.
        let transcript = "";
        for (let i = 0; i < e.results.length; i++) {
          transcript += " " + e.results[i][0].transcript;
        }
        const block = matcher.feed(transcript.trim().split(/\s+/));
        if (block != null) setActiveBlock(block);
      };
      rec.onerror = (e) => {
        const err = e.error ?? "";
        if (err === "not-allowed" || err === "service-not-allowed") {
          stopListening();
          setVoiceError("Mic access was denied — allow it and try again.");
        } else if (err === "audio-capture") {
          stopListening();
          setVoiceError("No microphone found.");
        }
        // no-speech / network / aborted: transient — onend restarts us.
      };
      rec.onend = () => {
        // Engines end sessions on silence; keep the follow alive. A fresh
        // instance per restart sidesteps Safari's InvalidStateError on
        // re-starting a used recognizer.
        if (!listeningRef.current) return;
        voiceRestartTimer.current = setTimeout(() => {
          if (!listeningRef.current) return;
          const next = new Ctor();
          attach(next);
          recRef.current = next;
          try {
            next.start();
          } catch {
            /* retried on the next onend */
          }
        }, VOICE_RESTART_MS);
      };
    };

    const rec = new Ctor();
    attach(rec);
    recRef.current = rec;
    listeningRef.current = true;
    setListening(true);
    try {
      rec.start();
    } catch {
      stopListening();
      setVoiceError("Couldn't start the microphone.");
      return;
    }
    void requestWake();
  }, [matcher, requestWake, stopListening]);

  // Mic off when the component unmounts (navigating to the next song, etc.).
  useEffect(() => () => stopListeningRef.current(), []);

  // Tap a lyric line while in voice mode to reposition the follow there —
  // the manual escape hatch for repeats/jumps the matcher won't do itself.
  const seekToBlock = useCallback(
    (blockIndex: number) => {
      matcher.seekToBlock(blockIndex);
      setActiveBlock(blockIndex);
    },
    [matcher],
  );

  // Follow-scroll: whenever the highlighted line changes, ease it to the
  // anchor point. Smooth per-line steps — voice mode's analog of the rAF loop.
  useEffect(() => {
    if (mode !== "voice" || activeBlock == null) return;
    const el = contentRef.current?.querySelector(
      `[data-block="${activeBlock}"]`,
    );
    if (!el) return;
    const top =
      window.scrollY +
      el.getBoundingClientRect().top -
      window.innerHeight * VOICE_ANCHOR;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [activeBlock, mode]);

  const switchMode = useCallback(
    (m: ScrollMode) => {
      if (m === mode) return;
      cancelAutoStart();
      setPlaying(false);
      stopListeningRef.current();
      setActiveBlock(null);
      setVoiceError(null);
      setMode(m);
    },
    [mode, cancelAutoStart],
  );

  // ——— Timed autoscroll ———————————————————————————————————————————————————

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

  // Re-acquire the wake lock when returning to the tab while still playing
  // (or voice-following) — the browser drops it automatically on visibility
  // loss.
  useEffect(() => {
    const onVis = () => {
      if (
        (playing || listening) &&
        document.visibilityState === "visible"
      )
        void requestWake();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [playing, listening, requestWake]);

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
          startEngineRef.current();
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
    if (mode === "voice") {
      if (listeningRef.current) stopListening();
      else startListening();
      return;
    }
    setPlaying((p) => {
      // Tapping play at the very bottom restarts from the top.
      if (!p && atBottom()) window.scrollTo({ top: 0 });
      return !p;
    });
  }, [atBottom, cancelAutoStart, mode, startListening, stopListening]);

  // What the pre-roll countdown fires: the active mode's engine. Kept in a
  // ref so the countdown effect doesn't have to re-arm when the mode flips.
  const startEngineRef = useRef<() => void>(() => {});
  startEngineRef.current = () => {
    if (mode === "voice") startListening();
    else setPlaying(true);
  };

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
              {!readOnly && (
                <button
                  onClick={openEdit}
                  disabled={!online}
                  title={!online ? "Connect to edit" : undefined}
                  className="border border-rule/60 px-3 py-1 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Edit
                </button>
              )}
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
                  // In voice mode every line is a tap target (reposition the
                  // follow) and the matcher's current line gets the accent
                  // wash. The negative margin + matching padding widens the
                  // highlight without shifting the text a single pixel.
                  const active = mode === "voice" && activeBlock === bi;
                  return (
                    <div
                      key={ri}
                      data-block={bi}
                      onClick={
                        mode === "voice" ? () => seekToBlock(bi) : undefined
                      }
                      className={`-mx-1.5 whitespace-pre rounded-sm px-1.5 transition-colors duration-300 ${
                        active ? "bg-cat-practice/20" : ""
                      } ${mode === "voice" ? "cursor-pointer" : ""}`}
                    >
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
            {mode === "voice" ? "Voice follow" : "Autoscroll"} in {autoStartIn}
            s · tap to cancel
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
            aria-label={
              mode === "voice"
                ? listening
                  ? "Stop voice follow"
                  : "Start voice follow"
                : playing
                  ? "Pause autoscroll"
                  : "Start autoscroll"
            }
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-cat-practice/60 text-cream transition-colors hover:bg-cat-practice/30 ${
              listening ? "bg-cat-practice/40" : "bg-cat-practice/15"
            }`}
          >
            {mode === "voice" ? (
              listening ? (
                <StopIcon />
              ) : (
                <MicIcon />
              )
            ) : playing ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </button>

          {/* Scroll-mode switch: constant-speed vs follow-the-singer. */}
          <div
            role="radiogroup"
            aria-label="Scroll mode"
            className="flex shrink-0 overflow-hidden rounded-full border border-rule/60 font-mono text-[0.6rem] uppercase tracking-kicker"
          >
            <button
              role="radio"
              aria-checked={mode === "auto"}
              onClick={() => switchMode("auto")}
              className={`px-2.5 py-1.5 transition-colors ${
                mode === "auto"
                  ? "bg-cat-practice/25 text-cream"
                  : "text-cream-dimmer hover:text-cream"
              }`}
            >
              Timer
            </button>
            <button
              role="radio"
              aria-checked={mode === "voice"}
              onClick={() => switchMode("voice")}
              disabled={!voiceSupported}
              title={
                !voiceSupported
                  ? "Speech recognition isn't supported in this browser"
                  : undefined
              }
              className={`border-l border-rule/60 px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                mode === "voice"
                  ? "bg-cat-practice/25 text-cream"
                  : "text-cream-dimmer hover:text-cream"
              }`}
            >
              Voice
            </button>
          </div>

          {mode === "auto" ? (
            <div className="flex min-w-[140px] flex-1 items-center gap-2">
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
          ) : (
            <div
              className="flex min-w-[140px] flex-1 items-center gap-2 font-mono text-[0.65rem] text-cream-dim"
              aria-live="polite"
            >
              {listening ? (
                <>
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cat-practice opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-cat-practice" />
                  </span>
                  <span className="truncate">
                    Listening — sing and the chart follows
                  </span>
                </>
              ) : (
                <span className="truncate">
                  {voiceError ?? "Tap the mic, then sing · tap a line to jump"}
                </span>
              )}
            </div>
          )}

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

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="6" y="1.5" width="4" height="8" rx="2" />
      <path
        d="M3.5 7.5a4.5 4.5 0 0 0 9 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <rect x="7.4" y="12" width="1.2" height="2.5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  );
}
