// Pure parsers for ESPN's public NBA JSON — no fetch, no fs, no SQLite.
//
//   scoreboard  site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD
//   summary     site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=<id>
//   standings   site.api.espn.com/apis/v2/sports/basketball/nba/standings
//
// Undocumented endpoints, so every read is defensive: a missing field becomes
// a null / zero / empty list, never a throw — a shape change must cost a
// column on a page, not the page. The one thing that DOES throw is a payload
// with no recognisable top level at all (not an object, no `events`), because
// silently rendering "no games" for a broken response would read as an off day.
// scripts/check-hoops-scores.ts drives these over recorded responses in
// hoops-scores-fixture/.

import { FRANCHISES } from "../nba-franchises.ts";
import type {
  Broadcasts,
  Game,
  GameBox,
  GameState,
  PlayerBoxLine,
  SeasonKind,
  StandingRow,
  Standings,
  Scoreboard,
  TeamBoxScore,
  TeamLine,
  TeamTotals,
} from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/** ESPN's short codes that differ from the canonical tri. */
const ESPN_TRI: Record<string, string> = {
  GS: "GSW",
  NO: "NOP",
  NY: "NYK",
  SA: "SAS",
  UTAH: "UTA",
  WSH: "WAS",
};

export function canonicalTri(espnAbbr: string): string {
  const a = (espnAbbr ?? "").toUpperCase();
  return ESPN_TRI[a] ?? a;
}

/** Display name: the franchise list wins (so names match the rest of Hoops),
 *  ESPN's own for anything not in it. */
function nameFor(tri: string, fallback: string | undefined): string {
  return FRANCHISES[tri]?.name ?? fallback ?? tri;
}

const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
};

/** "44-90" → [44, 90]. */
const madeAtt = (v: unknown): [number, number] => {
  const m = /^(\d+)-(\d+)$/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

function stateOf(type: J): GameState {
  const s = type?.state;
  return s === "in" || s === "post" ? s : "pre";
}

function seasonKindOf(t: unknown): SeasonKind {
  // ESPN season types: 1 preseason, 2 regular, 3 postseason (5 = play-in).
  const n = int(t);
  if (n === 1) return "preseason";
  if (n === 2) return "regular";
  if (n === 3 || n === 5) return "postseason";
  return "other";
}

/** Both payload shapes: the scoreboard's `[{market:"home", names:[…]}]` and
 *  the summary header's `[{market:{type:"National"}, media:{shortName}}]`. */
export function parseBroadcasts(list: J): Broadcasts {
  const out: Broadcasts = { national: [], home: [], away: [] };
  if (!Array.isArray(list)) return out;
  const push = (bucket: keyof Broadcasts, name: unknown) => {
    const s = String(name ?? "").trim();
    if (s && !out[bucket].includes(s)) out[bucket].push(s);
  };
  for (const b of list) {
    const market = String(
      typeof b?.market === "string" ? b.market : b?.market?.type ?? "",
    ).toLowerCase();
    const bucket: keyof Broadcasts =
      market === "home" ? "home" : market === "away" ? "away" : "national";
    if (Array.isArray(b?.names)) for (const n of b.names) push(bucket, n);
    else push(bucket, b?.media?.shortName);
  }
  return out;
}

/** What the scores list prints in the TV column: the national network when
 *  there is one, otherwise the local feeds (League Pass is implied). */
export function tvLabel(tv: Broadcasts): string {
  if (tv.national.length) return tv.national.filter((n) => n !== "NBA League Pass").join(", ") || "League Pass";
  return "League Pass";
}

function overallRecord(c: J): string | null {
  // scoreboard: records[{type:"total", summary}]; summary header: record[…].
  const list: J[] = Array.isArray(c?.records) ? c.records : Array.isArray(c?.record) ? c.record : [];
  const total = list.find((r) => r?.type === "total") ?? list[0];
  const s = total?.summary ?? total?.displayValue;
  return typeof s === "string" && s ? s : null;
}

function parseTeamLine(c: J, state: GameState): TeamLine {
  const team = c?.team ?? {};
  const tri = canonicalTri(team.abbreviation);
  const linescore = Array.isArray(c?.linescores)
    ? c.linescores.map((l: J) => int(l?.value ?? l?.displayValue))
    : [];
  return {
    tri,
    espnId: String(team.id ?? c?.id ?? ""),
    name: nameFor(tri, team.displayName),
    nickname: String(team.name ?? team.shortDisplayName ?? tri),
    score: state === "pre" || c?.score == null || c.score === "" ? null : int(c.score),
    linescore,
    record: overallRecord(c),
    winner: c?.winner === true,
  };
}

/** One competition → a Game. `event` supplies id/date/season when the
 *  competition itself doesn't (the scoreboard nests; the summary header
 *  doesn't). */
export function parseCompetition(comp: J, event: J = {}): Game {
  const status = comp?.status ?? event?.status ?? {};
  const type = status.type ?? {};
  const state = stateOf(type);
  const comps: J[] = Array.isArray(comp?.competitors) ? comp.competitors : [];
  const home = comps.find((c) => c?.homeAway === "home") ?? comps[0];
  const away = comps.find((c) => c?.homeAway === "away") ?? comps[1];
  const seasonKind = seasonKindOf(event?.season?.type ?? comp?.season?.type);
  const notes: J[] = Array.isArray(comp?.notes) ? comp.notes : [];
  const note = notes.map((n) => n?.headline).find((h) => typeof h === "string" && h) ?? null;
  const name = String(type.name ?? "");
  return {
    id: String(comp?.id ?? event?.id ?? ""),
    startUtc: String(comp?.date ?? event?.date ?? ""),
    state,
    statusDetail: String(type.shortDetail ?? type.detail ?? type.description ?? ""),
    period: int(status.period),
    clock: typeof status.displayClock === "string" ? status.displayClock : null,
    postponed: /POSTPONED|CANCELED|SUSPENDED/.test(name),
    away: parseTeamLine(away, state),
    home: parseTeamLine(home, state),
    tv: parseBroadcasts(comp?.broadcasts),
    seasonKind,
    note,
    series:
      seasonKind === "postseason" && typeof comp?.series?.summary === "string"
        ? comp.series.summary
        : null,
  };
}

export function parseScoreboard(raw: J, date: string): Scoreboard {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.events)) {
    throw new Error("scoreboard: no events array — not a scoreboard response");
  }
  const games: Game[] = [];
  for (const ev of raw.events) {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
    if (comp) games.push(parseCompetition(comp, ev));
  }
  games.sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.id.localeCompare(b.id));
  return { date, games };
}

