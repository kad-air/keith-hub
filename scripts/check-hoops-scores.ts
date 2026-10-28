#!/usr/bin/env node
//
// THE REAL SCORES SECTION — parsers, notable detection, dates, cache policy.
//
//   npm run check:hoops:scores    (standalone)
//   npm run build                 (runs via prebuild)
//
// Offline: every upstream response is a RECORDED ESPN payload in
// hoops-scores-fixture/ (trimmed of links/logos/plays, otherwise as served —
// fetched 2026-10-22, while three games of opening week were live). The
// anchors are things true about real basketball, independent of the parser:
// the final scores and quarter lines of real games, Jokić's 56/16/15 on
// Christmas 2025 (in overtime), a box score's player lines adding to the
// team's total and the final score, Mountain time across a DST boundary.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FRANCHISES } from "../lib/hoops/nba-franchises.ts";
import { addDays, isIsoDate, longDate, tipTime, todayIn } from "../lib/hoops/scores/dates.ts";
import { periodLabels, statusLabel } from "../lib/hoops/scores/format.ts";
import { findNotable, NOTABLE, notableReasons } from "../lib/hoops/scores/notable.ts";
import {
  canonicalTri,
  gameSlug,
  parseScoreboard,
  parseStandings,
  parseSummary,
  tvLabel,
} from "../lib/hoops/scores/parse.ts";
import { boxPolicy, findGame, scoreboardPolicy } from "../lib/hoops/scores/policy.ts";
import {
  applyLive,
  coreUrls,
  LIVE_POLL_MS,
  LIVE_TTL_MS,
  liveCandidates,
  livePolicy,
  parseCorePlay,
  parseCoreScore,
  parseCoreStatus,
  playRef,
  TIP_LOOKAHEAD_MS,
} from "../lib/hoops/scores/live.ts";
import {
  behindLabel,
  clockLabel,
  clockSeconds,
  effectiveTimes,
  gameAtMoment,
  momentAt,
  offsetForMoment,
  orderPlays,
  periodChoices,
  periodLengthSec,
  playsAt,
  protectedStatus,
  typedClockSeconds,
  veilGame,
  wirePlay,
} from "../lib/hoops/scores/spoiler.ts";
import { boxFromPlays } from "../lib/hoops/scores/boxAt.ts";
import { parsePlays } from "../lib/hoops/scores/parse.ts";
import type { CoreLive, Game, GameBox, PlayerBoxLine, Scoreboard, TeamTotals } from "../lib/hoops/scores/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "hoops-scores-fixture");
const problems: string[] = [];
let passed = 0;
const check = (cond: boolean, msg: string): void => {
  if (cond) passed++;
  else problems.push(msg);
};
const load = (f: string): unknown => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const sb = (date: string): Scoreboard =>
  parseScoreboard(load(`scoreboard-${date.replace(/-/g, "")}.json`), date);
