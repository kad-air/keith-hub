import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import HoopsNav from "@/components/hoops/HoopsNav";
import { SourceNote } from "@/components/hoops/scores/SourceNote";
import { getPlayer } from "@/lib/hoops/queries";
import { getAthlete, getGamelog, getScoreboard, sourceMeta } from "@/lib/hoops/scores/data";
import { shortDate, todayIn } from "@/lib/hoops/scores/dates";
import { averages, guardLog, type Averages, type ShownLine } from "@/lib/hoops/scores/guard";
import type { SeasonKind } from "@/lib/hoops/scores/types";

export const dynamic = "force-dynamic";

const ID = /^\d{1,12}$/;

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  if (!ID.test(params.id)) return { title: "Hoops · Player — hub" };
  const bio = await getAthlete(params.id);
  return { title: bio.data ? `${bio.data.name} — Hoops` : "Hoops · Player — hub" };
}

const KIND_LABEL: Record<SeasonKind, string> = {
  preseason: "Preseason",
  regular: "Regular season",
  postseason: "Playoffs",
  other: "Other",
};
const KIND_ORDER: SeasonKind[] = ["postseason", "regular", "preseason", "other"];
const HEAD = ["MIN", "PTS", "REB", "AST", "STL", "BLK", "TO", "FG", "3P", "FT"];

/** Does the sim carry this player? Its ids are ESPN athlete ids. A missing
 *  or unreadable bundle just drops the link. */
function inSim(id: string): boolean {
  try {
    return getPlayer(Number(id)) !== null;
  } catch {
    return false;
  }
}

/**
 * One real player: who they are, their per-game averages and game log, each
 * game linking to its box score and each opponent to its team page. Off the
 * same upstream as the scores pages; the sim's rating is one link away
 * when the sim carries them.
 *
 * 🔴 Spoiler mode (lib/hoops/scores/guard.ts): a game-log line from a
 * guarded date (today, and last night until 3 AM Mountain) ships as a bare
 * row — date and opponent, no result, no stats — and the averages are taken
 * over the shown lines only, never off the source's own season summary. The
 * hidden row links to the game page, where the reveal and sync controls are.
 * (The server can't see a reveal made on this device, so a revealed game's
 * line stays hidden here until the window ends.)
 */
export default async function HoopsScoresPlayerPage({ params }: { params: { id: string } }) {
  if (!ID.test(params.id)) notFound();
  const now = new Date();
  const today = todayIn(now);
  const bioF = await getAthlete(params.id);
  if (!bioF.data && !bioF.error) notFound();
  const bio = bioF.data;

  // A game today for their team → the log turns over faster.
  const sb = bio?.team ? await getScoreboard(today, now) : null;
  const busyToday = !!sb?.data?.games.some((g) => g.home.tri === bio!.team!.tri || g.away.tri === bio!.team!.tri);
  const logF = await getGamelog(params.id, busyToday);
  const shown = logF.data ? guardLog(logF.data.games, now) : [];
  const hidden = shown.filter((s) => s.hidden).length;

  const kinds = KIND_ORDER.filter((k) => shown.some((s) => s.line.seasonKind === k));
  const headKind = kinds.find((k) => averages(shown, k)) ?? null;
  const avg = headKind ? averages(shown, headKind) : null;

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <HoopsNav area="scores" active="teams" />
      <p className="mb-3 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
        {bio?.team ? (
          <Link href={`/hoops/scores/teams/${bio.team.tri.toLowerCase()}`} className="text-cat-hoops hover:text-cream">
            ‹ {bio.team.name}
          </Link>
        ) : (
          <Link href="/hoops/scores/teams" className="text-cat-hoops hover:text-cream">
            ‹ Teams
          </Link>
        )}
      </p>

      {!bio ? (
        <p className="font-display text-sm text-cream-dim">Player unavailable right now.</p>
      ) : (
        <header>
          <h2 className="font-display text-lg text-cream">
            {bio.jersey && <span className="font-mono text-[0.72rem] text-cat-hoops">#{bio.jersey} </span>}
            {bio.name}
          </h2>
          <p className="mt-0.5 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
            {[bio.posName ?? bio.pos, bio.team?.name ?? (bio.active ? "Free agent" : "Inactive")].filter(Boolean).join(" · ")}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.68rem] sm:grid-cols-3">
            {(
              [
                ["Height", bio.height],
                ["Weight", bio.weight],
                ["Age", bio.age === null ? null : String(bio.age)],
                ["Experience", bio.experience],
                ["Draft", bio.draft],
                ["From", bio.birthPlace],
              ] as const
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[0.56rem] uppercase tracking-kicker text-cream-dimmer">{k}</dt>
                  <dd className="truncate text-cream-dim">{v}</dd>
                </div>
              ))}
          </dl>
          {inSim(bio.id) && (
            <p className="mt-3 font-mono text-[0.62rem] uppercase tracking-kicker">
              <Link href={`/hoops/sim/players/${bio.id}`} className="text-cat-hoops hover:text-cream">
                In the sim →
              </Link>
            </p>
          )}
        </header>
      )}

      {avg && headKind && <AveragesLine kind={headKind} avg={avg} />}
      {hidden > 0 && (
        <p className="mt-1 font-mono text-[0.62rem] text-cream-dimmer">
          {hidden === 1 ? "One game is" : `${hidden} games are`} hidden under spoiler protection until 3 AM and left out
          of the averages.
        </p>
      )}

      {!logF.data ? (
        <p className="mt-6 font-display text-sm text-cream-dim">Game log unavailable right now.</p>
      ) : shown.length === 0 ? (
        <p className="mt-6 font-display text-sm text-cream-dim">No games yet this season.</p>
      ) : (
        kinds.map((k) => <LogTable key={k} kind={k} lines={shown.filter((s) => s.line.seasonKind === k)} />)
      )}

      <SourceNote fetched={[bioF, logF].map(sourceMeta)} />
    </article>
  );
}