const ZERO_TOTALS: TeamTotals = {
  pts: 0, reb: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0,
  fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
};

/** Map one positional stat array onto named fields via the block's `names`
 *  (MIN PTS FG 3PT FT REB AST TO STL BLK OREB DREB PF +/-). Read by NAME,
 *  never by index, so a reordered column can't put rebounds under assists. */
function statsByName(names: string[], vals: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  names.forEach((n, i) => {
    out[String(n).toUpperCase()] = String(vals[i] ?? "");
  });
  return out;
}

function totalsFrom(v: Record<string, string>): TeamTotals {
  const [fgm, fga] = madeAtt(v.FG);
  const [tpm, tpa] = madeAtt(v["3PT"]);
  const [ftm, fta] = madeAtt(v.FT);
  return {
    pts: int(v.PTS), reb: int(v.REB), oreb: int(v.OREB), dreb: int(v.DREB),
    ast: int(v.AST), stl: int(v.STL), blk: int(v.BLK), to: int(v.TO), pf: int(v.PF),
    fgm, fga, tpm, tpa, ftm, fta,
  };
}

function parsePlayer(a: J, names: string[]): PlayerBoxLine {
  const stats: unknown[] = Array.isArray(a?.stats) ? a.stats : [];
  const dnp = a?.didNotPlay === true || stats.length === 0;
  const v = statsByName(names, stats);
  const t = totalsFrom(v);
  const pm = String(v["+/-"] ?? "").trim();
  return {
    id: String(a?.athlete?.id ?? ""),
    name: String(a?.athlete?.displayName ?? a?.athlete?.shortName ?? "Unknown"),
    starter: a?.starter === true,
    dnp,
    // ESPN stamps "COACH'S DECISION" on every row, played or not, so the
    // reason is only meaningful for a DNP.
    dnpReason: dnp && typeof a?.reason === "string" && a.reason ? a.reason : null,
    ejected: a?.ejected === true,
    min: int(v.MIN),
    ...t,
    plusMinus: pm === "" ? null : int(pm.replace(/^\+/, "")),
  };
}