const game = (s: Scoreboard, slug: string): Game => {
  const g = findGame(s, slug);
  if (!g) throw new Error(`fixture ${s.date} has no ${slug} (have ${s.games.map(gameSlug).join(", ")})`);
  return g;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ── 1. scoreboard: opening week, finals + live ───────────────────────────
const oct21 = sb("2026-10-21");
check(oct21.games.length === 11, `2026-10-21: expected 11 games, got ${oct21.games.length}`);
const atlOrl = game(oct21, "atl-orl");
check(atlOrl.state === "post" && atlOrl.statusDetail === "Final", "ATL@ORL should be Final");
check(atlOrl.away.score === 132 && atlOrl.home.score === 125, "ATL 132, ORL 125");
check(
  JSON.stringify(atlOrl.home.linescore) === "[33,29,38,25]",
  `ORL quarters 33-29-38-25, got ${atlOrl.home.linescore}`,
);
check(atlOrl.away.winner && !atlOrl.home.winner, "ATL won");
check(atlOrl.home.record === "0-1" && atlOrl.away.record === "1-0", "records after game 1");
check(atlOrl.seasonKind === "regular" && atlOrl.series === null, "regular season, no series line");

// Every final on every recorded day: the quarters add up to the score, and
// a team is a real franchise.
const days = ["2026-10-21", "2026-10-22", "2026-10-10", "2026-06-10", "2026-07-15"].map(sb);
for (const d of days) {
  for (const g of d.games) {
    if (g.state !== "post") continue;
    for (const t of [g.away, g.home]) {
      check(sum(t.linescore) === t.score, `${d.date} ${t.tri}: quarters ${t.linescore} ≠ ${t.score}`);
    }
    check(g.away.winner !== g.home.winner, `${d.date} ${gameSlug(g)}: exactly one winner`);
  }
  for (const g of d.games) {
    if (g.seasonKind === "preseason") continue; // preseason may bring a non-NBA club
    for (const t of [g.away, g.home]) check(t.tri in FRANCHISES, `${d.date}: unknown tri ${t.tri}`);
  }
  // Sorted by tip time.
  const tips = d.games.map((g) => g.startUtc);
  check(tips.join() === [...tips].sort().join(), `${d.date}: games not in tip order`);
}

// ESPN's short codes map to the franchise tri the rest of Hoops uses.
check(canonicalTri("GS") === "GSW" && canonicalTri("UTAH") === "UTA" && canonicalTri("WSH") === "WAS", "tri map");
check(canonicalTri("NO") === "NOP" && canonicalTri("NY") === "NYK" && canonicalTri("SA") === "SAS", "tri map 2");
check(canonicalTri("DEN") === "DEN", "identity tri");

const gswLal = game(oct21, "gsw-lal");
check(gswLal.state === "in" && gswLal.period === 3, "GSW@LAL live, end of 3rd");
check(statusLabel(gswLal) === "End of 3rd", `GSW@LAL status, got "${statusLabel(gswLal)}"`);
check(gswLal.home.score === 102 && gswLal.away.score === 68, "GSW@LAL live score 68-102");
check(tvLabel(gswLal.tv) === "ESPN", `national TV should be ESPN, got ${tvLabel(gswLal.tv)}`);
const phxPor = game(oct21, "phx-por");
check(phxPor.state === "in" && statusLabel(phxPor) === "9:08 - 4th", `PHX@POR clock, got ${statusLabel(phxPor)}`);
check(phxPor.tv.national.length === 0 && phxPor.tv.home.includes("BlazerVision"), "PHX@POR local TV only");
check(tvLabel(phxPor.tv) === "League Pass", "local-only game reads League Pass");
check(phxPor.home.linescore.length === 4 && phxPor.home.linescore[3] === 2, "live game carries its partial quarter");

// ── 2. schedule: tip times in Mountain ───────────────────────────────────
const oct22 = sb("2026-10-22");
const clePhi = game(oct22, "cle-phi");
const denOkc = game(oct22, "den-okc");
check(clePhi.state === "pre" && clePhi.away.score === null, "CLE@PHI scheduled, no score");
// 23:00Z on Oct 22 is 7pm EDT = 5pm MDT; 01:30Z Oct 23 is 9:30 EDT = 7:30 MDT.
check(statusLabel(clePhi) === "5:00 PM MT", `CLE@PHI tip, got ${statusLabel(clePhi)}`);
check(statusLabel(denOkc) === "7:30 PM MT", `DEN@OKC tip, got ${statusLabel(denOkc)}`);
check(denOkc.tv.national.includes("ESPN"), "DEN@OKC on ESPN");
check(denOkc.home.record === "1-0" && denOkc.away.record === "0-0", "pre-game records still shown (OKC won its opener)");

// ── 3. preseason overtime, postseason series, offseason ──────────────────
const oct10 = sb("2026-10-10");
const detWas = game(oct10, "det-was");
check(detWas.seasonKind === "preseason", "Oct 10 is preseason");
check(detWas.statusDetail === "Final/OT" && detWas.home.linescore.length === 5, "DET@WAS went to OT");
check(periodLabels(5).join(" ") === "1 2 3 4 OT", `period labels, got ${periodLabels(5)}`);
check(periodLabels(7).slice(-2).join(" ") === "2OT 3OT", "multi-OT labels");
check(periodLabels(0).length === 4, "an unstarted game still has four quarter slots");
check(game(oct10, "lac-tor").note === "NBA Canada Games 2026", "competition note");
const finals = sb("2026-06-10");
const sasNyk = game(finals, "sas-nyk");
check(sasNyk.seasonKind === "postseason", "June is postseason");
check(sasNyk.note === "NBA Finals - Game 4" && sasNyk.series === "NY leads series 3-1", "Finals note + series");
check(sb("2026-07-15").games.length === 0, "an offseason day parses to zero games, no throw");

// ── 4. box score: Christmas 2025, MIN @ DEN, overtime ─────────────────────
const xmas: GameBox = parseSummary(load("summary-401809242.json"));
check(xmas.game.statusDetail === "Final/OT" && xmas.game.state === "post", "Christmas game final in OT");
check(xmas.teams.length === 2 && xmas.teams[0].tri === "MIN" && xmas.teams[1].tri === "DEN", "away first");
check(xmas.game.home.score === 142 && xmas.game.away.score === 138, "DEN 142, MIN 138");
const p = (tri: string, name: string): PlayerBoxLine => {
  const hit = xmas.teams.find((t) => t.tri === tri)?.players.find((x) => x.name === name);
  if (!hit) throw new Error(`no ${name} in ${tri}`);
  return hit;
};
const jokic = p("DEN", "Nikola Jokic");
check(jokic.pts === 56 && jokic.reb === 16 && jokic.ast === 15, `Jokić 56/16/15, got ${jokic.pts}/${jokic.reb}/${jokic.ast}`);
check(jokic.starter && !jokic.dnp, "Jokić started");
check(p("MIN", "Anthony Edwards").pts === 44, "Edwards 44");
for (const fx of ["summary-401809242.json", "summary-401909834.json"]) {
  const b = parseSummary(load(fx));
  for (const t of b.teams) {
    const played = t.players.filter((x) => !x.dnp);
    const line = t.tri === b.game.home.tri ? b.game.home : b.game.away;
    check(sum(played.map((x) => x.pts)) === t.totals.pts, `${fx} ${t.tri}: player points ≠ team total`);
    check(t.totals.pts === line.score, `${fx} ${t.tri}: team total ${t.totals.pts} ≠ final ${line.score}`);
    check(sum(played.map((x) => x.fgm)) === t.totals.fgm, `${fx} ${t.tri}: FGM don't add up`);
    check(sum(played.map((x) => x.reb)) === t.totals.reb, `${fx} ${t.tri}: REB don't add up`);
    check(played.every((x) => x.oreb + x.dreb === x.reb), `${fx} ${t.tri}: OREB+DREB ≠ REB`);
    check(t.totals.pts === 2 * (t.totals.fgm - t.totals.tpm) + 3 * t.totals.tpm + t.totals.ftm, `${fx} ${t.tri}: shooting ≠ points`);
    // Starters first (five of them), DNPs last, and a DNP carries no line.
    const starters = t.players.filter((x) => x.starter && !x.dnp).length;
    check(starters === 5, `${fx} ${t.tri}: ${starters} starters`);
    check(t.players.slice(0, 5).every((x) => x.starter), `${fx} ${t.tri}: starters not first`);
    const firstDnp = t.players.findIndex((x) => x.dnp);
    check(firstDnp === -1 || t.players.slice(firstDnp).every((x) => x.dnp), `${fx} ${t.tri}: DNP not last`);
    check(t.players.filter((x) => x.dnp).every((x) => x.pts === 0 && x.min === 0), `${fx}: DNP with stats`);
    // Five men on the floor for 48 (or 53) minutes: 240 / 265 player minutes,
    // give or take ESPN's rounding of each line to a whole minute.
    const mins = sum(played.map((x) => x.min));
    const want = 5 * (48 + 5 * Math.max(0, line.linescore.length - 4));
    check(Math.abs(mins - want) <= played.length, `${fx} ${t.tri}: ${mins} player-minutes, want ~${want}`);
    check(played.some((x) => x.plusMinus !== null && x.plusMinus !== 0), `${fx}: +/- parsed`);
  }
}
const opener = parseSummary(load("summary-401909834.json"));
const atl = opener.teams.find((t) => t.tri === "ATL");
check(!!atl && atl.players.filter((x) => x.dnp).length === 4, "ATL had four DNPs on opening night");
check(!!atl && atl.players.every((x) => !x.dnp || x.dnpReason !== null), "a DNP keeps its reason");
check(!!atl && atl.players.every((x) => x.dnp || x.dnpReason === null), "a played line has no DNP reason");

// ESPN happens to list starters first already, which makes the ordering
// vacuous on real payloads: reverse the athletes and it must still hold.
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(JSON.stringify(load("summary-401809242.json"))) as any;
  for (const b of raw.boxscore.players) b.statistics[0].athletes.reverse();
  for (const t of parseSummary(raw).teams) {
    check(t.players.slice(0, 5).every((x) => x.starter), `reversed ${t.tri}: starters not first`);
    const firstDnp = t.players.findIndex((x) => x.dnp);
    check(firstDnp === -1 || t.players.slice(firstDnp).every((x) => x.dnp), `reversed ${t.tri}: DNP not last`);
  }
}