const one = (n: number) => n.toFixed(1);
const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);

function AveragesLine({ kind, avg }: { kind: SeasonKind; avg: Averages }) {
  const cells: [string, string][] = [
    ["PTS", one(avg.pts)],
    ["REB", one(avg.reb)],
    ["AST", one(avg.ast)],
    ["MIN", one(avg.min)],
    ["FG%", pct(avg.fgPct)],
    ["3P%", pct(avg.tpPct)],
    ["FT%", pct(avg.ftPct)],
  ];
  return (
    <section className="mt-6">
      <h3 className="mb-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">
        Per game · {KIND_LABEL[kind]} · {avg.gp} {avg.gp === 1 ? "game" : "games"}
      </h3>
      <div className="grid grid-cols-3 gap-2 xs:grid-cols-4 sm:grid-cols-7">
        {cells.map(([k, v]) => (
          <div key={k} className="border border-rule/40 px-2 py-1.5 font-mono tabular-nums">
            <p className="text-[0.56rem] uppercase tracking-kicker text-cream-dimmer">{k}</p>
            <p className="text-sm text-cream">{v}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function LogTable({ kind, lines }: { kind: SeasonKind; lines: ShownLine[] }) {
  return (
    <section className="mt-8">
      <h3 className="mb-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cat-hoops">
        Game log · {KIND_LABEL[kind]}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap font-mono text-[0.72rem] tabular-nums">
          <thead>
            <tr className="border-b border-rule/60 text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
              <th className="sticky left-0 bg-ink pb-1 pr-2 text-left font-normal">Date</th>
              <th className="px-1.5 pb-1 text-left font-normal">Opp</th>
              <th className="px-1.5 pb-1 text-left font-normal">Result</th>
              {HEAD.map((h) => (
                <th key={h} className="px-1.5 pb-1 text-right font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((s) => {
              const l = s.line;
              const slug = (l.home ? `${l.opp}-${l.tri}` : `${l.tri}-${l.opp}`).toLowerCase();
              const href = `/hoops/scores/${l.date}/${slug}`;
              return (
                <tr key={l.gameId} className="border-b border-rule/30">
                  <td className="sticky left-0 bg-ink py-1.5 pr-2 text-left text-cream-dimmer">{shortDate(l.date)}</td>
                  <td className="px-1.5 text-left">
                    <span className="text-cream-dimmer">{l.home ? "vs " : "@ "}</span>
                    <Link href={`/hoops/scores/teams/${l.opp.toLowerCase()}`} className="text-cream hover:text-cat-hoops">
                      {l.opp}
                    </Link>
                  </td>
                  {s.hidden ? (
                    <td colSpan={HEAD.length + 1} className="px-1.5 text-left">
                      <Link href={href} className="text-cream-dimmer hover:text-cat-hoops" data-kb-item>
                        Hidden · open the game →
                      </Link>
                    </td>
                  ) : (
                    <>
                      <td className="px-1.5 text-left">
                        <Link href={href} className="hover:text-cat-hoops" data-kb-item>
                          {s.line.result && (
                            <span className={s.line.result === "W" ? "text-cat-hoops" : "text-cream-dim"}>
                              {s.line.result}{" "}
                            </span>
                          )}
                          <span className="text-cream">
                            {s.line.teamScore ?? "–"}-{s.line.oppScore ?? "–"}
                          </span>
                        </Link>
                      </td>
                      {[
                        String(s.line.min),
                        String(s.line.pts),
                        String(s.line.reb),
                        String(s.line.ast),
                        String(s.line.stl),
                        String(s.line.blk),
                        String(s.line.to),
                        `${s.line.fgm}-${s.line.fga}`,
                        `${s.line.tpm}-${s.line.tpa}`,
                        `${s.line.ftm}-${s.line.fta}`,
                      ].map((c, j) => (
                        <td key={j} className={`px-1.5 text-right ${j === 1 ? "text-cream" : "text-cream-dim"}`}>
                          {c}
                        </td>
                      ))}
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
