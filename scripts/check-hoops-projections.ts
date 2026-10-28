#!/usr/bin/env node
//
// THE REST-OF-SEASON PROJECTION — the receiver half of `season_projection`.
//
//   npm run check:hoops:projections   (standalone)
//   npm run build                     (runs via prebuild)
//
// WHAT THIS PROVES. hoops-sim publishes a nightly projections.json (projected
// record, 80% win band, playoff / play-in / title odds per team) and
// /hoops/projections renders it. The ways it can quietly go wrong all render
// as a plausible-looking table:
//
//   • the validator lets a malformed file through — a percentage where a
//     fraction was promised, a team missing or doubled, a title chance above
//     the finals chance it depends on, a date that is not a date — and the
//     page shows it as if it meant something,
//   • a bundle WITHOUT the token stops importing (the receiver-first deploy
//     order makes that the sender's outage, on this receiver's deploy),
//   • a bundle WITH the token but no file is accepted and the page goes blank,
//   • the importer drops the file on the floor, or truncates the last
//     projection on a push that carries none,
//   • the page orders the table by something other than projected wins.
//
// Second source: the arithmetic of an NBA season, written down here a second
// time and asserted over the raw fixture WITHOUT going through the validator
// (one champion, two finalists, eight playoff teams a conference, 1,230 wins,
// the conference every franchise actually plays in per nba-franchises.ts),
// so the fixture is anchored on facts independent of the code under test.
//
// Falsification at merge (2026-10-28): see CLAUDE.md's Projections section
// for the tally.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  FEATURE_FILES,
  SUPPORTED_FEATURES,
  checkFeatureFiles,
  checkFeatures,
  ContractRejection,
  describeContract,
} from "../lib/hoops/contract.ts";
import { FRANCHISES } from "../lib/hoops/nba-franchises.ts";
import {
  GAMES_PER_TEAM,
  LEAGUE_WINS,
  NEST_EPS,
  N_TEAMS,
  ProjectionRejection,
  conferenceTable,
  fmtAsOf,
  fmtPct,
  fmtProjRecord,
  fmtWinRange,
  isCalendarDate,
  orderForTable,
  validateProjections,
} from "../lib/hoops/projections.ts";
import type { HoopsBundle, RawProjectionsFile, RawProjectionTeam } from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "hoops-data", "hoops_projections_fixture.json");

const problems: string[] = [];
const notes: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) problems.push(msg);
};

const fixtureRaw = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as RawProjectionsFile;
/** A deep copy to damage. */
const clone = (): RawProjectionsFile => JSON.parse(JSON.stringify(fixtureRaw));

// ── 1. the contract: the token is accepted, the file is demanded with it ──
{
  check(SUPPORTED_FEATURES.has("season_projection"), "SUPPORTED_FEATURES lacks season_projection");
  check(
    (FEATURE_FILES.season_projection ?? []).includes("projections.json"),
    "FEATURE_FILES does not tie season_projection to projections.json",
  );
  let rejected: string | null = null;
  try {
    checkFeatures(["symmetric_off_def", "absorption", "fictional_values", "season_projection"]);
  } catch (err) {
    rejected = (err as Error).message;
  }
  check(rejected === null, `checkFeatures rejected the token: ${rejected}`);

  // Token without file -> REJECT, naming both.
  let msg = "";
  try {
    checkFeatureFiles(["season_projection"], { "hoops_params.json": {} });
  } catch (err) {
    msg = err instanceof ContractRejection ? err.message : `wrong error type: ${String(err)}`;
  }
  check(
    /season_projection/.test(msg) && /projections\.json/.test(msg),
    `token without the file was not refused naming both — got "${msg}"`,
  );
  // Token with file -> fine.
  let ok = true;
  try {
    checkFeatureFiles(["season_projection"], { "projections.json": fixtureRaw });
  } catch {
    ok = false;
  }
  check(ok, "checkFeatureFiles refused a bundle that carries projections.json");
  // 🔴 No token, no file -> fine: that is every bundle the sender publishes
  // today, and the receiver-first deploy order rests on it still importing.
  ok = true;
  try {
    checkFeatureFiles(["symmetric_off_def", "absorption", "fictional_values"], {});
  } catch {
    ok = false;
  }
  check(ok, "a v1 bundle (no token, no projections.json) was refused by checkFeatureFiles");

  // The discovery answer carries the token and the file rule, read off the
  // real tables rather than retyped.
  const d = describeContract();
  check(d.features.includes("season_projection"), "describeContract() does not list season_projection");
  check(
    (d.feature_files.season_projection ?? []).includes("projections.json"),
    "describeContract() does not say season_projection needs projections.json",
  );
  check(d.pricing_version >= 3 && d.wire_version >= 1, "describeContract() versions look wrong");
  notes.push("contract: token accepted, file demanded with it, a v1 bundle untouched, discovery lists both");
}

