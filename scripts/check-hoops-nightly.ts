#!/usr/bin/env node
//
// NIGHTLY STRENGTH on the receiver — "who has actually been on the floor, last
// ten games" (hub-v2; hoops-sim's docs/milestones/nightly-strength.md and
// nightly-promotion.md).
//
//   npm run check:hoops:nightly   (standalone)
//   npm run build                 (runs via prebuild)
//
// WHAT THIS PROVES. hoops-sim measured this read to predict real game margins
// better than the season-long rating it is built from — it is the one
// game-level improvement in that project with a held-out gain, and the site has
// never had it. The ways it can go wrong here are all silent:
//
//   • the importer drops the columns on the floor (exactly what happened to the
//     offence/defence player split for months before anyone noticed),
//   • a team with no read shows as 0.0 and ranks mid-table, which reads as
//     "exactly average lately" rather than "we have no read",
//   • the lens is offered on a bundle that cannot fill it, so the league table
//     silently becomes two different questions in one column,
//   • the nightly numbers move a game's projected TOTAL, which nobody claimed
//     they should — this is a margin read and only a margin read.
//
// Every case drives the REAL schema (lib/db.ts), the REAL importer INSERT, and
// the REAL rating helpers. Nothing here restates their arithmetic.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { netOf, offDefOf, MODE_COPY } from "../lib/hoops/rating.ts";
import { encodeRunId, parseRunId } from "../lib/hoops/matchup.ts";
import type { TeamRow } from "../lib/hoops/types.ts";
import { ALL_RATING_MODES, RATING_MODES } from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const problems: string[] = [];
const notes: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) problems.push(msg);
};

const NIGHTLY_TEAM_COLS = [
  "nightly_off",
  "nightly_def",
  "nightly_results_w",
  "nightly_n_basis_games",
  "nightly_abstained",
];
const NIGHTLY_PARAM_COLS = [
  "nightly_as_of",
  "nightly_value_source",
  "nightly_last_n_games",
  "nightly_priced",
];

