// Pure parsers for the team, player and schedule pages — no fetch, no fs, no
// SQLite. Same upstream and the same defensive rules as parse.ts:
//
//   roster    site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/<id>/roster
//   schedule  site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/<id>/schedule?seasontype=<1|2|3>
//   athlete   site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/<id>
//   gamelog   site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/<id>/gamelog
//
// A missing field becomes null / zero / an empty list; a payload with no
// recognisable top level throws, so a broken response never renders as an
// empty roster or a team with no games. Stat columns are read BY NAME off the
// game log's own `names`, never by index. scripts/check-hoops-teams.ts drives
// these over recorded responses in hoops-teams-fixture/.
//
// 🔴 What these parsers deliberately do NOT read, because it would carry a
// result past the spoiler guard (guard.ts): the schedule's `team.recordSummary`
// and `standingSummary`, the athlete's `statsSummary`, the game log's season
// `summary` averages and per-month `totals`. Records and averages are computed
// from the individual games instead, so a guarded game can be left out.

import { FRANCHISES } from "../nba-franchises.ts";
import { todayIn } from "./dates.ts";
import { canonicalTri, parseCompetition } from "./parse.ts";
import type {
  Game,
  PlayerBio,
  PlayerGameLine,
  PlayerLog,
  Roster,
  RosterPlayer,
  SeasonKind,
  TeamSchedule,
} from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/** ESPN's numeric team ids, by canonical tri — the key every team URL on
 *  ESPN's site API takes. An external fact, like nba-franchises.ts. */
export const ESPN_TEAM_IDS: Record<string, string> = {
  ATL: "1", BOS: "2", NOP: "3", CHI: "4", CLE: "5", DAL: "6", DEN: "7", DET: "8",
  GSW: "9", HOU: "10", IND: "11", LAC: "12", LAL: "13", MIA: "14", MIL: "15", MIN: "16",
  BKN: "17", NYK: "18", ORL: "19", PHI: "20", PHX: "21", POR: "22", SAC: "23", SAS: "24",
  OKC: "25", UTA: "26", WAS: "27", TOR: "28", MEM: "29", CHA: "30",
};

const TRI_BY_ESPN_ID: Record<string, string> = Object.fromEntries(
  Object.entries(ESPN_TEAM_IDS).map(([tri, id]) => [id, tri]),
);

/** "uta" / "UTA" / "utah" → "UTA"; null for anything that isn't one of the 30. */
export function teamFromSlug(slug: string): string | null {
  const tri = canonicalTri(slug);
  return FRANCHISES[tri] && ESPN_TEAM_IDS[tri] ? tri : null;
}

export const triForEspnId = (id: string): string | null => TRI_BY_ESPN_ID[id] ?? null;

/** The Mountain date a game is listed under — the scores URL's date. ESPN
 *  lists by Eastern date, which equals Mountain for every NBA tip. */
export function gameDate(startUtc: string): string {
  const t = new Date(startUtc);
  return Number.isNaN(t.getTime()) ? "" : todayIn(t);
}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s ? s : null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
};