// In the regular season ESPN's `series` is the SEASON series ("NY wins
// series 4-0" on Christmas 2025) — it must not render as a playoff line.
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(JSON.stringify(load("scoreboard-20261021.json"))) as any;
  for (const e of raw.events) e.competitions[0].series = { summary: "ATL wins series 4-0" };
  check(parseScoreboard(raw, "2026-10-21").games.every((g) => g.series === null), "regular-season series hidden");
}

// ── 5. notable performances ──────────────────────────────────────────────
const notable = findNotable([xmas], "2025-12-25");
check(notable[0]?.name === "Nikola Jokic", `Jokić leads Christmas notable, got ${notable[0]?.name}`);
check(notable[0]?.reasons[0] === "Triple-double" && notable[0].reasons.includes("56 points"), `Jokić reasons ${notable[0]?.reasons}`);
check(notable[0]?.href === "/hoops/scores/2025-12-25/min-den", `notable href, got ${notable[0]?.href}`);
check(notable.some((n) => n.name === "Anthony Edwards" && n.reasons.includes("44 points")), "Edwards' 44 is notable");
check(notable.some((n) => n.name === "Jamal Murray" && n.reasons.includes("35 & 10")), "Murray 35 & 10 is notable");
check(notable.every((n) => n.line.pts >= 10 || n.line.reb >= 10), "nothing trivial flagged");
const openerNotable = findNotable([opener], "2026-10-21");
check(openerNotable.length === 1 && openerNotable[0].name === "Paolo Banchero", "Banchero 35 & 10 on opening night");
// A live game is never mined for notable lines.
check(findNotable([{ ...xmas, game: { ...xmas.game, state: "in" } }], "x").length === 0, "live game skipped");

// Boundaries, against NOTABLE itself so the constant stays the one place.
const blank: PlayerBoxLine = {
  id: "0", name: "Test", starter: true, dnp: false, dnpReason: null, ejected: false, min: 36,
  pts: 0, reb: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0,
  fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, plusMinus: 0,
};
const r = (o: Partial<PlayerBoxLine>) => notableReasons({ ...blank, ...o }).reasons;
check(r({ pts: NOTABLE.points - 1 }).length === 0, "39 points is not notable");
check(r({ pts: NOTABLE.points }).length === 1, "40 points is notable");
check(r({ pts: 10, reb: 10, ast: 9 }).length === 0, "10/10/9 is not a triple-double");
check(r({ pts: 10, reb: 10, ast: 10 })[0] === "Triple-double", "10/10/10 is");
check(r({ pts: 10, reb: 10, ast: 10, blk: 10 })[0] === "Quadruple-double", "quadruple-double");
check(r({ pts: 5, reb: 5, ast: 5, stl: 5, blk: 5 }).includes("5x5"), "5x5");
check(r({ pts: 5, reb: 5, ast: 5, stl: 5, blk: 4 }).length === 0, "not quite 5x5");
check(r({ pts: 24, ast: 10 }).length === 0 && r({ pts: 25, ast: 10 }).length === 1, "25 & 10 boundary");
check(r({ reb: NOTABLE.rebounds }).length === 1 && r({ ast: NOTABLE.assists }).length === 1, "reb / ast bars");
check(r({ tpm: NOTABLE.threes }).length === 1 && r({ tpm: NOTABLE.threes - 1 }).length === 0, "threes bar");
check(notableReasons({ ...blank, dnp: true, pts: 50 }).reasons.length === 0, "a DNP is never notable");

