#!/usr/bin/env node
//
// THE REAL TEAM, PLAYER AND SCHEDULE PAGES — parsers and the spoiler guard.
//
//   npm run check:hoops:teams    (standalone)
//   npm run build                (runs via prebuild)
//
// Offline: every upstream response is a RECORDED ESPN payload in
// hoops-teams-fixture/ (trimmed of links, logos, headshots and the athlete
// page's video/news blocks, otherwise as served — fetched 2026-10-29 around
// 7 AM Mountain, the morning after Utah lost to San Antonio). The anchors are
// things true about those games, independent of the parser: Utah's opening
// week (1-4, the scores of each final), Jokić's 21/13/10 at New Orleans and
// 22.0 / 10.5 over four games, Walker Kessler's Lakers game at the
// Clippers late on the 28th.
//
// The guard is driven with a fake clock: the same recordings read at 11 PM
// and 2 AM Mountain (last night still protected) and at 7 AM (it isn't).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  ESPN_TEAM_IDS,
  gameDate,
  mergeSchedules,
  parseAthlete,
  parseGamelog,
  parseRoster,
  parseTeamSchedule,
  sideOf,
  teamFromSlug,
  triForEspnId,
} from "../lib/hoops/scores/teams.ts";
import { averages, guardGames, guardLog, guardRoster, isGuardedGame, teamRecord } from "../lib/hoops/scores/guard.ts";
import { FRANCHISES } from "../lib/hoops/nba-franchises.ts";
import { gameSlug } from "../lib/hoops/scores/parse.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "hoops-teams-fixture");
const problems: string[] = [];
let passed = 0;
const check = (cond: boolean, msg: string): void => {
  if (cond) passed++;
  else problems.push(msg);
};
const load = (f: string): unknown => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const near = (a: number | null, b: number, eps = 0.01) => a !== null && Math.abs(a - b) < eps;

// The clocks the guard is read at (Mountain is UTC−6 in late October).
const AT_11PM = new Date("2026-10-29T05:00:00Z"); // Oct 28, 11 PM MT: the 28th is today
const AT_2AM = new Date("2026-10-29T08:00:00Z"); // Oct 29, 2 AM MT: the 28th is last night, still guarded
const AT_7AM = new Date("2026-10-29T13:10:00Z"); // Oct 29, 7:10 AM MT: the 28th is open

// ── 1. team ids and slugs ─────────────────────────────────────────────────
check(Object.keys(ESPN_TEAM_IDS).length === 30, "ESPN_TEAM_IDS should cover 30 teams");
check(
  Object.keys(ESPN_TEAM_IDS).every((t) => FRANCHISES[t]),
  "every ESPN_TEAM_IDS key should be a franchise tri",
);
check(new Set(Object.values(ESPN_TEAM_IDS)).size === 30, "ESPN team ids should be distinct");
check(teamFromSlug("uta") === "UTA" && teamFromSlug("UTA") === "UTA", "uta / UTA → UTA");
check(teamFromSlug("utah") === "UTA", "ESPN's own UTAH → UTA");
check(teamFromSlug("gs") === "GSW" && teamFromSlug("nop") === "NOP", "GS → GSW, nop → NOP");
check(teamFromSlug("xyz") === null && teamFromSlug("") === null, "an unknown slug → null");
check(triForEspnId("26") === "UTA" && triForEspnId("999") === null, "ESPN id 26 → UTA");
check(gameDate("2026-10-29T01:00Z") === "2026-10-28", "a 7 PM MT tip is listed under its Mountain date");
check(gameDate("not a date") === "", "an unreadable tip has no date");

// ── 2. roster ─────────────────────────────────────────────────────────────
const roster = parseRoster(load("roster-26.json"), "UTA");
check(roster.tri === "UTA" && roster.espnId === "26", "roster carries UTA / 26");
check(roster.season === "2026-27", `roster season 2026-27, got ${roster.season}`);
check(roster.coach === "Will Hardy", `coach Will Hardy, got ${roster.coach}`);
check(roster.players.length === 18, `Utah lists 18 players, got ${roster.players.length}`);
check(roster.players[0]?.jersey === "00", "jersey order puts 00 first");
const george = roster.players.find((p) => p.name === "Keyonte George");
check(george?.jersey === "3" && george?.pos === "G" && george?.college === "Baylor", "Keyonte George: #3, G, Baylor");
const markkanen = roster.players.find((p) => p.name === "Lauri Markkanen");
check(
  markkanen?.injury?.status === "Day-To-Day" && markkanen.injury.dateUtc === "2026-10-29T04:39Z",
  "Markkanen is day-to-day, stamped late on the 28th",
);
check(roster.players.filter((p) => p.injury).length === 5, "five Utah injuries listed");

