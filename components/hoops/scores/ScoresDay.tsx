import HoopsNav from "@/components/hoops/HoopsNav";
import GamesSection from "./GamesSection";
import LastNight from "./LastNight";
import LiveProvider from "./LiveProvider";
import NotableList from "./NotableList";
import ScoresDayNav from "./ScoresDayNav";
import { SourceNote } from "./SourceNote";
import { getNotable, getScoreboard, sourceMeta, type Fetched } from "@/lib/hoops/scores/data";
import { addDays, isGuardedDate, lastNightUntil, longDate, shortDate, spoilerUntil, todayIn } from "@/lib/hoops/scores/dates";
import { veilGame } from "@/lib/hoops/scores/spoiler";
import type { GameState, Scoreboard } from "@/lib/hoops/scores/types";

/**
 * One day of real NBA games. On TODAY it is the morning read: last night's
 * finals first, then tonight's slate (tip times in Mountain, the network, the
 * live score once a game starts), then last night's notable lines. At noon
 * Mountain last night lets go: its notable lines and live polling stop, and
 * its list keeps only games the viewer is still synced to (LastNight.tsx).
 * Any other day is just that day's games and its notable lines.
 *
 * Spoiler mode doesn't end at midnight: until 3 AM Mountain last night's
 * started games are veiled here (and on their own day's page) exactly as
 * they were when they were tonight's — revealed and synced ones come back on
 * the first live tick, from last night's stored choices — and last night's
 * notable lines wait, since a 40-point line names its game. At 3 AM the
 * scores just show (owner, 2026-10-28).
 *
 * Separate from the sim on purpose: nothing here reads the hoops-sim bundle,
 * the read model or the engine.
 */
export default async function ScoresDay({ date }: { date: string }) {
  const now = new Date();
  const today = todayIn(now);
  const isToday = date === today;
  const yesterday = addDays(date, -1);
  const until = lastNightUntil(date);
  // Last night is still this page's business (before noon). Past noon it is
  // still read — a settled day is cached for good — for the games the viewer
  // may still be synced to, but nothing else of it shows or polls.
  const lastNight = isToday && now.getTime() < until;
  // Spoiler mode: today's games, and last night's until 3 AM — on today's
  // page as "Last night", and on last night's own page if it's opened.
  const guardDay = isGuardedDate(date, now);
  const guardPrior = isToday && isGuardedDate(yesterday, now);
  const guarded = [...(guardDay ? [date] : []), ...(guardPrior ? [yesterday] : [])];

  const [day, prior] = await Promise.all([
    getScoreboard(date),
    isToday ? getScoreboard(yesterday) : Promise.resolve(null),
  ]);

  // Today's notable is last night's. Tonight's finished games are NOT folded
  // in: today's page is spoiler-protected, and a 40-point line names the
  // game it came from. They show up tomorrow, as last night's, from 3 AM.
  const notableLastNight = lastNight && !guardPrior;
  const notableDays = (isToday ? (notableLastNight ? [prior] : []) : guardDay ? [] : [day]).filter((s): s is Fetched<Scoreboard> => !!s?.data);
  const notable = await Promise.all(notableDays.map((s) => getNotable(s.data!)));
  const lines = notable.flatMap((n) => n.lines).sort((a, b) => b.score - a.score);
  const missing = notable.reduce((s, n) => s + n.missing, 0);

  const all = [...(lastNight ? prior?.data?.games ?? [] : []), ...(day.data?.games ?? [])];
  const live = all.some((g) => g.state === "in");
  const pending = isToday && (day.data?.games ?? []).some((g) => g.state !== "post" && !g.postponed);
  // The states this render saw — the provider refreshes the page when one
  // flips (a tip, a final) so the slow-path fields catch up.
  const states: Record<string, GameState> = {};
  for (const g of all) states[g.id] = g.state;

  const body = (
    <>
      {isToday && prior && (
        <LastNight
          title={`Last night · ${shortDate(yesterday)}`}
          date={yesterday}
          // Under guard the veil goes on HERE, on the server: LastNight is a
          // client component, so whatever it is handed is in the payload.
          games={prior.data ? prior.data.games.map((g) => (guardPrior && g.state !== "pre" ? veilGame(g) : g)) : null}
          until={until}
          pastAtRender={!lastNight}
          protect={guardPrior}
          guardUntil={spoilerUntil(date)}
        />
      )}
      <GamesSection
        title={isToday ? "Tonight" : "Games"}
        date={day.data?.date ?? date}
        games={day.data?.games ?? null}
        protect={guardDay}
      />

      {(lines.length > 0 || (isToday ? (notableLastNight ? prior?.data?.games ?? [] : []) : guardDay ? [] : all).some((g) => g.state === "post")) && (
        <NotableList
          lines={lines}
          missing={missing}
          title={isToday ? "Notable · last night" : "Notable"}
        />
      )}

      <SourceNote fetched={[day, ...(prior && lastNight ? [prior] : [])].map(sourceMeta)} />
    </>
  );

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav active="scores" />
      <ScoresDayNav
        date={date}
        today={today}
        prev={addDays(date, -1)}
        next={addDays(date, 1)}
        label={isToday ? `Today · ${longDate(date)}` : longDate(date)}
      />
      {live || pending || guardDay ? (
        <LiveProvider dates={lastNight && prior ? [date, yesterday] : [date]} states={states} guarded={guarded}>
          {body}
        </LiveProvider>
      ) : (
        body
      )}
    </article>
  );
}