// ── 6. dates: Mountain, not UTC ──────────────────────────────────────────
// 9pm MDT on Oct 22 is already Oct 23 in UTC — the Railway trap.
const evening = new Date("2026-10-23T03:00:00Z");
check(todayIn(evening) === "2026-10-22", `9pm MDT is still Oct 22, got ${todayIn(evening)}`);
check(evening.toISOString().slice(0, 10) === "2026-10-23", "…and the naive UTC date disagrees");
// DST ends 2026-11-01 (first Sunday of November): 7pm MST is 02:00Z next day.
check(todayIn(new Date("2026-11-03T02:00:00Z")) === "2026-11-02", "after DST ends, still the evening before");
check(tipTime("2026-11-03T02:00:00Z") === "7:00 PM", `MST tip, got ${tipTime("2026-11-03T02:00:00Z")}`);
check(tipTime("2026-10-23T01:00:00Z") === "7:00 PM", "MDT tip");
check(addDays("2026-12-31", 1) === "2027-01-01" && addDays("2026-03-01", -1) === "2026-02-28", "addDays");
check(isIsoDate("2026-10-21") && !isIsoDate("2026-02-30") && !isIsoDate("20261021") && !isIsoDate("x"), "isIsoDate");
check(longDate("2026-10-21") === "Wednesday, October 21, 2026", `longDate, got ${longDate("2026-10-21")}`);

// ── 7. cache policy ──────────────────────────────────────────────────────
const today = "2026-10-22";
check(scoreboardPolicy(oct21, today).ttlMs === 10_000, "a day with a live game refreshes every 10s (ESPN republishes ~10s)");
const oct21Done: Scoreboard = { ...oct21, games: oct21.games.map((g) => ({ ...g, state: "post" as const })) };
check(scoreboardPolicy(oct21Done, today).final, "a finished past day is final");
check(!scoreboardPolicy(oct21Done, "2026-10-21").final, "today is never final, even all-final");
check(!scoreboardPolicy({ date: "2026-07-15", games: [] }, today).final, "an empty past day is not trusted forever");
check(scoreboardPolicy(oct22, today).ttlMs === 60_000, "today's slate: 60s");
check(scoreboardPolicy({ date: "2026-11-20", games: [] }, today).ttlMs === 15 * 60_000, "far future: 15 min");
check(boxPolicy(xmas).final, "a final box score is final");
check(!boxPolicy({ ...xmas, game: { ...xmas.game, state: "in" } }).final, "a live box score is not");
check(boxPolicy({ ...xmas, game: { ...xmas.game, state: "in" } }).ttlMs === 6_000, "a live box score lives 6s (ESPN's own max-age)");
check(findGame(oct21, "GSW-LAL")?.id === gswLal.id && findGame(oct21, gswLal.id)?.id === gswLal.id, "slug or id");
check(findGame(oct21, "den-okc") === null, "a game not on that day is not found");

// ── 8. standings ─────────────────────────────────────────────────────────
const st = parseStandings(load("standings-2026-10-22.json"));
check(st.season === "2026-27", `season, got ${st.season}`);
check(st.conferences.length === 2, "two conferences");
const tris = st.conferences.flatMap((c) => c.rows.map((x) => x.tri));
check(tris.length === 30 && new Set(tris).size === 30, "30 distinct teams");
for (const c of st.conferences) {
  const conf = c.name.startsWith("East") ? "East" : "West";
  check(c.rows.length === 15, `${c.name}: 15 teams`);
  check(c.rows.every((x) => FRANCHISES[x.tri]?.conference === conf), `${c.name}: a team in the wrong conference`);
  // Seeds can TIE in opening week (seven 0-0 teams share the West's 5th),
  // so the order is seed, then win percentage — never a seed out of order.
  check(c.rows.every((x, i) => i === 0 || (x.seed ?? 0) >= (c.rows[i - 1].seed ?? 0)), `${c.name}: not in seed order`);
  check(c.rows.every((x, i) => i === 0 || Number(x.pct) <= Number(c.rows[i - 1].pct)), `${c.name}: pct not descending`);
  check(c.rows[0].seed === 1, `${c.name}: first row is the 1 seed`);
  check(c.rows[0].gb === "-", `${c.name}: leader's GB is "-"`);
  check(c.rows.every((x) => /^\d+-\d+$/.test(x.l10) && /^[WL-]/.test(x.streak)), `${c.name}: L10 / streak shape`);
}

// ── 9. the live overlay: ESPN's core resources, recorded 2026-10-25 ──────
// BKN @ IND, 2nd quarter, 6:57 on the clock — status, both score resources,
// the situation and the play it points at, fetched within the same minute.
// The score resources (BKN 43, IND 44) were read a few seconds after the
// status and the play (which still carried 39-39): the overlay moves exactly
// these fields off their own resources, so the recordings need not agree.
const coreStatus = parseCoreStatus(load("core-status-401909862.json"));
check(coreStatus.state === "in" && coreStatus.period === 2, "core status: in progress, 2nd quarter");
check(coreStatus.clock === "6:57" && coreStatus.statusDetail === "6:57 - 2nd", `core status clock/detail, got ${coreStatus.clock} / ${coreStatus.statusDetail}`);
check(!coreStatus.postponed, "core status: not postponed");
check(parseCoreScore(load("core-score-401909862-17.json")) === 43, "BKN (17) score resource reads 43 (shipped as 43.0)");
check(parseCoreScore(load("core-score-401909862-11.json")) === 44, "IND (11) score resource reads 44");
check(parseCoreScore({ value: "x" }) === null && parseCoreScore(null) === null, "an unreadable score is null, never 0");
const situation = load("core-situation-401909862.json");
const ref = playRef(situation);
check(
  ref === "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/401909862/competitions/401909862/plays/401909862263?lang=en&region=us",
  `situation → lastPlay ref (https, same host), got ${ref}`,
);
check(playRef({ lastPlay: { $ref: "http://evil.example/x" } }) === null, "a $ref off ESPN's core host is never followed");
check(playRef({}) === null, "no lastPlay → no ref");
const play = parseCorePlay(load("core-lastplay-401909862.json"));
check(play?.text === "Obi Toppin enters the game for Pascal Siakam", `last play text, got ${play?.text}`);
check(play?.clock === "6:57" && play?.period === 2 && play?.scoring === false, "last play clock/period/scoring");
check(play?.teamId === "11", `last play credited to team 11 (IND), got ${play?.teamId}`);
check(parseCorePlay({ text: "" }) === null, "a play with no text is null");