// ── 3. schedule ───────────────────────────────────────────────────────────
const reg = parseTeamSchedule(load("schedule-26.json"), "UTA");
const pre = parseTeamSchedule(load("schedule-26-pre.json"), "UTA");
check(reg.games.length === 80 || reg.games.length === 82, `regular season ~82 games, got ${reg.games.length}`);
check(pre.games.length === 4, `four preseason games, got ${pre.games.length}`);
check(reg.games.every((g) => g.seasonKind === "regular"), "regular schedule games are regular");
check(pre.games.every((g) => g.seasonKind === "preseason"), "preseason schedule games are preseason");
check(reg.games.every((g) => sideOf(g, "UTA") !== null), "every game on Utah's schedule has Utah in it");
const all = mergeSchedules([reg, pre, reg]);
check(all.length === reg.games.length + pre.games.length, "merging dedupes by game id");
check(
  all.every((g, i) => i === 0 || all[i - 1].startUtc <= g.startUtc),
  "the merged schedule is oldest first",
);
const finals = all.filter((g) => g.seasonKind === "regular" && g.state === "post");
check(finals.length === 5, `five regular-season finals by the 29th, got ${finals.length}`);
const byId = (id: string) => all.find((g) => g.id === id);
const opener = byId("401909838");
check(
  opener?.away.tri === "UTA" && opener.home.tri === "MEM" && opener.away.score === 103 && opener.home.score === 123,
  "opener: Utah 103 at Memphis 123",
);
const nola = byId("401909849");
check(nola?.home.tri === "UTA" && nola.home.score === 120 && nola.away.score === 119, "Utah 120, New Orleans 119");
const spurs = byId("401909890");
check(
  spurs?.away.tri === "SAS" && spurs.away.score === 117 && spurs.home.score === 111 && spurs.away.winner,
  "San Antonio 117 at Utah 111, the Spurs won",
);
check(spurs !== undefined && gameSlug(spurs) === "sas-uta", "the Spurs game's page slug is sas-uta");
check(spurs !== undefined && gameDate(spurs.startUtc) === "2026-10-28", "the Spurs game is listed under the 28th");
const nextUp = all.find((g) => g.state === "pre");
check(nextUp?.id === "401909896" && nextUp.away.tri === "POR", "next up: Portland at Utah on the 31st");
check(nextUp?.away.score === null && nextUp?.home.score === null, "a scheduled game has no score");

// ── 4. record, unguarded (7 AM: last night is open) ─────────────────────────
const open = teamRecord(all, "UTA", AT_7AM);
check(open.wins === 1 && open.losses === 4, `Utah 1-4 at 7 AM, got ${open.wins}-${open.losses}`);
check(open.home[0] === 1 && open.home[1] === 3 && open.road[0] === 0 && open.road[1] === 1, "home 1-3, road 0-1");
check(open.streak === "L3", `streak L3, got ${open.streak}`);
check(open.recent.join("") === "LWLLL", `last five LWLLL, got ${open.recent.join("")}`);
check(open.held === 0, "nothing held at 7 AM");
const preRec = teamRecord(all, "UTA", AT_7AM, "preseason");
check(preRec.wins === 3 && preRec.losses === 1, `preseason 3-1, got ${preRec.wins}-${preRec.losses}`);
check(guardGames(all, AT_7AM).guarded.size === 0, "no game veiled at 7 AM");

