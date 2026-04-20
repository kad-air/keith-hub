"use client";

import { useEffect, useRef, useState } from "react";

type ApiRef = {
  destroy?: () => void;
  tex: (tex: string) => void;
  playPause: () => void;
  playbackSpeed: number;
  isLooping: boolean;
  error: { on: (cb: (e: unknown) => void) => void };
  renderFinished: { on: (cb: () => void) => void };
  playerReady: { on: (cb: () => void) => void };
  playerStateChanged: { on: (cb: (e: { state: number }) => void) => void };
};

export type AlphaTabViewerProps = {
  tex: string;
  className?: string;
};

export function AlphaTabViewer({ tex, className }: AlphaTabViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ApiRef | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [playerReady, setPlayerReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [looping, setLooping] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let api: ApiRef | null = null;

    (async () => {
      try {
        const alphaTab = await import("@coderline/alphatab");
        if (disposed || !mountRef.current) return;

        api = new alphaTab.AlphaTabApi(mountRef.current, {
          core: {
            fontDirectory: "/alphatab/font/",
            engine: "svg",
          },
          display: {
            resources: {
              staffLineColor: "rgb(82, 79, 73)",
              barSeparatorColor: "rgb(170, 162, 144)",
              mainGlyphColor: "rgb(217, 209, 190)",
              secondaryGlyphColor: "rgb(170, 162, 144)",
              scoreInfoColor: "rgb(217, 209, 190)",
              barNumberColor: "rgb(170, 162, 144)",
            },
          },
          player: {
            enablePlayer: true,
            soundFont: "/alphatab/soundfont/sonivox.sf2",
            scrollMode: "off",
          },
        }) as unknown as ApiRef;

        api.error.on((e) => {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error("[AlphaTab]", err);
          if (!disposed) {
            setStatus("error");
            setErrorMsg(err.message);
          }
        });
        api.renderFinished.on(() => {
          if (!disposed) setStatus("ready");
        });
        api.playerReady.on(() => {
          if (!disposed) setPlayerReady(true);
        });
        api.playerStateChanged.on((e) => {
          if (!disposed) setIsPlaying(e.state === 1);
        });

        api.tex(tex);
        apiRef.current = api;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error("[AlphaTab] init failed", err);
        if (!disposed) {
          setStatus("error");
          setErrorMsg(err.message);
        }
      }
    })();

    return () => {
      disposed = true;
      try {
        apiRef.current?.destroy?.();
      } catch {
        /* noop */
      }
      apiRef.current = null;
    };
  }, [tex]);

  useEffect(() => {
    if (!apiRef.current) return;
    apiRef.current.playbackSpeed = speed;
  }, [speed]);

  useEffect(() => {
    if (!apiRef.current) return;
    apiRef.current.isLooping = looping;
  }, [looping]);

  const togglePlay = () => {
    if (!apiRef.current || !playerReady) return;
    apiRef.current.playPause();
  };

  return (
    <div
      ref={containerRef}
      className={[
        "rounded-lg border border-rule/60 bg-ink-raised/30",
        className ?? "",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule/60 px-3 py-2">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!playerReady || status !== "ready"}
          aria-pressed={isPlaying}
          className="rounded-sm border border-rule/60 bg-ink-raised/40 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-practice/60 hover:text-cream disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPlaying ? "❚❚ Pause" : "▶ Play"}
        </button>
        <label className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-kicker text-cream-dimmer">
          <span>Speed</span>
          <input
            type="range"
            min={0.25}
            max={1}
            step={0.05}
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            className="w-24 accent-cat-practice"
            aria-label="Playback speed"
          />
          <span className="w-10 text-right text-cream-dim">
            {Math.round(speed * 100)}%
          </span>
        </label>
        <button
          type="button"
          onClick={() => setLooping((l) => !l)}
          aria-pressed={looping}
          className={[
            "rounded-sm border px-2 py-1 font-mono text-[0.65rem] uppercase tracking-kicker transition-colors",
            looping
              ? "border-cat-practice bg-cat-practice/15 text-cream"
              : "border-rule/60 text-cream-dim hover:border-cat-practice/60",
          ].join(" ")}
        >
          Loop
        </button>
        <span className="ml-auto font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          AlphaTab
        </span>
      </div>
      <div className="relative overflow-x-auto px-2 py-3">
        <div ref={mountRef} className="min-h-[140px]" />
        {status === "loading" && (
          <p className="px-2 py-6 text-center font-mono text-[0.7rem] text-cream-dimmer">
            Rendering tab…
          </p>
        )}
        {status === "error" && (
          <p className="px-2 py-6 font-mono text-[0.7rem] text-accent">
            Tab render failed{errorMsg ? `: ${errorMsg}` : "."}
          </p>
        )}
      </div>
    </div>
  );
}
