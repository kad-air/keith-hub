"use client";

import Link from "next/link";
import { useState } from "react";
import { gameSlug, tvLabel } from "@/lib/hoops/scores/parse";
import { periodLabels, statusLabel } from "@/lib/hoops/scores/format";
import { behindLabel, protectedStatus } from "@/lib/hoops/scores/spoiler";
import { useLiveGame, useSpoiler } from "./LiveProvider";
import SpoilerPanel from "./SpoilerPanel";
import { HoldBar, useLongPress } from "./useLongPress";
import type { Game, LiveGame, TeamLine } from "@/lib/hoops/scores/types";

/**
 * One game, plaintextsports-dense: a status line (tip time in Mountain, the
 * live clock, or Final) with the network on the right, then a row per team —
 * tri, record, points by quarter (overtimes appended), total. Away on top,
 * the US convention. The whole card links to the box score.
 *
 * Renders the server's Game until a LiveProvider tick carries a fresher copy
 * (clock, totals, state — see lib/hoops/scores/live.ts); a live game also
 * prints its last play. Without a provider it is just the server's card.
 *
 * Spoiler mode (`protect`, today's page — lib/hoops/scores/spoiler.ts): a
 * started game is VEILED until the viewer says otherwise — teams, clock and
 * quarter only, no scores, quarters, records or last play. Hold the card
 * (the feed's Clear-Above gesture, same bar) to reveal it; tap it and the
 * options unfold INSIDE the card (SpoilerPanel) — hold-to-reveal again, or
 * "I'm at <quarter> <time>", after which the card shows the score as of that
 * moment and follows the play-by-play from there (`synced`). A synced card's
 * tap unfolds the same panel (which links the game page's box score and
 * play-by-play, both held to the same moment). Inside the card, not a sheet: at the bottom of a long list
 * the controls are found where the game is.
 */
export default function GameCard({
  game: initial,
  date,
  protect = false,
}: {
  game: Game;
  date: string;
  protect?: boolean;
}) {
  const live = useLiveGame(initial.id);
  const sp = useSpoiler();
  const [open, setOpen] = useState(false);

  const entry = protect ? sp.spoiler[initial.id] : undefined;
  const guarded = protect && initial.state !== "pre";
  // A synced view that has reached the final is the whole game — open it
  // (the provider promotes the entry to revealed on the same tick).
  const mode: "open" | "synced" | "veiled" = !guarded
    ? "open"
    : entry?.mode === "synced"
      ? live?.moment
        ? live.moment.final
          ? "open"
          : "synced"
        : "veiled"
      : entry?.mode === "revealed" && live && !live.veiled && (!live.moment || live.moment.final)
        ? "open"
        : "veiled";

  const game = live?.game ?? initial;
  const hold = useLongPress(() => sp.reveal(initial.id), mode === "veiled");

  if (mode === "open") {
    return (
      <Link
        href={`/hoops/scores/${date}/${gameSlug(game)}`}
        className="block border border-rule/60 px-3 py-2 transition-colors hover:border-cat-hoops/40 hover:bg-ink-raised/60"
      >
        <CardBody game={game} live={live} />
      </Link>
    );
  }

  const offsetMs = entry?.mode === "synced" ? entry.offsetMs : 0;
  return (
    <div
      className={`relative border px-3 py-2 transition-colors ${open ? "border-cat-hoops/60" : "border-rule/60 hover:border-cat-hoops/40"}`}
      style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
    >
      {mode === "veiled" && <HoldBar holding={hold.holding} />}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${game.away.tri} at ${game.home.tri}: ${mode === "veiled" ? "score hidden — hold to reveal, tap for options" : "synced view — tap for options"}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        {...hold.handlers}
        style={{ touchAction: "pan-y" }}
        className="cursor-pointer text-left focus:outline-none focus-visible:text-cream"
      >
        {mode === "veiled" ? (
          <VeiledBody game={game} hint={open ? "hold to reveal · tap to fold" : "hold to reveal · tap for options"} />
        ) : (
          <CardBody game={game} live={live} kicker={`synced · ${behindLabel(offsetMs)}`} />
        )}
      </div>
      {open && (
        <SpoilerPanel game={game} date={date} mode={mode} offsetMs={offsetMs} onDone={() => setOpen(false)} />
      )}
    </div>
  );
}