// ── 5. the guard, last night still protected ──────────────────────────────
for (const [label, now] of [
  ["11 PM", AT_11PM],
  ["2 AM", AT_2AM],
] as const) {
  check(spurs !== undefined && isGuardedGame(spurs, now), `${label}: the Spurs game is guarded`);
  check(nextUp !== undefined && !isGuardedGame(nextUp, now), `${label}: a game that hasn't started is never guarded`);
  const g = guardGames(all, now);
  check(g.guarded.size === 1 && g.guarded.has("401909890"), `${label}: exactly the Spurs game is veiled`);
  check(g.dates.join() === "2026-10-28", `${label}: the guarded date is the 28th`);
  const veiled = g.games.find((x) => x.id === "401909890");
  check(
    veiled?.home.score === null && veiled.away.score === null && !veiled.home.winner && !veiled.away.winner,
    `${label}: the veiled game ships no score and no winner`,
  );
  check(
    (veiled?.home.linescore.length ?? 1) === 0 && veiled?.home.record === null,
    `${label}: the veiled game ships no quarters and no record`,
  );
  check(g.games.find((x) => x.id === "401909875")?.home.score === 105, `${label}: the night before stays open`);
  const rec = teamRecord(all, "UTA", now);
  check(rec.wins === 1 && rec.losses === 3, `${label}: record 1-3 without last night, got ${rec.wins}-${rec.losses}`);
  check(rec.held === 1, `${label}: one game held`);
  check(rec.streak === "L2" && rec.recent.join("") === "LWLL", `${label}: streak and strip leave last night out`);
  check(rec.home[0] === 1 && rec.home[1] === 2, `${label}: the home split leaves last night out`);
  // Teams that didn't play last night aren't touched.
  const g2 = teamRecord(all, "MEM", now);
  check(g2.held === 0, `${label}: Memphis had no game held on Utah's schedule`);

  const r = guardRoster(roster, all, now);
  check(r.heldInjuries === 1, `${label}: one injury stamped since the tip is held, got ${r.heldInjuries}`);
  check(
    r.roster.players.find((p) => p.name === "Lauri Markkanen")?.injury === null,
    `${label}: Markkanen's update from after the tip is held`,
  );
  check(
    r.roster.players.find((p) => p.name === "Jaren Jackson Jr.")?.injury?.status === "Out",
    `${label}: an injury from before the tip stays`,
  );
}
check(guardRoster(roster, all, AT_7AM).heldInjuries === 0, "7 AM: no injury held");
const undated = {
  ...roster,
  players: roster.players.map((p, i) => (i === 0 ? { ...p, injury: { status: "Out", dateUtc: null } } : p)),
};
check(guardRoster(undated, all, AT_2AM).roster.players[0].injury === null, "an undated injury is held under guard");

// ── 6. athlete ────────────────────────────────────────────────────────────
const jokic = parseAthlete(load("athlete-3112335.json"));
check(jokic.id === "3112335" && jokic.name === "Nikola Jokic", `athlete 3112335 is Jokić, got ${jokic.name}`);
check(jokic.team?.tri === "DEN" && jokic.team.name === "Denver Nuggets", "Jokić plays for Denver");
check(jokic.jersey === "15" && jokic.pos === "C" && jokic.posName === "Center", "#15, C, Center");
check(jokic.draft === "2014: Rd 2, Pk 41 (DEN)", `draft line, got ${jokic.draft}`);
check(jokic.birthPlace === "Sombor, Serbia" && jokic.active, "born in Sombor, active");
const kessler = parseAthlete(load("athlete-4433136.json"));
check(kessler.team?.tri === "LAL", `Kessler is a Laker per the source, got ${kessler.team?.tri}`);

// ── 7. game log + averages ────────────────────────────────────────────────
const jlog = parseGamelog(load("gamelog-3112335.json"));
const jReg = jlog.games.filter((g) => g.seasonKind === "regular");
check(jReg.length === 4, `four regular-season games for Jokić, got ${jReg.length}`);
check(
  jlog.games.every((g, i) => i === 0 || jlog.games[i - 1].startUtc >= g.startUtc),
  "the game log is newest first",
);
const atNola = jlog.games.find((g) => g.gameId === "401909889");
check(
  atNola?.date === "2026-10-28" && atNola.opp === "NOP" && !atNola.home && atNola.tri === "DEN",
  "Jokić at New Orleans on the 28th",
);
check(
  atNola?.result === "W" && atNola.teamScore === 104 && atNola.oppScore === 91,
  "Denver won 104-91 at New Orleans",
);
check(
  atNola?.pts === 21 && atNola.reb === 13 && atNola.ast === 10 && atNola.min === 34 && atNola.fgm === 8 && atNola.fga === 13,
  "21/13/10 in 34 minutes on 8-13",
);
check(atNola?.ftm === 5 && atNola.fta === 5 && atNola.to === 7, "5-5 at the line, 7 turnovers");
const jAvg = averages(guardLog(jlog.games, AT_7AM));
check(jAvg?.gp === 4 && near(jAvg.pts, 22) && near(jAvg.reb, 10.5), `22.0 / 10.5 over four games (as ESPN), got ${jAvg?.pts}`);
const fgm = jReg.reduce((a, g) => a + g.fgm, 0);
const fga = jReg.reduce((a, g) => a + g.fga, 0);
check(near(jAvg?.fgPct ?? null, fgm / fga, 1e-9), "FG% is made over attempted, summed");
check(averages(guardLog(jlog.games, AT_7AM), "postseason") === null, "no playoff averages in October");