// ── 2. the fixture is anchored on NBA arithmetic, longhand ────────────────
{
  const teams = fixtureRaw.teams;
  const sum = (f: keyof RawProjectionTeam, rows = teams) => rows.reduce((a, r) => a + (r[f] as number), 0);
  check(teams.length === N_TEAMS && N_TEAMS === 30, `fixture has ${teams.length} teams`);
  const tris = new Set(teams.map((t) => t.team));
  check(tris.size === 30, "fixture repeats a team");
  for (const t of teams) {
    const f = FRANCHISES[t.team];
    check(!!f, `fixture names ${t.team}, not an NBA franchise`);
    check(f?.conference === t.conference, `fixture puts ${t.team} in the ${t.conference}`);
    check(t.wins + t.losses <= GAMES_PER_TEAM, `${t.team} has played more than 82`);
  }
  check(Math.abs(sum("title_pct") - 1) < 0.05, `one champion: title_pct sums to ${sum("title_pct")}`);
  check(Math.abs(sum("finals_pct") - 2) < 0.05, `two finalists: finals_pct sums to ${sum("finals_pct")}`);
  check(Math.abs(sum("proj_wins") - LEAGUE_WINS) < 2, `1,230 wins: proj_wins sums to ${sum("proj_wins")}`);
  check(sum("wins") === sum("losses"), "games played so far: wins != losses");
  for (const conf of ["East", "West"] as const) {
    const rows = teams.filter((t) => t.conference === conf);
    check(rows.length === 15, `${conf} has ${rows.length} teams`);
    check(Math.abs(sum("playoff_pct", rows) - 8) < 0.05, `${conf}: eight playoff teams, got ${sum("playoff_pct", rows)}`);
    check(Math.abs(sum("top6_pct", rows) - 6) < 0.05, `${conf}: six top-6 seeds, got ${sum("top6_pct", rows)}`);
    check(Math.abs(sum("playin_pct", rows) - 4) < 0.05, `${conf}: four play-in teams, got ${sum("playin_pct", rows)}`);
  }
  // And the validator agrees with the arithmetic.
  let accepted: RawProjectionsFile | null = null;
  try {
    accepted = validateProjections(fixtureRaw);
  } catch (err) {
    check(false, `the validator REFUSED the contract fixture: ${(err as Error).message}`);
  }
  check(accepted?.teams.length === 30, "validator returned the wrong team count");
  notes.push("fixture: 30 franchises in their real conferences, one champion, 8 playoff teams a conference, 1,230 wins; validator accepts it");
}

