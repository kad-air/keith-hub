import HoopsNav from "@/components/hoops/HoopsNav";
import GameCard from "./GameCard";
import LiveProvider from "./LiveProvider";
import NotableList from "./NotableList";
import ScoresDayNav from "./ScoresDayNav";
import { SourceNote } from "./SourceNote";
import { getNotable, getScoreboard, sourceMeta, type Fetched } from "@/lib/hoops/scores/data";
import { addDays, longDate, shortDate, todayIn } from "@/lib/hoops/scores/dates";
import type { GameState, Scoreboard } from "@/lib/hoops/scores/types";

function Games({
  title,
  sb,
}: {
  title: string;
  sb: Fetched<Scoreboard>;
}) {
  const games = sb.data?.games ?? [];
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="mb-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">
        {title}
        {games.length > 0 && <span className="text-cream-dimmer"> · {games.length}</span>}
      </h3>
      {!sb.data ? (
        <p className="font-display text-sm text-cream-dim">Scores unavailable right now.</p>
      ) : games.length === 0 ? (
        <p className="font-display text-sm text-cream-dim">No NBA games.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {games.map((g) => (
            <GameCard key={g.id} game={g} date={sb.data!.date} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One day of real NBA games. On TODAY it is the morning read: last night's
 * finals first, then tonight's slate (tip times in Mountain, the network, the
 * live score once a game starts), then last night's notable lines. Any other
 * day is just that day's games and its notable lines.
 *
 * Separate from the sim on purpose: nothing here reads the hoops-sim bundle,
 * the read model or the engine.
 */
export default async function ScoresDay({ date }: { date: string }) {
  const today = todayIn(new Date());
  const isToday = date === today;
  const yesterday = addDays(date, -1);

  const [day, prior] = await Promise.all([
    getScoreboard(date),
    isToday ? getScoreboard(yesterday) : Promise.resolve(null),
  ]);

  // Today's notable is last night's: tonight's lines aren't finished yet
  // (any that are get folded in too).
  const notableDays = [prior, day].filter((s): s is Fetched<Scoreboard> => !!s?.data);
  const notable = await Promise.all(notableDays.map((s) => getNotable(s.data!)));
  const lines = notable.flatMap((n) => n.lines).sort((a, b) => b.score - a.score);
  const missing = notable.reduce((s, n) => s + n.missing, 0);

  const all = [...(prior?.data?.games ?? []), ...(day.data?.games ?? [])];
  const live = all.some((g) => g.state === "in");
  const pending = isToday && (day.data?.games ?? []).some((g) => g.state !== "post" && !g.postponed);
  // The states this render saw — the provider refreshes the page when one
  // flips (a tip, a final) so the slow-path fields catch up.
  const states: Record<string, GameState> = {};
  for (const g of all) states[g.id] = g.state;

  const body = (
    <>
      {isToday && prior && <Games title={`Last night · ${shortDate(yesterday)}`} sb={prior} />}
      <Games title={isToday ? "Tonight" : "Games"} sb={day} />

      {(lines.length > 0 || all.some((g) => g.state === "post")) && (
        <NotableList
          lines={lines}
          missing={missing}
          title={isToday ? "Notable · last night & today" : "Notable"}
        />
      )}

      <SourceNote fetched={[day, ...(prior ? [prior] : [])].map(sourceMeta)} />
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
      {live || pending ? (
        <LiveProvider dates={isToday && prior ? [date, yesterday] : [date]} states={states}>
          {body}
        </LiveProvider>
      ) : (
        body
      )}
    </article>
  );
}