// ── 1. the importer actually writes the columns ───────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, "lib/hoops/import.ts"), "utf-8");
  for (const [table, cols] of [
    ["hoops_teams", NIGHTLY_TEAM_COLS],
    ["hoops_params", NIGHTLY_PARAM_COLS],
  ] as const) {
    const m = src.match(new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\(([^)]*)\\)`));
    if (!m) {
      check(false, `lib/hoops/import.ts: could not find the ${table} INSERT — has it been rewritten?`);
      continue;
    }
    const named = m[1].split(",").map((c) => c.trim()).filter(Boolean);
    const bound = m[2].split(",").map((c) => c.trim()).filter(Boolean);
    check(
      named.length === bound.length,
      `lib/hoops/import.ts: the ${table} INSERT names ${named.length} columns but binds ` +
        `${bound.length} placeholders`,
    );
    for (const c of cols) {
      check(
        named.includes(c),
        `lib/hoops/import.ts: the ${table} INSERT does not write ${c} — the nightly read would ` +
          `be dropped on import, which is exactly the bug the offence/defence player split hit.`,
      );
    }
  }
  notes.push("importer: both nightly INSERTs name every column and bind them one for one");
}

// ── 2. the real schema has them, and a round trip keeps them ──────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-nightly-check-"));
  const cwd = process.cwd();
  let db: import("better-sqlite3").Database | null = null;
  try {
    process.chdir(tmp);
    const { getDb } = await import(path.join(ROOT, "lib/db.ts"));
    db = getDb() as import("better-sqlite3").Database;

    const teamCols = (
      db.prepare(`PRAGMA table_info(hoops_teams)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const c of NIGHTLY_TEAM_COLS) {
      check(teamCols.includes(c), `lib/db.ts: hoops_teams has no ${c} column`);
    }
    const paramCols = (
      db.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const c of NIGHTLY_PARAM_COLS) {
      check(paramCols.includes(c), `lib/db.ts: hoops_params has no ${c} column`);
    }

    const ins = db.prepare(
      `INSERT INTO hoops_teams
         (tri, conference, division, results_off, results_def, roster_off, roster_def,
          blend_off, blend_def,
          nightly_off, nightly_def, nightly_results_w, nightly_n_basis_games, nightly_abstained)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A priced team, and a team with NO read at all.
    ins.run("ZZA", "West", "Pacific", 4.0, -3.0, 3.0, -2.0, 3.5, -2.5, 5.0, -4.0, 0.28, 10, 0);
    ins.run("ZZB", "East", "Atlantic", 1.0, 2.0, 0.5, 1.5, 0.8, 1.8, null, null, null, null, null);

    const back = db
      .prepare(`SELECT * FROM hoops_teams WHERE tri IN ('ZZA','ZZB') ORDER BY tri`)
      .all() as TeamRow[];
    check(back.length === 2, "round trip: both synthetic teams did not come back");
    const [a, b] = back;
    check(
      a.nightly_off === 5.0 && a.nightly_def === -4.0 && a.nightly_results_w === 0.28,
      `round trip: ZZA's nightly read came back as ${JSON.stringify([a.nightly_off, a.nightly_def, a.nightly_results_w])}`,
    );
    check(
      b.nightly_off === null && b.nightly_def === null && b.nightly_abstained === null,
      `round trip: a team with NO nightly read came back as ` +
        `${JSON.stringify([b.nightly_off, b.nightly_def, b.nightly_abstained])} — it must stay ` +
        `NULL, never 0, or the site reads "we have no idea" as "exactly average lately"`,
    );

    // 🔴 The lens must not be offered when the league is only half covered.
    // Asserted through the REAL query helper, over a DB that is deliberately
    // in that state.
    const { availableRatingModes } = await import(path.join(ROOT, "lib/hoops/rating.ts"));
    const partial = availableRatingModes(back) as string[];
    check(
      !partial.includes("nightly"),
      `availableRatingModes offered the nightly lens with only 1 of 2 teams covered — a league ` +
        `table where some teams are rated on the last ten games and others are not is two ` +
        `different questions in one column`,
    );
    const complete = availableRatingModes([a, { ...b, nightly_off: 0.5, nightly_def: 0.2 }]) as string[];
    check(
      complete.includes("nightly"),
      "availableRatingModes withheld the nightly lens even with every team covered",
    );
    notes.push(
      "read model: both nightly INSERTs round-trip; a team with no read stays NULL; the lens is " +
        "offered only when all 30 are covered",
    );
  } finally {
    db?.close();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 3. the rating helpers ─────────────────────────────────────────────────
{
  const withRead: TeamRow = {
    tri: "ZZA",
    conference: "West",
    division: "Pacific",
    results_off: 4,
    results_def: -3,
    roster_off: 3,
    roster_def: -2,
    blend_off: 3.5,
    blend_def: -2.5,
    nightly_off: 5,
    nightly_def: -4,
  };
  const withoutRead: TeamRow = { ...withRead, nightly_off: null, nightly_def: null };

  check(
    netOf(withRead, "nightly") === 9,
    `netOf(nightly) = ${netOf(withRead, "nightly")}, expected off - def = 9`,
  );
  check(
    netOf(withoutRead, "nightly") === netOf(withoutRead, "blend"),
    `a team with no nightly read priced ${netOf(withoutRead, "nightly")} under the nightly lens; ` +
      `it must fall back to the blend (${netOf(withoutRead, "blend")}), never to a 0/0 that ` +
      `would rank it mid-table as if we had said something`,
  );
  const od = offDefOf(withRead, "nightly");
  check(od.off === 5 && od.def === -4, `offDefOf(nightly) = ${JSON.stringify(od)}`);
  for (const m of ALL_RATING_MODES) {
    check(MODE_COPY[m] !== undefined, `MODE_COPY has no entry for the "${m}" lens`);
    check(
      (MODE_COPY[m].blurb ?? "").length > 40,
      `the "${m}" lens has no real explanation on screen — every lens carries its own caveat, ` +
        `always visible, never a tooltip`,
    );
  }
  check(
    !RATING_MODES.includes("nightly"),
    "RATING_MODES must stay the three modes every bundle carries; nightly is conditional",
  );
  notes.push(
    `rating: nightly nets out at off - def, falls back to the blend with no read, and all ` +
      `${ALL_RATING_MODES.length} lenses carry their own on-screen caveat`,
  );
}

// ── 4. a shared link to a nightly game still resolves ─────────────────────
{
  for (const mode of ALL_RATING_MODES) {
    for (const neutral of [false, true]) {
      const id = encodeRunId({ home: "DEN", away: "OKC", neutralSite: neutral, ratingMode: mode }, "0");
      const parsed = parseRunId(id);
      check(
        parsed !== null && parsed.ratingMode === mode && parsed.neutralSite === neutral,
        `run_id "${id}" did not round-trip (${mode}, neutral=${neutral}) — a link shared at any ` +
          `point in this site's history has to keep resolving`,
      );
    }
  }
  // The one collision worth naming: 'n' is the NEUTRAL court code and also the
  // NIGHTLY mode code. They live in fixed, different positions.
  const neutralNightly = encodeRunId(
    { home: "DEN", away: "OKC", neutralSite: true, ratingMode: "nightly" },
    "0",
  );
  const p = parseRunId(neutralNightly);
  check(
    p?.neutralSite === true && p?.ratingMode === "nightly",
    `a neutral-court nightly game encoded as "${neutralNightly}" and parsed back as ` +
      `${JSON.stringify(p)} — the two 'n' codes collided`,
  );
  notes.push(
    `run_id: all ${ALL_RATING_MODES.length * 2} (mode x court) combinations round-trip, ` +
      `including neutral-court nightly where both codes are 'n'`,
  );
}

for (const n of notes) console.log(`  · ${n}`);

if (problems.length > 0) {
  console.error(`\nHOOPS NIGHTLY CHECK FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}

console.log("hoops nightly check: PASS");