// ── 3. every damage pattern is refused, naming the problem ────────────────
{
  type Probe = { name: string; damage: (f: RawProjectionsFile) => unknown; expect: RegExp };
  const team = (f: RawProjectionsFile, tri: string) => f.teams.find((t) => t.team === tri)!;
  const probes: Probe[] = [
    { name: "not an object", damage: () => "nope", expect: /expected an object/ },
    { name: "teams not an array", damage: (f) => ({ ...f, teams: {} }), expect: /teams must be an array/ },
    {
      name: "missing team",
      damage: (f) => ({ ...f, teams: f.teams.filter((t) => t.team !== "DEN") }),
      expect: /expected 30 teams, got 29/,
    },
    {
      name: "duplicate team (WAS replaced by a second ATL, still 30 rows)",
      damage: (f) => {
        const was = team(f, "WAS");
        const atl = team(f, "ATL");
        Object.assign(was, { ...atl });
        return f;
      },
      expect: /ATL appears more than once/,
    },
    {
      name: "31 teams, one unknown",
      damage: (f) => ({ ...f, teams: [...f.teams, { ...team(f, "DEN"), team: "SEA" }] }),
      expect: /expected 30 teams, got 31/,
    },
    {
      name: "unknown tri in place of a real one",
      damage: (f) => {
        team(f, "DEN").team = "SEA";
        return f;
      },
      expect: /unknown tri code "SEA"/,
    },
    {
      name: "wrong conference",
      damage: (f) => {
        team(f, "ATL").conference = "West";
        return f;
      },
      expect: /ATL: conference "West" but Atlanta Hawks play in the East/,
    },
    {
      name: "probability > 1 (a percentage shipped where a fraction was promised)",
      damage: (f) => {
        team(f, "OKC").playoff_pct = 98.5;
        return f;
      },
      expect: /OKC: playoff_pct must be a probability in \[0, 1\]/,
    },
    {
      name: "negative probability",
      damage: (f) => {
        team(f, "OKC").title_pct = -0.01;
        return f;
      },
      expect: /OKC: title_pct must be a probability/,
    },
    {
      name: "title > finals",
      damage: (f) => {
        const t = team(f, "OKC");
        t.title_pct = Math.min(1, t.finals_pct + 0.05);
        return f;
      },
      expect: /OKC: title_pct .* exceeds finals_pct/,
    },
    {
      name: "finals > conf_finals",
      damage: (f) => {
        const t = team(f, "OKC");
        t.finals_pct = Math.min(1, t.conf_finals_pct + 0.05);
        return f;
      },
      expect: /OKC: finals_pct .* exceeds conf_finals_pct/,
    },
    {
      name: "conf_finals > playoff",
      damage: (f) => {
        const t = team(f, "WAS");
        t.conf_finals_pct = Math.min(1, t.playoff_pct + 0.05);
        return f;
      },
      expect: /WAS: conf_finals_pct .* exceeds playoff_pct/,
    },
    {
      name: "top6 > playoff",
      damage: (f) => {
        const t = team(f, "WAS");
        t.top6_pct = Math.min(1, t.playoff_pct + 0.05);
        return f;
      },
      expect: /WAS: top6_pct .* exceeds playoff_pct/,
    },
    {
      name: "top6 + playin > 1",
      damage: (f) => {
        const t = team(f, "OKC");
        t.playin_pct = 0.5;
        t.top6_pct = 0.6;
        t.playoff_pct = 1;
        return f;
      },
      expect: /OKC: top6_pct \+ playin_pct = .* > 1/,
    },
    {
      name: "bad date: Feb 30",
      damage: (f) => ({ ...f, as_of_date: "2026-02-30" }),
      expect: /as_of_date must be a real YYYY-MM-DD date/,
    },
    {
      name: "bad date: wrong format",
      damage: (f) => ({ ...f, as_of_date: "10/27/2026" }),
      expect: /as_of_date must be a real YYYY-MM-DD date/,
    },
    {
      name: "bad generated_at",
      damage: (f) => ({ ...f, generated_at: "last night" }),
      expect: /generated_at must be an ISO-8601 timestamp/,
    },
    { name: "zero replicates", damage: (f) => ({ ...f, replicates: 0 }), expect: /replicates must be a positive integer/ },
    { name: "empty method", damage: (f) => ({ ...f, method: "  " }), expect: /method must be a non-empty string/ },
    {
      name: "wins + losses > 82",
      damage: (f) => {
        const t = team(f, "DEN");
        t.wins = 60;
        t.losses = 30;
        return f;
      },
      expect: /DEN: 60-30 is 90 games/,
    },
    {
      name: "proj_wins below wins already banked",
      damage: (f) => {
        const t = team(f, "DEN");
        t.wins = 4;
        t.losses = 0;
        t.proj_wins = 3.5;
        t.proj_losses = 78.5;
        return f;
      },
      expect: /DEN: proj_wins 3.5 is below the 4 already won/,
    },
    {
      name: "proj_wins + proj_losses != 82",
      damage: (f) => {
        const t = team(f, "DEN");
        t.proj_losses = t.proj_losses + 3;
        return f;
      },
      expect: /DEN: proj_wins \+ proj_losses = .*, a season is 82/,
    },
    {
      name: "p10 > p90",
      damage: (f) => {
        const t = team(f, "DEN");
        [t.wins_p10, t.wins_p90] = [t.wins_p90, t.wins_p10];
        return f;
      },
      expect: /DEN: wins_p10 .* is above wins_p90/,
    },
    {
      name: "mean outside its own band",
      damage: (f) => {
        const t = team(f, "DEN");
        t.wins_p10 = Math.ceil(t.proj_wins) + 1;
        t.wins_p90 = t.wins_p10 + 2;
        return f;
      },
      expect: /DEN: proj_wins .* lies outside its own p10\.\.p90/,
    },
    {
      name: "league title odds sum to a half",
      damage: (f) => {
        for (const t of f.teams) t.title_pct = t.title_pct / 2;
        return f;
      },
      expect: /league title_pct sums to 0\.5/,
    },
    {
      name: "nine playoff teams in the West",
      damage: (f) => {
        // Lift a West team's playoff share by a whole team without breaking its own nesting.
        const t = f.teams.filter((x) => x.conference === "West").sort((a, b) => a.playoff_pct - b.playoff_pct)[0];
        t.playoff_pct = Math.min(1, t.playoff_pct + 1);
        t.playin_pct = 0.3;
        t.top6_pct = 0.7;
        return f;
      },
      expect: /West playoff_pct sums to/,
    },
    {
      name: "a field missing entirely",
      damage: (f) => {
        delete (team(f, "DEN") as Partial<RawProjectionTeam>).wins_p90;
        return f;
      },
      expect: /DEN: wins_p90 must be an integer/,
    },
  ];
  let caught = 0;
  for (const p of probes) {
    let msg: string | null = null;
    let wrongType = false;
    try {
      validateProjections(p.damage(clone()));
    } catch (err) {
      if (err instanceof ProjectionRejection) msg = err.message;
      else {
        wrongType = true;
        msg = String(err);
      }
    }
    if (msg === null) {
      check(false, `damage "${p.name}" was ACCEPTED by the validator`);
    } else if (wrongType) {
      check(false, `damage "${p.name}" threw something other than ProjectionRejection: ${msg}`);
    } else if (!p.expect.test(msg)) {
      check(false, `damage "${p.name}" was refused for the wrong reason: "${msg}" (wanted ${p.expect})`);
    } else {
      caught += 1;
    }
  }
  // And the slack is slack for ROUNDING only: a thousandth of inversion
  // passes, a hundredth does not.
  {
    const f = clone();
    const t = team(f, "WAS");
    t.top6_pct = t.playoff_pct + NEST_EPS / 2;
    let ok = true;
    try {
      validateProjections(f);
    } catch {
      ok = false;
    }
    check(ok, "a half-NEST_EPS inversion (sender rounding) was refused");
  }
  notes.push(`validator: ${caught}/${probes.length} damage patterns refused, each naming the problem`);
}

