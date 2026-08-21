#!/usr/bin/env node
//
// The player-rankings gate. Runs as `prebuild`, so `npm run build` is also the
// gate for /hoops/players.
//
//   npm run check:hoops:players   (standalone)
//   npm run build                 (runs this first via prebuild)
//
// What it asserts, and why each piece is here rather than assumed:
//
//   1. THE SIGN CONVENTION, measured both ways. A player's value splits
//      ADDITIVELY (net = off + def) with a positive defence meaning GOOD
//      defence — the exact opposite of the TEAM convention in rating.ts
//      (net = off − def, positive def = points allowed). Two conventions in
//      one bundle is a standing invitation to "fix" the plus into a minus, so
//      this checks that the plus form reconciles AND that the minus form
//      still does not. Asserting only the first would pass on a bundle whose
//      defence sign had been inverted upstream.
//
//   2. REAL BASKETBALL, not internal consistency. Rudy Gobert has four
//      Defensive Player of the Year awards; Trae Young does not have one. If
//      this model reads Gobert as an offence-first player, something is wrong
//      that no amount of self-agreement would reveal. These anchors are facts
//      about the NBA, external to the bundle entirely.
//
//   3. THE SPLIT SURVIVES THE TRIP INTO SQLITE. This is the specific bug
//      /hoops/players exists downstream of: the exporter had been shipping
//      value_off_per36/value_def_per36 all along and the importer dropped
//      both on the floor, so the read model simply did not have them. The
//      check drives the REAL projection (playerRowsFromBundle) and the REAL
//      schema (lib/db.ts, in a throwaway cwd) and reads the values back out.
//      🔴 What it does NOT cover: the argument ORDER of import.ts's own
//      `.run(...)` call, which is separate from the column list this reads.
//      The schema/column cross-check below is the compensating assertion.
//
//   4. THE RANKING IS THE ONE THE PAGE RENDERS. rankPlayers/filterPlayers are
//      driven live over the real bundle rather than re-implemented here.
//      Includes the league-rank-under-filter property (narrowing to one team
//      must NOT renumber that team 1..15) and a liveness check that the off
//      and def sorts actually disagree — the M4a "measured at 1/30th of
//      physical scale" failure, where a channel looks tested and is inert.
//
//   5. THE SCOPE BOUNDARY. The wire contract declares `symmetric_off_def`,
//      and the exporter ships its own note saying these two fields are for
//      display only until a v2 `split_off_def` flip on BOTH sides. So
//      pricing.ts and boxscore.ts must not have learned the field names.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  filterPlayers,
  playerRowsFromBundle,
  rankPlayers,
} from "../lib/hoops/playervalue.ts";
import type { RankedPlayer } from "../lib/hoops/playervalue.ts";
import type { RawPlayersFile } from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "hoops-data");

const problems: string[] = [];
const notes: string[] = [];