// The overlay over a real live scoreboard Game (PHX@POR, 9:08 4th, from the
// 2026-10-21 recording): moves the clock, the state and the totals; touches
// NOTHING else.
const before = phxPor;
const overlay: CoreLive = {
  id: before.id, state: "in", statusDetail: "7:50 - 4th", period: 4, clock: "7:50", postponed: false,
  awayScore: (before.away.score ?? 0) + 3, homeScore: before.home.score, lastPlay: play, fetchedAt: 0,
};
const after = applyLive(before, overlay);
check(after.clock === "7:50" && after.statusDetail === "7:50 - 4th" && after.period === 4, "overlay moves clock/detail/period");
check(after.away.score === (before.away.score ?? 0) + 3 && after.home.score === before.home.score, "overlay moves the totals");
const untouched = (g: Game) => JSON.stringify({ ...g, state: 0, statusDetail: 0, period: 0, clock: 0, postponed: 0, away: { ...g.away, score: 0, winner: 0 }, home: { ...g.home, score: 0, winner: 0 } });
check(untouched(after) === untouched(before), "overlay leaves tri, names, records, quarters, TV, note, series untouched");
check(JSON.stringify(after.home.linescore) === JSON.stringify(before.home.linescore), "quarters are never inferred from the total");
check(applyLive(before, { ...overlay, awayScore: null }).away.score === before.away.score, "a null total keeps the scoreboard's");
const finalOverlay: CoreLive = { ...overlay, state: "post", statusDetail: "Final", clock: "0.0", awayScore: 110, homeScore: 104 };
const done = applyLive(before, finalOverlay);
check(done.state === "post" && done.away.winner && !done.home.winner, "once over, the winner is recomputed from the totals");
const sched = applyLive({ ...before, state: "pre", away: { ...before.away, score: null }, home: { ...before.home, score: null } }, { ...overlay, state: "pre", awayScore: 0, homeScore: 0 });
check(sched.away.score === null && sched.home.score === null, "a scheduled game stays scoreless on BOTH sides (0-0 is not a score)");
check(before.state === "in" && before.clock === "9:08", "the fixture game really was live at 9:08 (so the overlay changed something)");

// Which games the live endpoint reads. 2026-10-22's slate is all scheduled;
// CLE@PHI tips 23:00Z, DEN@OKC 01:30Z the next day.
const t2255 = Date.parse("2026-10-22T22:55:00Z");
const near = liveCandidates(oct22, t2255).map(gameSlug);
check(near.includes("cle-phi") && !near.includes("den-okc"), `5 min before tip CLE@PHI is probed, DEN@OKC not — got ${near}`);
check(liveCandidates(oct22, t2255 - TIP_LOOKAHEAD_MS - 1).length === 0, "nothing is probed before the lookahead window");
check(liveCandidates(oct22, Date.parse("2026-10-22T23:30:00Z")).map(gameSlug).includes("cle-phi"), "a listed tip that has passed (delayed) is still probed");
const liveOnly = liveCandidates(oct21, Date.parse("2026-10-22T03:00:00Z"));
check(liveOnly.length > 0 && liveOnly.every((g) => g.state === "in"), "finals are never probed; every in-progress game is");
check(liveOnly.length === oct21.games.filter((g) => g.state === "in").length, "…all of them");
check(liveCandidates({ date: "x", games: [{ ...phxPor, postponed: true }] }, t2255).length === 0, "a postponed game is not probed");

// Policy + URLs.
check(livePolicy(overlay).ttlMs === LIVE_TTL_MS && !livePolicy(overlay).final, "a live core read lives LIVE_TTL_MS");
check(livePolicy(finalOverlay).final, "a finished core read is final");
check(LIVE_TTL_MS < LIVE_POLL_MS && LIVE_TTL_MS >= 2_000, "the server cache is shorter than the client tick but not below ESPN's own max-age");
const urls = coreUrls(phxPor);
check(urls.status.endsWith(`/events/${phxPor.id}/competitions/${phxPor.id}/status`), `status url, got ${urls.status}`);
check(urls.awayScore.endsWith(`/competitors/${phxPor.away.espnId}/score`) && urls.homeScore.endsWith(`/competitors/${phxPor.home.espnId}/score`), "score urls use each side's ESPN team id");
check(urls.status.startsWith("https://sports.core.api.espn.com/"), "core host");