const klog = parseGamelog(load("gamelog-4433136.json"));
check(klog.games.length === 7, `Kessler: five regular + two preseason, got ${klog.games.length}`);
const atLac = klog.games.find((g) => g.gameId === "401909892");
check(atLac?.date === "2026-10-28" && atLac.opp === "LAC" && atLac.tri === "LAL" && !atLac.home, "Kessler's Lakers at the Clippers on the 28th");
for (const [label, now] of [
  ["11 PM", AT_11PM],
  ["2 AM", AT_2AM],
] as const) {
  const shown = guardLog(klog.games, now);
  const hidden = shown.filter((s) => s.hidden);
  check(hidden.length === 1 && hidden[0].line.gameId === "401909892", `${label}: only the Clippers game is hidden`);
  const h = hidden[0]?.line as Record<string, unknown> | undefined;
  check(
    !!h && !("pts" in h) && !("result" in h) && !("teamScore" in h) && !("min" in h),
    `${label}: a hidden line carries no result and no stats`,
  );
  check(!!h && h.opp === "LAC" && h.date === "2026-10-28", `${label}: a hidden line keeps its date and opponent`);
  const avg = averages(shown);
  check(avg?.gp === 4, `${label}: averages over the four shown regular-season games, got ${avg?.gp}`);
}
check(guardLog(klog.games, AT_7AM).every((s) => !s.hidden), "7 AM: no line hidden");
check(
  guardLog([{ ...klog.games[0], date: "" }], AT_7AM)[0].hidden,
  "a line with no readable date is hidden, not guessed open",
);

// ── 8. the parsers never read the source's own summaries ─────────────────
// Those carry last night's result past the guard (a record, a season line).
const code = (f: string) =>
  fs
    .readFileSync(path.join(ROOT, f), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
const teamsSrc = code("lib/hoops/scores/teams.ts");
for (const field of ["recordSummary", "standingSummary", "statsSummary", "totals", "summary"]) {
  check(!new RegExp(`[.?]${field}\\b`).test(teamsSrc), `teams.ts must not read .${field}`);
}
for (const page of [
  "app/hoops/scores/teams/[tri]/page.tsx",
  "app/hoops/scores/teams/[tri]/schedule/page.tsx",
]) {
  const src = code(page);
  check(/guardGames\(/.test(src), `${page} veils guarded games`);
}
check(/teamRecord\(/.test(code("app/hoops/scores/teams/[tri]/page.tsx")), "the team page counts its own record");
check(/guardRoster\(/.test(code("app/hoops/scores/teams/[tri]/page.tsx")), "the team page guards injuries");
check(/guardLog\(/.test(code("app/hoops/scores/players/[id]/page.tsx")), "the player page guards the log");

// ── 9. broken payloads throw rather than render empty ────────────────────
const throws = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
check(throws(() => parseRoster({ error: "nope" }, "UTA")), "a roster without athletes throws");
check(throws(() => parseTeamSchedule({}, "UTA")), "a schedule with no events and no team throws");
check(throws(() => parseAthlete({ athlete: {} })), "an athlete without an id throws");
check(throws(() => parseGamelog({ names: [] })), "a game log without seasonTypes throws");
check(throws(() => parseGamelog(null)), "a null game log throws");

if (problems.length) {
  console.error(`check:hoops:teams — ${problems.length} problem(s):`);
  for (const m of problems) console.error(`  ✗ ${m}`);
  process.exit(1);
}
console.log(`check:hoops:teams — ${passed} assertions passed over ${fs.readdirSync(FIX).filter((f) => f.endsWith(".json")).length} recorded ESPN responses`);