/** The ordinary card: status + network, then both rows with quarters. */
function CardBody({ game, live, kicker }: { game: Game; live: LiveGame | null; kicker?: string }) {
  const n = Math.max(game.away.linescore.length, game.home.linescore.length);
  const started = game.state !== "pre" && n > 0;
  const labels = started ? periodLabels(n) : [];
  const inProgress = game.state === "in";

  const row = (t: TeamLine) => {
    const won = game.state === "post" && t.winner;
    return (
      <tr className={won ? "text-cream" : "text-cream-dim"}>
        <td className="py-0.5 pr-2 text-left">
          <span className={won ? "font-semibold text-cream" : ""}>{t.tri}</span>
          <span className="ml-1.5 font-display text-[0.8rem] text-cream-dimmer max-sm:hidden">
            {t.nickname}
          </span>
        </td>
        <td className="pr-2 text-left text-[0.62rem] text-cream-dimmer">{t.record ?? ""}</td>
        {labels.map((_, i) => (
          <td key={i} className="w-7 text-right text-[0.66rem] text-cream-dimmer max-xs:hidden">
            {t.linescore[i] ?? ""}
          </td>
        ))}
        <td className={`w-10 text-right ${won ? "font-semibold" : ""}`}>{t.score ?? ""}</td>
      </tr>
    );
  };

  return (
    <>
      <div className="flex items-baseline justify-between gap-2 font-mono text-[0.62rem] uppercase tracking-kicker">
        <span className={inProgress ? "text-cat-hoops" : "text-cream-dimmer"}>
          {inProgress && <span aria-hidden>● </span>}
          {statusLabel(game)}
          {kicker && <span className="text-cream-dimmer"> · {kicker}</span>}
        </span>
        <span className="min-w-0 text-right text-cream-dimmer">{tvLabel(game.tv)}</span>
      </div>
      {/* The play's text only: its clock is the clock in the status line
          above (the status and the last play come off the same read), and
          printing it twice read as two clocks. */}
      {inProgress && live?.lastPlay && (
        <p className="mt-0.5 line-clamp-2 font-mono text-[0.6rem] text-cream-dim">{live.lastPlay.text}</p>
      )}
      {(game.note || game.series) && (
        <p className="mt-0.5 font-mono text-[0.6rem] text-cream-dimmer">
          {[game.note, game.series].filter(Boolean).join(" · ")}
        </p>
      )}
      <table className="mt-1 w-full font-mono text-[0.78rem] tabular-nums">
        {started && (
          <thead>
            <tr className="text-[0.56rem] uppercase text-cream-dimmer">
              <th className="text-left font-normal" />
              <th className="font-normal" />
              {labels.map((l) => (
                <th key={l} className="w-7 text-right font-normal max-xs:hidden">
                  {l}
                </th>
              ))}
              <th className="w-10 text-right font-normal">T</th>
            </tr>
          </thead>
        )}
        <tbody>
          {row(game.away)}
          {row(game.home)}
        </tbody>
      </table>
    </>
  );
}

/** The veiled card: the clock and quarter, the two teams, and how to see
 *  more. Nothing that could spoil — no score, quarters, record or play. */
function VeiledBody({ game, hint }: { game: Game; hint: string }) {
  const inProgress = game.state === "in";
  return (
    <>
      <div className="flex items-baseline justify-between gap-2 font-mono text-[0.62rem] uppercase tracking-kicker">
        <span className={inProgress ? "text-cat-hoops" : "text-cream-dimmer"}>
          {inProgress && <span aria-hidden>● </span>}
          {protectedStatus(game)}
        </span>
        <span className="min-w-0 text-right text-cream-dimmer">{tvLabel(game.tv)}</span>
      </div>
      {game.note && <p className="mt-0.5 font-mono text-[0.6rem] text-cream-dimmer">{game.note}</p>}
      <table className="mt-1 w-full font-mono text-[0.78rem] tabular-nums">
        <tbody>
          {[game.away, game.home].map((t) => (
            <tr key={t.tri} className="text-cream-dim">
              <td className="py-0.5 pr-2 text-left">
                {t.tri}
                <span className="ml-1.5 font-display text-[0.8rem] text-cream-dimmer max-sm:hidden">{t.nickname}</span>
              </td>
              <td className="w-10 text-right text-cream-dimmer" aria-hidden>
                ··
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
        Score hidden · {hint}
      </p>
    </>
  );
}