// ── 10. spoiler mode: the play-by-play as the history ───────────────────
// Two summaries recorded WITH their plays on 2026-10-25: LAL @ UTA, final
// (LAL 132, UTA 123 — quarters 29-47, 45-24, 29-29, 29-23), and IND @ BKN
// with 6:57 left in the 4th. Real-basketball anchors first, then the rules
// that make the mode safe: a moment can only ever stand on a play at or
// BEFORE the target, and a typed clock resolves at or PAST it.
const finalRaw = load("summary-plays-401909861.json");
const finalBox: GameBox = parseSummary(finalRaw);
const finalPlays = parsePlays(finalRaw);
check(finalPlays.length === 512 && finalBox.plays?.length === 512, `LAL@UTA: 512 timed plays, got ${finalPlays.length}`);
check(finalPlays.every((p) => Number.isFinite(p.wallclockMs) && p.period >= 1), "every play carries a wall-clock and a period");
const end = momentAt(finalPlays, Infinity);
check(end !== null && end.final, "the end of the play-by-play is the final");
check(end?.awayScore === 132 && end?.homeScore === 123, `LAL 132, UTA 123 off the plays, got ${end?.awayScore}-${end?.homeScore}`);
check(end?.awayScore === finalBox.game.away.score && end?.homeScore === finalBox.game.home.score, "the plays' final agrees with the same payload's header");
check(JSON.stringify(end?.awayLinescore) === "[29,45,29,29]", `LAL quarters off the plays, got ${end?.awayLinescore}`);
check(JSON.stringify(end?.homeLinescore) === "[47,24,29,23]", `UTA quarters off the plays, got ${end?.homeLinescore}`);
check(sum(end?.awayLinescore ?? []) === 132 && sum(end?.homeLinescore ?? []) === 123, "derived quarters add to the final");

// The envelope is exercised: ESPN's wall-clocks really do run backwards in
// game order on this recording (15 of 512 steps), so a naive "last play with
// wallclock ≤ target" would differ from the monotone rule somewhere.
const orderedF = orderPlays(finalPlays);
const effF = effectiveTimes(orderedF);
check(orderedF.some((p, i) => i > 0 && p.wallclockMs < effF[i - 1]), "fixture has out-of-order wall-clocks (the envelope matters)");
check(effF.every((t, i) => i === 0 || t >= effF[i - 1]), "effective times are monotone");

// 🔴 The leak property, swept: at every target the moment stands on a play
// whose effective time ≤ target, it is exactly the last such play, and the
// score never goes down as the target advances.
let prevA = -1;
let prevH = -1;
let leak = 0;
let notLast = 0;
let nonMono = 0;
for (let t = effF[0] - 60_000; t <= effF[effF.length - 1] + 60_000; t += 20_000) {
  const m = momentAt(finalPlays, t);
  if (!m) {
    if (t >= effF[0]) leak++;
    continue;
  }
  if (m.atMs > t) leak++;
  const expectIdx = effF.filter((e) => e <= t).length - 1;
  if (m.atMs !== effF[expectIdx]) notLast++;
  if (m.awayScore < prevA || m.homeScore < prevH) nonMono++;
  prevA = m.awayScore;
  prevH = m.homeScore;
}
check(leak === 0, `a moment never stands on a play after its target (${leak} leaks)`);
check(notLast === 0, `a moment is the LAST play at or before its target (${notLast} misses)`);
check(nonMono === 0, `scores never decrease as the target advances (${nonMono})`);
check(momentAt(finalPlays, effF[0] - 1) === null, "a target before the first play has no moment");
check(momentAt([], Date.now()) === null, "no plays, no moment");

// Resolving "I'm at 7:32 in the 3rd" on the live game: the first play in game
// order in the 3rd at or past 7:32 (clock ≤ 452 — the clock counts down), so
// the view lands behind the viewer, never ahead; then the round trip.
const liveRaw = load("summary-plays-401909862.json");
const livePlays = parsePlays(liveRaw);
const liveBox: GameBox = parseSummary(liveRaw);
check(liveBox.game.state === "in" && liveBox.game.period === 4 && liveBox.game.clock === "6:57", "IND@BKN recorded live, 6:57 4th");
const nowL = effectiveTimes(orderPlays(livePlays)).at(-1)! + 5_000;
const res3 = offsetForMoment(livePlays, 3, 452, nowL);
check(res3.ok, "3rd · 7:32 resolves on a game in the 4th");
if (res3.ok) {
  const ordered = orderPlays(livePlays);
  const eff = effectiveTimes(ordered);
  const idx = ordered.findIndex((p) => p.period === 3 && p.clockSec !== null && p.clockSec <= 452);
  check(idx >= 0 && nowL - eff[idx] === res3.offsetMs, "the offset is now − the FIRST play at or past the typed clock");
  check(ordered.slice(0, idx).every((p) => p.period < 3 || p.clockSec === null || p.clockSec > 452), "…and no earlier play in game order is at or past it");
  const back = momentAt(livePlays, nowL - res3.offsetMs);
  check(back?.period === 3 && back.clock === ordered[idx].clock, `the round trip lands on that play (${back?.period} ${back?.clock})`);
  check(back !== null && (back.lastPlay?.clock === null || clockSeconds(back.lastPlay?.clock) !== null), "the synced view's clock is the play's own text");
  check((clockSeconds(back?.clock) ?? 0) <= 452, "the synced view is at or behind the viewer, never ahead");
}
check(!offsetForMoment(livePlays, 4, 120, nowL).ok, "4th · 2:00 is ahead of a game at 6:57 in the 4th");
check(!offsetForMoment(livePlays, 5, 300, nowL).ok, "overtime is ahead of a game still in the 4th");
const r1 = offsetForMoment(livePlays, 1, 720, nowL);
check(r1.ok && r1.period === 1 && r1.clock === "12:00", "1st · 12:00 is the opening tip");
const r2 = offsetForMoment(livePlays, 2, 720, nowL);
check(r2.ok && r2.period === 2, "1st quarter over → 2nd · 12:00 resolves into the 2nd");
check(!offsetForMoment([], 1, 100, nowL).ok, "no plays → no resolution");
const fin = offsetForMoment(finalPlays, 4, 0, nowL);
check(fin.ok && momentAt(finalPlays, nowL - fin.offsetMs)?.final === true, "4th · 0.0 on a final resolves to the end");

