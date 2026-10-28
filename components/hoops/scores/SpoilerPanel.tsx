"use client";

import Link from "next/link";
import { useState } from "react";
import { gameSlug } from "@/lib/hoops/scores/parse";
import { behindLabel, clockLabel, periodChoices, periodLengthSec, typedClockSeconds } from "@/lib/hoops/scores/spoiler";
import { useSpoiler } from "./LiveProvider";
import { HoldBar, useLongPress } from "./useLongPress";
import type { Game } from "@/lib/hoops/scores/types";

/**
 * The options for a veiled or synced game, INSIDE the card (a tap unfolds it
 * under the teams): hold to reveal the score, or say where you are
 * ("3rd · 7:32") and watch from there. For a synced game the same form moves
 * the moment, and the game page's box score and play-by-play are offered —
 * both held to the same moment (GamePage). Part of the card rather than a sheet so
 * it is found where the game is, not somewhere else on the screen.
 */
export default function SpoilerPanel({
  game,
  date,
  mode,
  offsetMs,
  onDone,
}: {
  game: Game;
  date: string;
  mode: "veiled" | "synced";
  offsetMs: number;
  onDone: () => void;
}) {
  const sp = useSpoiler();
  const [period, setPeriod] = useState(Math.max(1, Math.min(game.period || 1, 4)));
  const [clock, setClock] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ahead, setAhead] = useState(false);
  // Digits read as m:ss ("732" → 7:32); the reading shows beside the field.
  const typed = typedClockSeconds(clock);
  const hold = useLongPress(() => {
    sp.reveal(game.id);
    onDone();
  });

  const submit = async () => {
    if (typed === null) {
      setNote("Type the clock's digits, like 732 for 7:32, or 24.7 under a minute.");
      return;
    }
    if (typed > periodLengthSec(period)) {
      setNote(`A ${period > 4 ? "overtime" : "quarter"} starts at ${clockLabel(periodLengthSec(period))}.`);
      return;
    }
    setBusy(true);
    setNote(null);
    setAhead(false);
    try {
      const r = await sp.resolve(game.id, period, typed);
      if (r.ok) {
        sp.syncTo(game.id, r.offsetMs);
        onDone();
      } else if (r.reason === "ahead") {
        setAhead(true);
        setNote("The live game hasn't reached that point yet.");
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
    "border border-rule px-2.5 py-1.5 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-hoops hover:text-cream disabled:opacity-50";
  const field =
    "min-w-0 border border-rule/60 bg-ink-raised px-2 py-1.5 font-mono text-[0.78rem] text-cream focus:border-cat-hoops focus:outline-none";

  return (
    // Stop every pointer event here: the card above holds-to-reveal on its own
    // surface, and a press inside the clock field must not start that hold.
    <div
      className="mt-2 border-t border-rule/60 pt-2"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {mode === "synced" && (
        <p className="mb-2 font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          synced · {behindLabel(offsetMs)}
        </p>
      )}

      <button
        type="button"
        {...hold.handlers}
        style={{ touchAction: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
        className="relative block w-full border border-cat-hoops/60 px-2.5 py-2 text-left font-mono text-[0.66rem] uppercase tracking-kicker text-cream transition-colors hover:bg-ink-raised/60"
      >
        <HoldBar holding={hold.holding} />
        Hold to reveal the score
      </button>

      <form
        className="mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">
          {mode === "synced" ? "Or move to where you are" : "Or I'm at…"}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <select
            value={period}
            onChange={(e) => setPeriod(Number(e.target.value))}
            className={field}
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
            placeholder="732"
            aria-label="Time remaining"
            className={`${field} w-[4.5rem] tabular-nums placeholder:text-cream-dimmer`}
          />
          {clock.trim() !== "" && (
            <span aria-live="polite" className="font-mono text-[0.72rem] tabular-nums text-cream-dim">
              {typed === null ? "?" : `= ${clockLabel(typed)}`}
            </span>
          )}
          <button type="submit" disabled={busy} className={btn}>
            {busy ? "…" : mode === "synced" ? "Move" : "Sync"}
          </button>
        </div>
        <p className="mt-1.5 font-mono text-[0.58rem] text-cream-dimmer">
          Shows the score as of that moment and follows the play-by-play from there — a few seconds behind
          you, never ahead.
        </p>
        {note && <p className="mt-1.5 font-mono text-[0.64rem] text-cat-hoops">{note}</p>}
        {ahead && (
          <button
            type="button"
            className={`${btn} mt-1.5`}
            onClick={() => {
              sp.reveal(game.id);
              onDone();
            }}
          >
            Show the live score
          </button>
        )}
      </form>

      {mode === "synced" && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule/40 pt-2 font-mono text-[0.6rem] uppercase tracking-kicker">
          <button
            type="button"
            className={btn}
            onClick={() => {
              sp.unsync(game.id);
              onDone();
            }}
          >
            Hide again
          </button>
          {/* Both hold to the synced moment (GamePage) — neither spoils. */}
          <Link href={`/hoops/scores/${date}/${gameSlug(game)}`} className="text-cream-dimmer hover:text-cream">
            Box score ›
          </Link>
          <Link href={`/hoops/scores/${date}/${gameSlug(game)}/plays`} className="text-cream-dimmer hover:text-cream">
            Play-by-play ›
          </Link>
        </div>
      )}
    </div>
  );
}