/** "8-13" → [8, 13]. */
const madeAtt = (v: unknown): [number, number] => {
  const m = /^(\d+)-(\d+)$/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

function seasonKindOf(t: unknown): SeasonKind {
  const n = int(t);
  if (n === 1) return "preseason";
  if (n === 2) return "regular";
  if (n === 3 || n === 5) return "postseason";
  return "other";
}

// ── roster ─────────────────────────────────────────────────────────────────

function rosterPlayer(a: J): RosterPlayer {
  const inj: J[] = Array.isArray(a?.injuries) ? a.injuries : [];
  const first = inj.find((i) => str(i?.status));
  return {
    id: String(a?.id ?? ""),
    name: str(a?.displayName) ?? str(a?.fullName) ?? "Unknown",
    jersey: str(a?.jersey),
    pos: str(a?.position?.abbreviation),
    height: str(a?.displayHeight),
    weight: str(a?.displayWeight),
    age: num(a?.age),
    experience: num(a?.experience?.years),
    college: str(a?.college?.shortName) ?? str(a?.college?.name),
    injury: first ? { status: String(first.status).trim(), dateUtc: str(first.date) } : null,
  };
}

/** Jersey order, the way a roster reads on a scorecard ("00" before "0"
 *  before "1"); players with no number last, by name. */
function byJersey(a: RosterPlayer, b: RosterPlayer): number {
  const ja = a.jersey, jb = b.jersey;
  if (ja === null || jb === null) return ja === jb ? a.name.localeCompare(b.name) : ja === null ? 1 : -1;
  return Number(ja) - Number(jb) || jb.length - ja.length || a.name.localeCompare(b.name);
}

export function parseRoster(raw: J, tri: string): Roster {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.athletes)) {
    throw new Error("roster: no athletes array — not a roster response");
  }
  // The team's endpoint lists athletes flat; an older shape grouped them
  // ({position, items:[…]}) — read both.
  const flat: J[] = raw.athletes.flatMap((a: J) => (Array.isArray(a?.items) ? a.items : [a]));
  const coaches: J[] = Array.isArray(raw.coach) ? raw.coach : [];
  const coach = coaches[0] ? [str(coaches[0].firstName), str(coaches[0].lastName)].filter(Boolean).join(" ") : "";
  return {
    tri,
    espnId: String(raw.team?.id ?? ESPN_TEAM_IDS[tri] ?? ""),
    season: str(raw.season?.displayName),
    players: flat.map(rosterPlayer).filter((p) => p.id).sort(byJersey),
    coach: coach || null,
  };
}

// ── schedule ───────────────────────────────────────────────────────────────

/** One schedule event → a Game, through the scoreboard's own parser. The
 *  schedule differs in two places: a competitor's score is an object
 *  ({value, displayValue}) rather than a string, and the season type sits on
 *  the event's `seasonType`, not `season.type`. */
function scheduleGame(ev: J): Game | null {
  const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
  if (!comp) return null;
  const competitors: J[] = Array.isArray(comp.competitors) ? comp.competitors : [];
  const normalised = {
    ...comp,
    competitors: competitors.map((c) => ({
      ...c,
      score:
        c?.score && typeof c.score === "object"
          ? str(c.score.displayValue) ?? (num(c.score.value) === null ? null : String(num(c.score.value)))
          : c?.score,
    })),
  };
  return parseCompetition(normalised, {
    ...ev,
    season: { ...(ev?.season ?? {}), type: ev?.seasonType?.type ?? ev?.seasonType?.id ?? ev?.season?.type },
  });
}

export function parseTeamSchedule(raw: J, tri: string): TeamSchedule {
  if (!raw || typeof raw !== "object" || (!Array.isArray(raw.events) && !raw.team)) {
    throw new Error("schedule: no events and no team — not a schedule response");
  }
  const events: J[] = Array.isArray(raw.events) ? raw.events : [];
  const games = events
    .map(scheduleGame)
    .filter((g): g is Game => g !== null && g.id !== "")
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.id.localeCompare(b.id));
  return {
    tri,
    espnId: String(raw.team?.id ?? ESPN_TEAM_IDS[tri] ?? ""),
    season: str(raw.season?.displayName),
    games,
  };
}

/** Several season types' schedules as one list, oldest first, each game once. */
export function mergeSchedules(parts: TeamSchedule[]): Game[] {
  const seen = new Map<string, Game>();
  for (const p of parts) for (const g of p.games) if (!seen.has(g.id)) seen.set(g.id, g);
  return [...seen.values()].sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.id.localeCompare(b.id));
}

/** Which side of a game `tri` is on; null when it isn't in it. */
export function sideOf(g: Game, tri: string): "home" | "away" | null {
  return g.home.tri === tri ? "home" : g.away.tri === tri ? "away" : null;
}

// ── athlete ────────────────────────────────────────────────────────────────