// ── 4. ordering + formatting ──────────────────────────────────────────────
{
  const accepted = validateProjections(fixtureRaw);
  const ordered = orderForTable(accepted.teams);
  check(ordered.length === 30, "orderForTable changed the row count");
  for (let i = 1; i < ordered.length; i++) {
    check(
      ordered[i - 1].proj_wins >= ordered[i].proj_wins,
      `orderForTable: ${ordered[i - 1].team} (${ordered[i - 1].proj_wins}) sits above ${ordered[i].team} (${ordered[i].proj_wins})`,
    );
  }
  // Independent: the team with the most projected wins, found by a plain max.
  const best = accepted.teams.reduce((a, b) => (b.proj_wins > a.proj_wins ? b : a));
  check(ordered[0].team === best.team, `orderForTable put ${ordered[0].team} first, but ${best.team} has the most projected wins`);
  // Not by the current record: find a pair where the records and projections disagree
  // and make sure the projection won.
  const pair = (() => {
    for (const a of accepted.teams)
      for (const b of accepted.teams)
        if (a.conference === b.conference && a.wins > b.wins && a.proj_wins < b.proj_wins) return [a, b] as const;
    return null;
  })();
  check(pair !== null, "the fixture has no pair where the record and the projection disagree — add one, or the order test is vacuous");
  if (pair) {
    const conf = conferenceTable(accepted.teams, pair[0].conference);
    const ia = conf.findIndex((t) => t.team === pair[0].team);
    const ib = conf.findIndex((t) => t.team === pair[1].team);
    check(
      ib < ia,
      `conferenceTable ordered ${pair[0].team} (${pair[0].wins} wins now, ${pair[0].proj_wins} projected) above ` +
        `${pair[1].team} (${pair[1].wins} now, ${pair[1].proj_wins} projected) — that is the current record, not the projection`,
    );
  }
  const east = conferenceTable(accepted.teams, "East");
  check(east.length === 15 && east.every((t) => t.conference === "East"), "conferenceTable(East) is not 15 East teams");
  const ordAgain = orderForTable(accepted.teams);
  check(JSON.stringify(ordAgain) === JSON.stringify(ordered), "orderForTable is not deterministic");
  check(JSON.stringify(accepted.teams.map((t) => t.team)) === JSON.stringify(fixtureRaw.teams.map((t) => t.team)), "orderForTable mutated its input");

  // The page and the table component order through the pure module, never on their own.
  const page = fs.readFileSync(path.join(ROOT, "app/hoops/projections/page.tsx"), "utf-8");
  const table = fs.readFileSync(path.join(ROOT, "components/hoops/ProjectionTable.tsx"), "utf-8");
  check(/conferenceTable\(/.test(table), "ProjectionTable does not order through conferenceTable()");
  check(!/\.sort\(/.test(page) && !/\.sort\(/.test(table), "the page or the table sorts on its own — the order must come from lib/hoops/projections.ts");
  check(/No projection has been received yet/.test(page), "the page has no honest empty state");
  check(/as of \{fmtAsOf\(projection\.meta\.asOfDate\)\}/.test(page), "the page does not date the projection by the sender's as_of_date");
  check(/projection\.meta\.replicates/.test(page), "the page does not say how many times the season was simulated");
  check(/projection\.meta\.method/.test(page), "the page does not print the sender's method");
  check(/"West"/.test(page) && /"East"/.test(page), "the page does not render both conferences");
  for (const col of ["W-L", "Proj", "80%", "Playoffs", "Title"]) {
    check(table.includes(`>${col}<`), `the table has no "${col}" column`);
  }

  check(fmtPct(0) === "0%" && fmtPct(1) === "100%", "fmtPct ends");
  check(fmtPct(0.004) === "<1%" && fmtPct(0.996) === ">99%", "fmtPct keeps the tails honest");
  check(fmtPct(0.5) === "50%" && fmtPct(0.126) === "13%", "fmtPct rounding");
  check(fmtWinRange({ wins_p10: 47, wins_p90: 58 }) === "47–58", "fmtWinRange");
  check(fmtProjRecord({ proj_wins: 52.3, proj_losses: 29.7 }) === "52.3-29.7", "fmtProjRecord");
  check(fmtAsOf("2026-10-27") === "Oct 27, 2026" && fmtAsOf("2027-01-02") === "Jan 2, 2027", "fmtAsOf");
  check(isCalendarDate("2024-02-29") && !isCalendarDate("2026-02-29") && !isCalendarDate("2026-13-01"), "isCalendarDate leap/day rules");
  notes.push("ordering: by projected wins (not the record), through the one pure function the page also uses; formatting pinned");
}

// ── 5. the real schema, the real importer, keep-latest ────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, "lib/hoops/import.ts"), "utf-8");
  const txBody = src.slice(src.indexOf("db.transaction(() => {"), src.indexOf("tx();"));
  check(/writeProjection\(db, bundle\.projections/.test(txBody), "writeBundle does not write the projection INSIDE its transaction");
  const deleteBlock = txBody.slice(txBody.indexOf("db.exec(`"), txBody.indexOf("`);"));
  check(
    !/hoops_projection/.test(deleteBlock),
    "writeBundle truncates the projection tables with the read model — a push without a projection would blank the page",
  );
  const route = fs.readFileSync(path.join(ROOT, "app/api/hoops/import/route.ts"), "utf-8");
  check(/checkFeatureFiles\(contract\.features, files\)/.test(route), "the import route does not run checkFeatureFiles");
  check(
    /contract\.features\.includes\("season_projection"\)/.test(route) && /validateProjections\(files\["projections\.json"\]\)/.test(route),
    "the import route does not validate projections.json when the token is declared",
  );
  check(/export async function GET/.test(route) && /describeContract\(\)/.test(route), "the import route has no GET discovery answer");
  check(/projectionSettled/.test(route) && /projectionSettled\)/.test(route.slice(route.indexOf("if (existing && existing.content_hash === contentHash"))), "the rule-6 no-op does not consider an unseen projection");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-projections-check-"));
  const cwd = process.cwd();
  let db: import("better-sqlite3").Database | null = null;
  try {
    process.chdir(tmp);
    const { getDb } = await import(path.join(ROOT, "lib/db.ts"));
    db = getDb() as import("better-sqlite3").Database;
    const { readProjection, writeProjection } = await import(path.join(ROOT, "lib/hoops/projectionStore.ts"));
    const { importPushedBundle } = await import(path.join(ROOT, "lib/hoops/import.ts"));

    for (const t of ["hoops_projection_meta", "hoops_projections"]) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      check(cols.length > 0, `lib/db.ts: no ${t} table`);
    }
    check(readProjection(db) === null, "a fresh DB reports a projection");

    // The store pair, directly.
    const accepted = validateProjections(fixtureRaw);
    db.transaction(() => writeProjection(db!, accepted, "2026-10-28T10:06:00Z"))();
    const back = readProjection(db);
    check(back !== null && back.teams.length === 30, "writeProjection/readProjection did not round-trip 30 teams");
    if (back) {
      check(back.meta.asOfDate === "2026-10-27" && back.meta.replicates === 10000 && back.meta.method === fixtureRaw.method, "meta did not round-trip");
      for (const t of accepted.teams) {
        const b = back.teams.find((x: RawProjectionTeam) => x.team === t.team)!;
        for (const k of Object.keys(t) as Array<keyof RawProjectionTeam>) {
          check(b[k] === t[k], `${t.team}.${k} round-tripped as ${String(b[k])}, not ${String(t[k])}`);
        }
      }
    }

    // The REAL importer over the committed bundle. Without a projection the
    // stored one stands; with one it is replaced; without one again it still
    // stands (keep latest).
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "hoops-data", f), "utf-8"));
    const bundle: HoopsBundle = {
      params: read("hoops_params.json"),
      teams: read("hoops_teams.json"),
      players: read("hoops_players.json"),
      schedule: read("hoops_schedule.json"),
      results: read("hoops_results.json"),
      lines: read("hoops_lines.json"),
    };
    const meta = (hash: string) => ({
      hash,
      generatedAt: "2026-10-28T10:00:00Z",
      pricingVersion: 1,
      features: ["symmetric_off_def", "absorption", "fictional_values"],
      constants: { ...(bundle.params.constants as unknown as Record<string, unknown>), replacement_per36: bundle.players.replacement_per36 },
    });
    const s1 = importPushedBundle(bundle, meta("sha256:one"));
    check(s1.imported && s1.counts.teams === 30, "the committed bundle did not import without a projection");
    const after1 = readProjection(db);
    check(after1?.meta.generatedAt === fixtureRaw.generated_at, "a push WITHOUT a projection wiped the stored one");

    const newer: RawProjectionsFile = { ...clone(), as_of_date: "2026-10-28", generated_at: "2026-10-29T10:05:00Z" };
    importPushedBundle({ ...bundle, projections: validateProjections(newer) }, meta("sha256:two"));
    const after2 = readProjection(db);
    check(after2?.meta.asOfDate === "2026-10-28" && after2?.meta.generatedAt === newer.generated_at, "a push WITH a projection did not replace the stored one");
    check(after2?.teams.length === 30, "the replacement did not land all 30 teams");

    importPushedBundle(bundle, meta("sha256:three"));
    const after3 = readProjection(db);
    check(after3?.meta.asOfDate === "2026-10-28", "a later push without a projection did not keep the latest one");
    const teamCount = (db.prepare(`SELECT COUNT(*) AS n FROM hoops_teams`).get() as { n: number }).n;
    check(teamCount === 30, `the read model has ${teamCount} teams after three imports`);
    notes.push("read model: schema present; store round-trips every field; the real importer keeps the latest projection across pushes with and without one");
  } finally {
    db?.close();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 6. the tab, the key, the mobile check ─────────────────────────────────
{
  const nav = fs.readFileSync(path.join(ROOT, "components/hoops/HoopsNav.tsx"), "utf-8");
  check(/href: "\/hoops\/projections"/.test(nav), "HoopsNav has no Projections tab");
  const shortcuts = fs.readFileSync(path.join(ROOT, "lib/shortcuts.ts"), "utf-8");
  check(/label: "Projections"/.test(shortcuts), "lib/shortcuts.ts has no number key for Projections");
  const mobile = fs.readFileSync(path.join(ROOT, "scripts/check-hoops-mobile.mjs"), "utf-8");
  check(/path: "\/hoops\/projections"/.test(mobile), "check:hoops:mobile does not walk /hoops/projections");
  notes.push("nav: tab, number key and the phone-fit walk all know the page");
}

// ── report ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error("hoops projections check: FAIL");
  for (const p of problems.slice(0, 12)) console.error(`  ✗ ${p}`);
  if (problems.length > 12) console.error(`  … and ${problems.length - 12} more`);
  process.exit(1);
}
console.log("hoops projections check: PASS");
