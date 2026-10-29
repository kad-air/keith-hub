"use client";

import Link from "next/link";
import { tipTime, shortDate } from "@/lib/hoops/scores/dates";
import { gameSlug, tvLabel } from "@/lib/hoops/scores/parse";
import { gameDate } from "@/lib/hoops/scores/teams";
import { useLiveGame, useSpoiler } from "./LiveProvider";
import type { Game } from "@/lib/hoops/scores/types";

/**
 * One game on a team's schedule, from that team's side: the date, vs / @ the
 * opponent (a link to the opponent's team page), and the result (a link to
 * the game page) — or, before tip, the tip time in Mountain and the network.
 *
 * 🔴 Spoiler mode: `guarded` games arrive from the server already veiled
 * (lib/hoops/scores/guard.ts). Under a LiveProvider the live tick carries the
 * viewer's own choice for the game, as on the scores list: revealed → the
 * score; synced → the score as of the viewer's moment, marked; otherwise the
 * row keeps saying the score is hidden and links to the game page, where the
 * reveal and sync controls live. Nothing here reveals anything by itself.
 */
export default function TeamGameRow({
  game: initial,
  tri,
  guarded = false,
  dateFirst = true,
}: {
  game: Game;
  /** The team whose schedule this is. */
  tri: string;
  guarded?: boolean;
  /** Print the date at the start of the row (the schedule); off where a
   *  heading already says it. */
  dateFirst?: boolean;
}) {
  const live = useLiveGame(initial.id);
  const sp = useSpoiler();
  const entry = sp.spoiler[initial.id];

  // What this row may print: the server's copy, or the live tick's when it
  // is the viewer's own open (or synced) view of a guarded game.
  let game = initial;
  let view: "open" | "veiled" | "synced" = guarded ? "veiled" : "open";
  if (live && !live.veiled) {
    if (!guarded || entry?.mode === "revealed" || entry?.mode === "synced") {
      game = live.game;
      view = live.moment && !live.moment.final ? "synced" : "open";
    }
  } else if (live && !guarded) {
    game = live.game;
  }

  const date = gameDate(initial.startUtc);
  const home = game.home.tri === tri;
  const us = home ? game.home : game.away;
  const them = home ? game.away : game.home;
  const href = `/hoops/scores/${date}/${gameSlug(game)}`;

  let result: React.ReactNode;
  if (game.postponed) {
    result = <span className="text-cream-dimmer">{game.statusDetail || "Postponed"}</span>;
  } else if (game.state === "pre") {
    result = (
      <span className="text-cream-dim">
        {tipTime(game.startUtc)}
        {/* The network gives way first on a folding phone's cover screen. */}
        <span className="text-cream-dimmer max-xs:hidden"> · {tvLabel(game.tv)}</span>
      </span>
    );
  } else if (view === "veiled") {
    result = (
      <span className="text-cream-dimmer">
        {game.state === "in" ? "Live" : "Final"} · score hidden
      </span>
    );
  } else {
    const won = game.state === "post" && us.score !== null && them.score !== null ? us.score > them.score : null;
    result = (
      <span className="text-cream">
        {won !== null && <span className={won ? "text-cat-hoops" : "text-cream-dim"}>{won ? "W" : "L"} </span>}
        {us.score ?? "–"}-{them.score ?? "–"}
        {game.state === "in" && <span className="text-cream-dimmer"> · {game.statusDetail}</span>}
        {view === "synced" && <span className="text-cream-dimmer"> · synced</span>}
      </span>
    );
  }

  return (
    <li className="flex items-baseline justify-between gap-3 border-b border-rule/40 py-1.5 font-mono text-[0.72rem] tabular-nums">
      <span className="flex min-w-0 items-baseline gap-2">
        {dateFirst && <span className="w-[3.4rem] shrink-0 text-cream-dimmer">{shortDate(date)}</span>}
        <span className="w-4 shrink-0 text-cream-dimmer">{home ? "vs" : "@"}</span>
        <Link href={`/hoops/scores/teams/${them.tri.toLowerCase()}`} className="text-cream hover:text-cat-hoops">
          {them.tri}
        </Link>
        <span className="truncate font-display text-[0.8rem] text-cream-dimmer max-sm:hidden">{them.nickname}</span>
      </span>
      <Link href={href} className="shrink-0 text-right hover:text-cat-hoops" data-kb-item>
        {result}
      </Link>
    </li>
  );
}