// The veil and the card copy: a protected card says where, never what.
check(protectedStatus(xmas.game) === "Final", `Final/OT reads Final when veiled, got ${protectedStatus(xmas.game)}`);
check(protectedStatus(phxPor) === "9:08 - 4th", "a live clock passes through the veil");
const veiled = veilGame(xmas.game);
check(veiled.away.score === null && veiled.home.score === null, "veiled: no scores");
check(veiled.away.linescore.length === 0 && veiled.home.linescore.length === 0, "veiled: no quarters");
check(veiled.away.record === null && !veiled.away.winner && !veiled.home.winner, "veiled: no records, no winner");
check(veiled.statusDetail === "Final" && veiled.state === "post", "veiled: the OT suffix is gone, the state stays");
check(veiled.away.tri === "MIN" && veiled.home.name === xmas.game.home.name && veiled.startUtc === xmas.game.startUtc, "veiled: teams, names, tip untouched");
const synced = gameAtMoment(liveBox.game, momentAt(livePlays, nowL - (res3.ok ? res3.offsetMs : 0))!);
check(synced.state === "in" && synced.period === 3 && synced.away.score !== null && synced.away.linescore.length === 3, "synced card: 3rd quarter, three quarter cells");
check(synced.statusDetail.endsWith("- 3rd"), `synced status reads the moment, got ${synced.statusDetail}`);
const atEnd = gameAtMoment(finalBox.game, end!);
check(atEnd.state === "post" && atEnd.away.winner && !atEnd.home.winner && atEnd.statusDetail === "Final", "a synced view that reaches the end is a final with a winner");

check(clockSeconds("7:32") === 452 && clockSeconds("12:00") === 720 && clockSeconds("24.7") === 24.7, "clock text parses");
check(clockSeconds("abc") === null && clockSeconds("") === null && clockSeconds(null) === null, "non-clocks are null");
// The typed clock: the phone keypad has no colon, so digits read as m:ss
// with the last two as seconds; a dot with one digit is the screen's tenths.
const typedCases: [string, number | null][] = [
  ["732", 452], ["1045", 645], ["1200", 720], ["45", 45], ["5", 5], ["0", 0], ["100", 60],
  ["7:32", 452], ["0:05", 5], ["7.32", 452], ["24.7", 24.7], ["5.3", 5.3], ["0:24.7", 24.7], [" 7 32 ", 452],
  ["790", null], ["060", null], ["12345", null], ["7:3", null], ["75.3", null], ["abc", null], ["", null], ["7:", null],
];
for (const [t, want] of typedCases) check(typedClockSeconds(t) === want, `typed clock "${t}" → ${want}, got ${typedClockSeconds(t)}`);
check(typedClockSeconds(null) === null, "a null typed clock is null");
check(clockLabel(452) === "7:32" && clockLabel(5) === "0:05" && clockLabel(24.7) === "24.7" && clockLabel(720) === "12:00", "typed clock labels");
check(periodLengthSec(4) === 720 && periodLengthSec(5) === 300 && periodLengthSec(6) === 300, "quarters run 12:00, overtimes 5:00");
check(behindLabel(0) === "0:00 behind" && behindLabel(65_000) === "1:05 behind" && behindLabel(3_900_000) === "1h 05m behind", "behind labels");
check(periodChoices(2).length === 4 && periodChoices(6).at(-1)?.label === "2OT", "period choices");

// The impure half can't run here (SQLite), so pin its two rules statically:
// getLive veils through the one veil, and the box never ships its plays.
const dataSrc = fs.readFileSync(path.join(ROOT, "lib/hoops/scores/data.ts"), "utf8");
check(/veilGame\(g\)/.test(dataSrc), "getLive veils with veilGame");
check(/\{ game: b\.game, teams: b\.teams \}/.test(dataSrc), "the wire box is built without plays");

// ── 12. the game page held to the moment: play-by-play and box score ────
// Spoiler mode on the game page (owner, 2026-10-28): a synced game's
// play-by-play tab shows the plays up to the moment and nothing after, and
// its box score is REBUILT from those plays. Anchors: rebuilt from all of
// its plays, LAL@UTA's box equals ESPN's own, every player, every counting
// column, both team rows; IND@BKN (recorded live) equals ESPN's box once the
// box's one-play lag behind the plays is allowed for — measured: ESPN's team
// row already counts the last play (a defensive rebound), its player row
// doesn't yet, so players are compared one play back, the team row at the end.
const COLS = ["pts", "reb", "oreb", "dreb", "ast", "stl", "blk", "to", "pf", "fgm", "fga", "tpm", "tpa", "ftm", "fta"] as const;
const boxDiffs = (live: GameBox["teams"], held: GameBox["teams"], rows: "all" | "players" | "teams" = "all"): string[] => {
  const out: string[] = [];
  live.forEach((t, ti) => {
    for (const p of rows === "teams" ? [] : t.players) {
      const h = held[ti].players.find((x) => x.id === p.id);
      if (!h) {
        out.push(`${p.name} missing`);
        continue;
      }
      if (h.dnp !== p.dnp) out.push(`${p.name} played ${!p.dnp}, rebuilt ${!h.dnp}`);
      for (const c of COLS) if (p[c] !== h[c]) out.push(`${p.name} ${c} ${p[c]} vs ${h[c]}`);
    }
    if (rows !== "players") for (const c of COLS) if (t.totals[c] !== held[ti].totals[c]) out.push(`${t.tri} team ${c} ${t.totals[c]} vs ${held[ti].totals[c]}`);
  });
  return out;
};
const allF = playsAt(finalPlays, Infinity);
check(allF.length === finalPlays.length && allF.every((p, i) => p === orderedF[i]), "playsAt(∞) is the whole game in game order");
check(playsAt(finalPlays, effF[0] - 1).length === 0, "before the first play there are no plays");
const dF = boxDiffs(finalBox.teams, boxFromPlays(finalBox.teams, allF));
check(dF.length === 0, `LAL@UTA rebuilt from its plays equals ESPN's box (${dF.slice(0, 4).join("; ")})`);
const orderedL = orderPlays(livePlays);
const dL = boxDiffs(liveBox.teams, boxFromPlays(liveBox.teams, orderedL.slice(0, -1)), "players");
check(dL.length === 0, `IND@BKN players rebuilt equal ESPN's live lines, which trail the plays by one (${dL.slice(0, 4).join("; ")})`);
const dLT = boxDiffs(liveBox.teams, boxFromPlays(liveBox.teams, orderedL), "teams");
check(dLT.length === 0, `IND@BKN team rows rebuilt from every play equal ESPN's (${dLT.slice(0, 4).join("; ")})`);
check(boxDiffs(liveBox.teams, boxFromPlays(liveBox.teams, orderedL), "players").length > 0, "…and the lag is real: the last play is one the player lines haven't counted");