export function parseSummary(raw: J): GameBox {
  const comp = raw?.header?.competitions?.[0];
  if (!comp) throw new Error("summary: no header competition — not a summary response");
  const game = parseCompetition(comp, raw.header);

  const teams: TeamBoxScore[] = [];
  const blocks: J[] = Array.isArray(raw?.boxscore?.players) ? raw.boxscore.players : [];
  const sides: J[] = Array.isArray(raw?.boxscore?.teams) ? raw.boxscore.teams : [];
  for (const block of blocks) {
    const st = Array.isArray(block?.statistics) ? block.statistics[0] : null;
    if (!st) continue;
    const names: string[] = Array.isArray(st.names) ? st.names : Array.isArray(st.labels) ? st.labels : [];
    const athletes: J[] = Array.isArray(st.athletes) ? st.athletes : [];
    const all = athletes.map((a) => parsePlayer(a, names));
    // Starters first, then the bench in the source's order, then DNPs.
    const players = [
      ...all.filter((p) => p.starter && !p.dnp),
      ...all.filter((p) => !p.starter && !p.dnp),
      ...all.filter((p) => p.dnp),
    ];
    const tri = canonicalTri(block?.team?.abbreviation);
    const side = sides.find((s) => String(s?.team?.id) === String(block?.team?.id));
    const homeAway: "home" | "away" =
      side?.homeAway === "home" || side?.homeAway === "away"
        ? side.homeAway
        : tri === game.home.tri
          ? "home"
          : "away";
    const totals = Array.isArray(st.totals) && st.totals.length
      ? totalsFrom(statsByName(names, st.totals))
      : { ...ZERO_TOTALS };
    teams.push({ tri, name: nameFor(tri, block?.team?.displayName), homeAway, players, totals });
  }
  teams.sort((a, b) => (a.homeAway === b.homeAway ? 0 : a.homeAway === "away" ? -1 : 1));
  return { game, teams };
}

export function parseStandings(raw: J): Standings {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.children)) {
    throw new Error("standings: no children array — not a standings response");
  }
  const conferences = raw.children.map((conf: J) => {
    const entries: J[] = Array.isArray(conf?.standings?.entries) ? conf.standings.entries : [];
    const rows: StandingRow[] = entries.map((e) => {
      const stats: J[] = Array.isArray(e?.stats) ? e.stats : [];
      const byType = (t: string) => stats.find((s) => s?.type === t);
      const disp = (t: string) => {
        const s = byType(t);
        return String(s?.summary ?? s?.displayValue ?? "");
      };
      const tri = canonicalTri(e?.team?.abbreviation);
      const seed = byType("playoffseed");
      return {
        tri,
        name: nameFor(tri, e?.team?.displayName),
        seed: seed ? int(seed.value ?? seed.displayValue) || null : null,
        wins: int(byType("wins")?.value ?? byType("wins")?.displayValue),
        losses: int(byType("losses")?.value ?? byType("losses")?.displayValue),
        pct: disp("winpercent") || ".000",
        gb: disp("gamesbehind") || "-",
        l10: disp("lasttengames") || "0-0",
        streak: disp("streak") || "-",
        home: disp("home"),
        road: disp("road"),
      };
    });
    return { name: String(conf?.name ?? conf?.abbreviation ?? "Conference"), rows: sortStandings(rows) };
  });
  return {
    season: typeof raw?.season?.displayName === "string" ? raw.season.displayName : null,
    conferences,
  };
}

/** ESPN's entry order is not the table order. Sort by the playoff seed it
 *  computes (tiebreakers included) when every row has one — seeds TIE early
 *  in the season, so then by win percentage, wins, and tri for a stable
 *  table. */
export function sortStandings(rows: StandingRow[]): StandingRow[] {
  const seeded = rows.every((r) => r.seed != null);
  const pct = (r: StandingRow) => (r.wins + r.losses ? r.wins / (r.wins + r.losses) : 0);
  return [...rows].sort(
    (a, b) =>
      (seeded ? (a.seed as number) - (b.seed as number) : 0) ||
      pct(b) - pct(a) ||
      b.wins - a.wins ||
      a.tri.localeCompare(b.tri),
  );
}

/** "atl-orl" — away-home, lowercase tri, the box score URL's last segment
 *  (plaintextsports' shape). Unique per date for real NBA games. */
export function gameSlug(g: Pick<Game, "away" | "home">): string {
  return `${g.away.tri}-${g.home.tri}`.toLowerCase();
}