function fail(msg: string): void {
  problems.push(msg);
}
function check(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

// Every value in the bundle is rounded to 4 decimals, so a three-number
// identity can miss by up to ~1.5e-4 from rounding alone. 1e-3 is comfortably
// above that and far below any real sign or arithmetic error.
const ROUNDING_TOL = 1e-3;

/** Fold diacritics so an anchor matches whether the exporter writes
 *  "Nikola Jokic" or "Nikola Jokić". */
function foldName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

const players = ((): RawPlayersFile | null => {
  const p = path.join(DATA, "hoops_players.json");
  if (!fs.existsSync(p)) {
    fail(`hoops_players.json: missing. Run \`uv run hoops export-hub ${DATA}\` from ~/Code/hoops-sim.`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as RawPlayersFile;
  } catch (err) {
    fail(`hoops_players.json: not valid JSON — ${(err as Error).message}`);
    return null;
  }
})();

const paramsConstants = ((): Record<string, number> | null => {
  const p = path.join(DATA, "hoops_params.json");
  if (!fs.existsSync(p)) return null;
  try {
    return (JSON.parse(fs.readFileSync(p, "utf-8")) as { constants?: Record<string, number> })
      .constants ?? null;
  } catch {
    return null;
  }
})();

// ──────────────────────────────────────────────── 1. the sign convention ──

function checkSplitIdentity(rows: ReturnType<typeof playerRowsFromBundle>): void {
  const split = rows.filter((r) => r.value_off_per36 != null && r.value_def_per36 != null);
  check(
    split.length > 0,
    "hoops_players.json: not one player carries value_off_per36/value_def_per36 — " +
      "/hoops/players has nothing to render. Re-export from hoops-sim.",
  );
  if (split.length === 0) return;

  // Half-split rows would render as a broken column and mean the exporter has
  // changed shape in a way nothing else here would notice.
  const half = rows.filter(
    (r) => (r.value_off_per36 == null) !== (r.value_def_per36 == null),
  );
  check(
    half.length === 0,
    `hoops_players.json: ${half.length} player(s) carry exactly one half of the off/def split ` +
      `(e.g. ${half[0]?.name}) — it must be both or neither`,
  );

  // A split without a net, or a net without a split, are both real states
  // (a no-history player has neither) — but a split whose net is missing
  // cannot be reconciled and would sort as unranked while showing numbers.
  const orphan = split.filter((r) => r.value_per36 == null);
  check(
    orphan.length === 0,
    `hoops_players.json: ${orphan.length} player(s) have an off/def split but no value_per36 ` +
      `(e.g. ${orphan[0]?.name})`,
  );

  const reconciles = split.filter(
    (r) =>
      r.value_per36 != null &&
      Math.abs(r.value_off_per36! + r.value_def_per36! - r.value_per36) <= ROUNDING_TOL,
  );
  check(
    reconciles.length === split.length,
    `off + def must equal value_per36: it does for only ${reconciles.length} of ${split.length} ` +
      `players. 🔴 A player's value splits ADDITIVELY. If the exporter has flipped the defence ` +
      `sign, lib/hoops/playervalue.ts and every "positive defence is good defence" line in the ` +
      `UI are now wrong — fix the reading, do not relax this check.`,
  );

  // 🔴 The falsification half. `off − def == net` is true exactly when def is
  // zero, so on a correctly-signed bundle it holds for almost nobody. If it
  // ever starts holding league-wide, the defence sign HAS been inverted and
  // assertion above would still pass on the flipped data.
  const minusForm = split.filter(
    (r) =>
      r.value_per36 != null &&
      Math.abs(r.value_off_per36! - r.value_def_per36! - r.value_per36) <= ROUNDING_TOL,
  );
  check(
    minusForm.length < split.length * 0.1,
    `off − def reconciles to value_per36 for ${minusForm.length} of ${split.length} players. ` +
      `That is the TEAM convention, not the player one — the defence sign looks inverted.`,
  );
  notes.push(
    `split: off + def reconciles for ${reconciles.length}/${split.length}; ` +
      `off − def for ${minusForm.length} (the minus form must stay rare)`,
  );
}

// ──────────────────────────────────────── 2. external basketball anchors ──

// Known-true facts about real NBA players, independent of this bundle.
// 🔴 If a name here leaves the league the check fails loudly and says so —
// that is deliberate. Silently degrading to zero anchors is the failure mode
// this whole file exists to prevent.
const DEFENCE_FIRST = [
  "Rudy Gobert", // four-time Defensive Player of the Year
  "Victor Wembanyama", // DPOY-calibre rim protector
  "Matisse Thybulle", // two-time All-Defensive Team, negligible offensive role
  "Clint Capela", // rim-running centre, defence and rebounding
];
const OFFENCE_FIRST = [
  "Stephen Curry", // the greatest shooter in the sport's history
  "Trae Young", // elite offensive engine, long-standing defensive liability
  "Luka Doncic",
  "Nikola Jokic", // three-time MVP on offence-dominant value
];
const MIN_ANCHORS_PER_GROUP = 3;

function checkExternalAnchors(rows: ReturnType<typeof playerRowsFromBundle>): void {
  const byName = new Map(rows.map((r) => [foldName(r.name), r]));

  const run = (names: string[], want: "def" | "off", label: string): void => {
    const found = names
      .map((n) => ({ n, row: byName.get(foldName(n)) }))
      .filter((x) => x.row && x.row.value_off_per36 != null && x.row.value_def_per36 != null);
    check(
      found.length >= MIN_ANCHORS_PER_GROUP,
      `only ${found.length} of ${names.length} ${label} anchors are in this bundle with a split ` +
        `(need ${MIN_ANCHORS_PER_GROUP}). The anchor list in scripts/check-hoops-players.ts has ` +
        `gone stale — replace the departed players with current ones, don't lower the bar.`,
    );
    for (const { n, row } of found) {
      const off = row!.value_off_per36!;
      const def = row!.value_def_per36!;
      const ok = want === "def" ? def > off : off > def;
      check(
        ok,
        `${n} reads off ${off.toFixed(2)} / def ${def.toFixed(2)} — this model has him as a ` +
          `${want === "def" ? "offence" : "defence"}-first player, which contradicts the real NBA. ` +
          `Either the off/def columns are swapped, or the defence sign is inverted.`,
      );
    }
    notes.push(`${label} anchors: ${found.length} checked, all ${want} > ${want === "def" ? "off" : "def"}`);
  };

  run(DEFENCE_FIRST, "def", "defence-first");
  run(OFFENCE_FIRST, "off", "offence-first");
}

// ──────────────────────────────── 3. the split survives the trip to SQLite ──

async function checkReadModelRoundTrip(
  rows: ReturnType<typeof playerRowsFromBundle>,
): Promise<void> {
  const problemsAtEntry = problems.length;

  // The INSERT the real importer uses. Read out of the real file so this
  // cannot drift from what production actually runs.
  const importSrc = fs.readFileSync(path.join(ROOT, "lib/hoops/import.ts"), "utf-8");
  const m = importSrc.match(
    /INSERT INTO hoops_players\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/,
  );
  if (!m) {
    fail("lib/hoops/import.ts: could not find the hoops_players INSERT — has it been rewritten?");
    return;
  }
  const cols = m[1].split(",").map((c) => c.trim()).filter(Boolean);
  const placeholders = m[2].split(",").map((c) => c.trim()).filter(Boolean);
  check(
    cols.length === placeholders.length,
    `lib/hoops/import.ts: the hoops_players INSERT names ${cols.length} columns but binds ` +
      `${placeholders.length} placeholders`,
  );
  for (const c of ["value_off_per36", "value_def_per36"]) {
    check(
      cols.includes(c),
      `lib/hoops/import.ts: the hoops_players INSERT does not write ${c} — the off/def split ` +
        `would be dropped on import again, which is the exact bug /hoops/players fixed.`,
    );
  }

  // Build the REAL schema in a throwaway cwd (lib/db.ts resolves its data dir
  // from process.cwd()), so the columns are asserted against the DDL that
  // actually ships rather than a copy of it here.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-players-check-"));
  const cwd = process.cwd();
  let db: import("better-sqlite3").Database | null = null;
  try {
    process.chdir(tmp);
    const { getDb } = await import(path.join(ROOT, "lib/db.ts"));
    db = getDb() as import("better-sqlite3").Database;

    const schemaCols = (
      db.prepare(`PRAGMA table_info(hoops_players)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const c of ["value_off_per36", "value_def_per36"]) {
      check(
        schemaCols.includes(c),
        `lib/db.ts: hoops_players has no ${c} column — the importer writes a column the schema ` +
          `doesn't have, and every insert will throw at runtime.`,
      );
    }
    // Cross-check the two independent sources against each other: every column
    // the INSERT names must exist in the DDL. This is what catches "added to
    // one, forgotten in the other" in either direction.
    const unknown = cols.filter((c) => !schemaCols.includes(c));
    check(
      unknown.length === 0,
      `lib/hoops/import.ts writes column(s) lib/db.ts does not declare: ${unknown.join(", ")}`,
    );

    // If the schema and the INSERT already disagree, preparing that INSERT
    // throws a raw SqliteError and buries the problem we just named under a
    // stack trace. Stop here and let the reported problem be the output.
    if (problems.length > problemsAtEntry) return;

    // Round-trip a real sample through the real projection and the real SQL.
    const sample = rows
      .filter((r) => r.value_off_per36 != null && r.value_def_per36 != null)
      .slice(0, 25);
    const ins = db.prepare(
      `INSERT INTO hoops_players (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
    );
    for (const p of sample) {
      ins.run(
        ...cols.map((c) => {
          if (c === "tri") return p.tri;
          if (c === "game_rates") return p.game_rates ? JSON.stringify(p.game_rates) : null;
          if (c === "per36") return p.per36 ? JSON.stringify(p.per36) : null;
          return (p as unknown as Record<string, unknown>)[c] ?? null;
        }),
      );
    }
    const back = db
      .prepare(
        `SELECT athlete_id, value_per36, value_off_per36, value_def_per36 FROM hoops_players`,
      )
      .all() as Array<{
      athlete_id: number;
      value_per36: number | null;
      value_off_per36: number | null;
      value_def_per36: number | null;
    }>;
    check(
      back.length === sample.length,
      `read-model round trip: wrote ${sample.length} players, read back ${back.length}`,
    );
    const byId = new Map(back.map((r) => [r.athlete_id, r]));
    let mismatched = 0;
    for (const p of sample) {
      const r = byId.get(p.athlete_id);
      if (
        !r ||
        r.value_off_per36 !== p.value_off_per36 ||
        r.value_def_per36 !== p.value_def_per36 ||
        r.value_per36 !== p.value_per36
      ) {
        mismatched += 1;
      }
    }
    check(
      mismatched === 0,
      `read-model round trip: ${mismatched} of ${sample.length} players came back with a ` +
        `different value than went in`,
    );
    notes.push(
      `read model: ${cols.length}-column INSERT agrees with the real DDL; ` +
        `${sample.length} players round-tripped with their split intact`,
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* the temp DB is about to be deleted either way */
    }
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────── 4. the ranking the page uses ──

function checkRanking(rows: ReturnType<typeof playerRowsFromBundle>): void {
  const floor = paramsConstants?.absorption_rotation_floor_minutes ?? null;
  check(
    floor != null,
    "hoops_params.json: no absorption_rotation_floor_minutes constant — /hoops/players cannot " +
      "offer its rotation lens, and would have to invent a threshold instead.",
  );

  const ranked = rankPlayers(rows, "net", floor);
  check(ranked.length === rows.length, "rankPlayers dropped players — every roster spot must survive");

  const rankable = ranked.filter((p) => p.rank > 0);
  const unranked = ranked.filter((p) => p.rank === 0);

  // Dense 1..n, no gaps, no duplicates, and all in order.
  const bad = rankable.findIndex((p, i) => p.rank !== i + 1);
  check(bad === -1, `rankPlayers: rank ${rankable[bad]?.rank} at position ${bad + 1} — ranks must be dense 1..n`);

  const descending = rankable.every(
    (p, i) => i === 0 || (rankable[i - 1].net as number) >= (p.net as number),
  );
  check(descending, "rankPlayers: the net sort is not in descending order");

  // Unranked players sit at the tail, never interleaved.
  const firstUnranked = ranked.findIndex((p) => p.rank === 0);
  check(
    firstUnranked === -1 || firstUnranked === rankable.length,
    "rankPlayers: an unranked player is interleaved among the ranked ones",
  );
  check(
    unranked.every((p) => p.net == null),
    "rankPlayers: a player with a value came back unranked under the net sort",
  );

  const top = rankable[0];
  const maxNet = Math.max(...rankable.map((p) => p.net as number));
  check(
    top != null && Math.abs((top.net as number) - maxNet) < 1e-12,
    "rankPlayers: #1 is not the highest-valued player",
  );

  // 🔴 League rank must survive a team filter. If a future change re-ranks
  // after filtering, one team's best player reads "#1 in the NBA".
  const tri = top!.tri;
  const teamView = filterPlayers(ranked, { team: tri });
  const leagueRanks = new Map(ranked.map((p) => [p.athlete_id, p.rank]));
  const renumbered = teamView.filter((p) => leagueRanks.get(p.athlete_id) !== p.rank);
  check(
    renumbered.length === 0,
    `filterPlayers renumbered ${renumbered.length} ${tri} players — a filter is a lens on the ` +
      `league ranking, not a new ranking`,
  );
  check(
    teamView.length > 0 && teamView.every((p) => p.tri === tri),
    `filterPlayers: the ${tri} filter let another team through`,
  );

  // The rotation lens drops exactly the sub-floor players and nobody else.
  if (floor != null) {
    const rotation = filterPlayers(ranked, { rotationOnly: true });
    const expected = ranked.filter((p) => p.minutes >= floor);
    check(
      rotation.length === expected.length,
      `filterPlayers(rotationOnly): kept ${rotation.length}, expected ${expected.length} at a ` +
        `${floor}-minute floor`,
    );
    check(
      rotation.every((p) => p.minutes >= floor),
      "filterPlayers(rotationOnly): kept a player below the rotation floor",
    );
    notes.push(
      `rotation lens: ${expected.length} of ${ranked.length} players clear the ` +
        `${floor}-minute floor from the bundle's own constants`,
    );
  }

  // 🔴 Liveness. If the off and def sorts produced near-identical orders the
  // split would be decorative — the M4a failure, where a channel is tested at
  // a scale that cannot move anything. Real basketball separates these two
  // populations sharply, so an overlap this high means the halves are not
  // really independent.
  const topN = (sort: "off" | "def"): Set<number> =>
    new Set(
      rankPlayers(rows, sort, floor)
        .filter((p) => p.rank > 0 && p.rank <= 20)
        .map((p) => p.athlete_id),
    );
  const offTop = topN("off");
  const defTop = topN("def");
  const overlap = [...offTop].filter((id) => defTop.has(id)).length;
  check(
    offTop.size === 20 && defTop.size === 20,
    "rankPlayers: fewer than 20 rankable players under an off/def sort",
  );
  check(
    overlap <= 8,
    `the off and def top-20s share ${overlap} of 20 players. The two halves are barely ` +
      `distinguishable, so the split is close to decorative — check the exporter.`,
  );
  notes.push(`sort liveness: off and def top-20s share ${overlap} of 20 players`);

  const named = (p: RankedPlayer | undefined): string =>
    p ? `${p.name} (${p.tri}) ${(p.net as number).toFixed(2)}` : "—";
  notes.push(`net #1 ${named(rankable[0])} · #2 ${named(rankable[1])} · #3 ${named(rankable[2])}`);
}

// ────────────────────────────────────────────────── 5. the scope boundary ──

function checkScopeBoundary(): void {
  // The wire contract declares `symmetric_off_def`, and hoops_players.json
  // ships its own note: these fields are display-only until a v2
  // `split_off_def` flip on BOTH sides. Pricing must stay on the net.
  for (const rel of ["lib/hoops/pricing.ts", "lib/hoops/boxscore.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    for (const field of ["value_off_per36", "value_def_per36"]) {
      check(
        !src.includes(field),
        `${rel} reads ${field}. The bundle arrives under a symmetric_off_def contract — pricing ` +
          `uses value_per36 (net) only, with off=net/2, def=-net/2. Wiring the real split into ` +
          `pricing needs a v2 split_off_def feature flip on BOTH sides first.`,
      );
    }
  }
  notes.push("scope: pricing.ts and boxscore.ts still price off the net, as the contract requires");
}

// ─────────────────────────────────────────────────────────────────── run ──

async function main(): Promise<void> {
  if (players) {
    const rows = playerRowsFromBundle(players);
    checkSplitIdentity(rows);
    checkExternalAnchors(rows);
    await checkReadModelRoundTrip(rows);
    checkRanking(rows);
  }
  checkScopeBoundary();

  for (const n of notes) console.log(`  · ${n}`);

  if (problems.length > 0) {
    console.error(`\nHOOPS PLAYER-RANKINGS CHECK FAILED — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log(`hoops player-rankings check: PASS (${players?.players.length ?? 0} players)`);
}

await main();