// Threes come off the play's attempt value: not every three says so in its
// text, and a missed end-of-period heave isn't a field-goal attempt.
check(finalPlays.some((p) => p.pointsAttempted === 3 && !/three point/i.test(p.text)), "fixture has a three whose text doesn't say so");
check(finalPlays.some((p) => /misses heave/i.test(p.text)), "fixture has a missed heave");

// 🔴 The leak property for the page, swept over the whole game: at every
// target the plays are exactly the prefix the card's moment stands on, no
// play from after it, no later period; the held box's team points ARE the
// moment's score; every rebuilt stat only grows and never passes the final;
// minutes and +/- are never shown; nobody shows as in the game before they are.
let prefixMiss = 0;
let boxMiss = 0;
let shrink = 0;
let beyond = 0;
let blankMiss = 0;
let prevLen = 0;
let prevHeld: Map<string, TeamTotals> = new Map();
const finalById = new Map(finalBox.teams.flatMap((t) => t.players.map((p) => [p.id, p] as const)));
for (let t = effF[0] - 60_000; t <= effF[effF.length - 1] + 60_000; t += 20_000) {
  const m = momentAt(finalPlays, t);
  const cut = playsAt(finalPlays, t);
  if (!m) {
    if (cut.length !== 0) prefixMiss++;
    continue;
  }
  const last = cut.at(-1);
  if (!last || last.text !== m.lastPlay?.text || last.clock !== m.clock || last.period !== m.period) prefixMiss++;
  if (cut.some((p, i) => p !== orderedF[i] || effF[i] > t || p.period > m.period)) prefixMiss++;
  if (cut.length < prevLen) prefixMiss++;
  prevLen = cut.length;
  const held = boxFromPlays(finalBox.teams, cut);
  if (held[0].totals.pts !== m.awayScore || held[1].totals.pts !== m.homeScore) boxMiss++;
  const now = new Map<string, TeamTotals>();
  for (const p of held.flatMap((x) => x.players)) {
    now.set(p.id, p);
    const before = prevHeld.get(p.id);
    const fin = finalById.get(p.id)!;
    for (const c of COLS) {
      if (before && p[c] < before[c]) shrink++;
      if (p[c] > fin[c]) beyond++;
    }
    if (p.min !== 0 || p.plusMinus !== null || p.ejected || p.dnpReason !== null) blankMiss++;
    if (!p.dnp && !p.starter && !cut.some((x) => x.text.includes(p.name))) blankMiss++;
  }
  prevHeld = now;
}
check(prefixMiss === 0, `the plays are exactly the prefix the moment stands on (${prefixMiss})`);
check(boxMiss === 0, `the held box's team points are the moment's score (${boxMiss})`);
check(shrink === 0, `a held stat never goes down as the moment advances (${shrink})`);
check(beyond === 0, `a held stat never passes the final (${beyond})`);
check(blankMiss === 0, `held lines carry no minutes, +/-, reason or ejection, and nobody is in before they are (${blankMiss})`);
const w = wirePlay(finalPlays[0]) as unknown as Record<string, unknown>;
check(!("wallclockMs" in w) && !("sequence" in w) && w.text === finalPlays[0].text, "a wire play carries what the row prints, nothing else");

// The impure half, pinned statically: the synced box is the rebuilt one, off
// the same cut as the plays, and a veiled game gets neither.
check(/boxFromPlays\(full\.teams, upTo\)/.test(dataSrc), "getLive's synced box is rebuilt from the cut plays");
check(/single && single\.game\.state !== "pre" && !single\.veiled/.test(dataSrc), "getLive sends no box or plays for a veiled game");
const pageSrc = fs.readFileSync(path.join(ROOT, "components/hoops/scores/GamePage.tsx"), "utf8");
check(/game\.state === "pre" \|\| guarded \? null : await getBox/.test(pageSrc), "the guarded game page reads no box for its server render");

// ── 11. a broken response throws instead of reading as an off day ──────
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
check(throws(() => parseScoreboard({ error: "nope" }, today)), "scoreboard without events throws");
check(throws(() => parseSummary({})), "summary without header throws");
check(throws(() => parseStandings(null)), "standings without children throws");
check(throws(() => parseCoreStatus({ clock: 1 })), "a core status without a type block throws");

if (problems.length) {
  console.error(`check:hoops:scores — ${problems.length} problem(s):`);
  for (const m of problems) console.error(`  ✗ ${m}`);
  process.exit(1);
}
console.log(`check:hoops:scores — ${passed} assertions passed over ${fs.readdirSync(FIX).length} recorded ESPN responses`);