export function parseAthlete(raw: J): PlayerBio {
  const a = raw?.athlete;
  if (!a || typeof a !== "object" || !a.id) throw new Error("athlete: no athlete — not an athlete response");
  const t = a.team;
  const tri = t?.abbreviation ? canonicalTri(t.abbreviation) : null;
  return {
    id: String(a.id),
    name: str(a.displayName) ?? str(a.fullName) ?? "Unknown",
    jersey: str(a.jersey),
    pos: str(a.position?.abbreviation),
    posName: str(a.position?.displayName),
    team:
      tri && t?.id
        ? { tri, espnId: String(t.id), name: FRANCHISES[tri]?.name ?? str(t.displayName) ?? tri }
        : null,
    height: str(a.displayHeight),
    weight: str(a.displayWeight),
    age: num(a.age),
    experience: str(a.displayExperience),
    draft: str(a.displayDraft),
    birthPlace: str(a.displayBirthPlace),
    active: a.active !== false,
  };
}

// ── game log ───────────────────────────────────────────────────────────────

function kindFromLabel(label: unknown): SeasonKind {
  const s = String(label ?? "").toLowerCase();
  if (s.includes("preseason")) return "preseason";
  if (s.includes("postseason") || s.includes("playoff") || s.includes("play-in")) return "postseason";
  if (s.includes("regular")) return "regular";
  return "other";
}

/**
 * The game log: one line per game the player appeared in, newest first.
 * Game facts (date, opponent, result) come from the top-level `events` map;
 * the stat row from `seasonTypes[].categories[].events[]`, mapped through the
 * response's own `names` array.
 */
export function parseGamelog(raw: J): PlayerLog {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.names) || !Array.isArray(raw.seasonTypes)) {
    throw new Error("gamelog: no names / seasonTypes — not a game log response");
  }
  const names: string[] = raw.names.map((n: unknown) => String(n));
  const col = (stats: unknown[], name: string): unknown => {
    const i = names.indexOf(name);
    return i < 0 ? undefined : stats[i];
  };
  const events: Record<string, J> = raw.events && typeof raw.events === "object" ? raw.events : {};
  const out: PlayerGameLine[] = [];
  const seen = new Set<string>();
  for (const st of raw.seasonTypes as J[]) {
    const kind = kindFromLabel(st?.displayName);
    for (const cat of Array.isArray(st?.categories) ? st.categories : []) {
      if (cat?.type && cat.type !== "event") continue;
      for (const row of Array.isArray(cat?.events) ? cat.events : []) {
        const id = String(row?.eventId ?? "");
        const ev = events[id];
        if (!id || !ev || seen.has(id)) continue;
        seen.add(id);
        const stats: unknown[] = Array.isArray(row?.stats) ? row.stats : [];
        const [fgm, fga] = madeAtt(col(stats, "fieldGoalsMade-fieldGoalsAttempted"));
        const [tpm, tpa] = madeAtt(col(stats, "threePointFieldGoalsMade-threePointFieldGoalsAttempted"));
        const [ftm, fta] = madeAtt(col(stats, "freeThrowsMade-freeThrowsAttempted"));
        const teamId = String(ev?.team?.id ?? "");
        const home = String(ev?.homeTeamId ?? "") === teamId && teamId !== "";
        const hs = num(ev?.homeTeamScore);
        const as = num(ev?.awayTeamScore);
        const res = ev?.gameResult === "W" || ev?.gameResult === "L" ? ev.gameResult : null;
        const startUtc = String(ev?.gameDate ?? "");
        out.push({
          gameId: id,
          startUtc,
          date: gameDate(startUtc),
          seasonKind: kind,
          tri: canonicalTri(ev?.team?.abbreviation ?? ""),
          home,
          opp: canonicalTri(ev?.opponent?.abbreviation ?? ""),
          result: res,
          teamScore: home ? hs : as,
          oppScore: home ? as : hs,
          min: int(col(stats, "minutes")),
          pts: int(col(stats, "points")),
          reb: int(col(stats, "totalRebounds")),
          ast: int(col(stats, "assists")),
          stl: int(col(stats, "steals")),
          blk: int(col(stats, "blocks")),
          to: int(col(stats, "turnovers")),
          pf: int(col(stats, "fouls")),
          fgm, fga, tpm, tpa, ftm, fta,
        });
      }
    }
  }
  out.sort((a, b) => b.startUtc.localeCompare(a.startUtc) || b.gameId.localeCompare(a.gameId));
  return { games: out };
}
