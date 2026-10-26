"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { gameSlug } from "@/lib/hoops/scores/parse";
import { behindLabel, clockSeconds, periodChoices, protectedStatus } from "@/lib/hoops/scores/spoiler";
import { useSpoiler } from "./LiveProvider";
import { HoldBar, useLongPress } from "./useLongPress";
import type { Game } from "@/lib/hoops/scores/types";

/**
 * The options for a veiled or synced game: hold to reveal the score, or say
 * where you are ("3rd · 7:32") and watch from there. For a synced game the
 * same form adjusts the moment, and the live box score is offered with its
 * warning spelled out — it is the one way out of the sheet that can spoil.
 */
export default function SpoilerSheet({
  game,
  date,
  mode,
  offsetMs,
  onClose,
}: {
  game: Game;
  date: string;
  mode: "veiled" | "synced";
  offsetMs: number;
  onClose: () => void;
}) {
  const sp = useSpoiler();
  const [period, setPeriod] = useState(Math.max(1, Math.min(game.period || 1, 4)));
  const [clock, setClock] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ahead, setAhead] = useState(false);
  const hold = useLongPress(() => {
    sp.reveal(game.id);
    onClose();
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    const sec = clockSeconds(clock);
    if (sec === null || sec > 12 * 60) {
      setNote("Enter the clock as it reads on screen, like 7:32 or 24.7.");
      return;
    }
    setBusy(true);
    setNote(null);
    setAhead(false);
    try {
      const r = await sp.resolve(game.id, period, sec);
      if (r.ok) {
        sp.syncTo(game.id, r.offsetMs);
        onClose();
      } else if (r.reason === "ahead") {
        setAhead(true);
        setNote("The live game hasn't reached that point yet — anything shown would be the live score.");
      } else {
        setNote("No play-by-play for this game yet. Try again in a minute.");
      }
    } catch {
      setNote("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const btn =
    "border border-rule px-3 py-2 font-mono text-[0.66rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-hoops hover:text-cream disabled:opacity-50";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Spoiler options"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/80 backdrop-blur-sm animate-fade-in sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[480px] border border-rule bg-ink px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-5 sm:mb-8">
        <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-3">
          <div>
            <p className="font-display text-base text-cream">
              {game.away.name} <span className="text-cream-dimmer">at</span> {game.home.name}
            </p>
            <p className="mt-0.5 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
              {mode === "synced" ? `synced · ${behindLabel(offsetMs)}` : protectedStatus(game)}
            </p>
          </div>
          <button type="button" onClick={onClose} className={btn}>
            <span className="max-sm:hidden">Esc · </span>Close
          </button>
        </div>

        <button
          type="button"
          {...hold.handlers}
          style={{ touchAction: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
          className="relative mt-4 block w-full border border-cat-hoops/60 px-3 py-3 text-left font-mono text-[0.72rem] uppercase tracking-kicker text-cream transition-colors hover:bg-ink-raised/60"
        >
          <HoldBar holding={hold.holding} />
          Hold to reveal the score
          <span className="block font-mono text-[0.58rem] normal-case tracking-normal text-cream-dimmer">
            Press and hold for a second, like clearing the feed.
          </span>
        </button>

        <form
          className="mt-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
            {mode === "synced" ? "Or move to where you are" : "Or tell me where you are"}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <select
              value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
              className="border border-rule/60 bg-ink-raised px-2 py-2 font-mono text-[0.78rem] text-cream focus:border-cat-hoops focus:outline-none"
              aria-label="Quarter"
            >
              {periodChoices(game.period).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              value={clock}
              onChange={(e) => setClock(e.target.value)}
              inputMode="decimal"
              placeholder="7:32"
              aria-label="Time remaining"
              className="w-24 border border-rule/60 bg-ink-raised px-2 py-2 font-mono text-[0.78rem] tabular-nums text-cream placeholder:text-cream-dimmer focus:border-cat-hoops focus:outline-none"
            />
            <button type="submit" disabled={busy} className={btn}>
              {busy ? "…" : mode === "synced" ? "Move" : "Sync"}
            </button>
          </div>
          <p className="mt-2 font-mono text-[0.6rem] text-cream-dimmer">
            The card then shows the score as of that moment and follows the play-by-play from there — a
            few game-seconds behind you, never ahead.
          </p>
          {note && <p className="mt-2 font-mono text-[0.66rem] text-cat-hoops">{note}</p>}
          {ahead && (
            <button
              type="button"
              className={`${btn} mt-2`}
              onClick={() => {
                sp.reveal(game.id);
                onClose();
              }}
            >
              Show the live score
            </button>
          )}
        </form>

        {mode === "synced" && (
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-rule pt-3 font-mono text-[0.62rem] uppercase tracking-kicker">
            <button
              type="button"
              className={btn}
              onClick={() => {
                sp.unsync(game.id);
                onClose();
              }}
            >
              Hide again
            </button>
            <Link href={`/hoops/scores/${date}/${gameSlug(game)}`} className="text-cream-dimmer hover:text-cream">
              Open box score › <span className="normal-case tracking-normal">(live, not synced — will spoil)</span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
