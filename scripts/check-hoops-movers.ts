#!/usr/bin/env node
//
// WHAT MOVED — the men behind a team's nightly rating.
//
//   npm run check:hoops:movers   (standalone)
//   npm run build                (runs via prebuild)
//
// WHAT THIS PROVES. The nightly rating is one number and one number cannot say
// why. The bundle now ships, per team, the gap between that read and the SAME
// roster priced off its season-typical minutes, split one piece per player, and
// the team page names the biggest three. The ways it can quietly go wrong are
// all silent — nothing on screen looks broken:
//
//   • the importer drops the blob on the floor (the value_off_per36 story, and
//     the explain sidecar's near-miss: naming the column proves nothing about
//     what lands in it, so the BINDING is read by position here),
//   • the page shows three men who are not the biggest three, because the
//     export's order was taken on trust,
//   • the sentence under them adds the wrong numbers together — the team's
//     whole gap, the part the three account for, and the share that survives
//     the mix with the season-long rating are three different quantities,
//   • a team the read abstained on gets explained anyway, i.e. the page
//     accounts for movement in a rating nobody computed,
//   • the "next man up" absorption slot (athlete_id −1) is rendered as a
//     person and linked to a player page that cannot exist.
//
// Second source for the headline claims: hoops-sim's own espn_player_box, via
// the two real-basketball anchors below — Giannis Antetokounmpo played none of
// Milwaukee's last ten games of 2025-26, Jayson Tatum played seven of Boston's
// after missing most of the season. Neither fact comes from anything this file
// or the bundle's movers block computes.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { RawNightlyMover, RawTeamsFile } from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const problems: string[] = [];
const notes: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) problems.push(msg);
};
const TOL = 3e-3;

const MOVER_TEAM_COLS = [
  "nightly_movers_json",
  "nightly_delta_pre_mix",
  "nightly_delta_post_mix",
  "nightly_n_movers_total",
  "nightly_movers_delta_sum",
];
const MOVER_PARAM_COLS = ["nightly_league_typical_shift"];
const DIRECTIONS = new Set(["out", "back", "up", "down", "absorbed"]);
/** hoops-sim's exporthub.NIGHTLY_MOVERS_TOP_N. */
const TOP_N = 3;

/**
 * The argument list of a `run(...)` call, one entry per line, starting just
 * inside the opening bracket. Line comments are stripped FIRST — several of
 * the importer's carry an unbalanced ")" in prose — and the call ends where
 * the brackets balance, not at a guessed indentation.
 */
function runArgs(src: string, from: number): string[] {
  const lines = src.slice(from).split("\n").map((l) => l.replace(/\/\/.*$/, ""));
  const out: string[] = [];
  let depth = 1;
  for (const raw of lines) {
    let line = "";
    let closed = false;
    for (const ch of raw) {
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
      line += ch;
    }
    out.push(line);
    if (closed) break;
  }
  return out.map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/,$/, ""));
}

const teamsFile = JSON.parse(
  fs.readFileSync(path.join(ROOT, "hoops-data/hoops_teams.json"), "utf-8"),
) as RawTeamsFile;
const tris = Object.keys(teamsFile.teams).sort();

// ── 1. the importer names, binds, and binds the BLOB by position ──────────
{
  const src = fs.readFileSync(path.join(ROOT, "lib/hoops/import.ts"), "utf-8");

  // The two INSERTs, each checked for names == binds and for every new column.
  const inserts: Array<{
    table: string;
    cols: string[];
    runVar: string;
    /** hoops_params writes a literal `1` for its id column, so the run(...)
     *  argument list is one shorter than the column list. */
    leadingLiterals: number;
  }> = [
    { table: "hoops_teams", cols: MOVER_TEAM_COLS, runVar: "insTeam.run(", leadingLiterals: 0 },
    { table: "hoops_params", cols: MOVER_PARAM_COLS, runVar: ").run(", leadingLiterals: 1 },
  ];

  for (const spec of inserts) {
    const m = src.match(
      new RegExp(`INSERT INTO ${spec.table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\(([^)]*)\\)`),
    );
    if (!m) {
      check(false, `lib/hoops/import.ts: could not find the ${spec.table} INSERT`);
      continue;
    }
    const named = m[1].split(",").map((c) => c.trim()).filter(Boolean);
    const bound = m[2].split(",").map((c) => c.trim()).filter(Boolean);
    check(
      named.length === bound.length,
      `lib/hoops/import.ts: the ${spec.table} INSERT names ${named.length} columns but binds ` +
        `${bound.length} placeholders`,
    );
    for (const c of spec.cols) {
      check(
        named.includes(c),
        `lib/hoops/import.ts: the ${spec.table} INSERT does not write ${c} — the movers would be ` +
          `dropped on import, which is exactly the bug the offence/defence player split hit`,
      );
    }

    // 🔴 The BINDING, by position. Naming a column proves nothing about what
    // lands in it — the explain sidecar's first check bound the values itself
    // and stayed green while the real importer wrote NULL. So read the
    // importer's own run(...) argument list and demand the argument sitting in
    // each new column's slot is the right expression.
    const runStart = src.indexOf(spec.runVar, m.index ?? 0);
    const args = runArgs(src, runStart + spec.runVar.length);
    check(
      runStart > 0 && args.length === named.length - spec.leadingLiterals,
      `import.ts: the ${spec.table} run(...) binds ${args.length} arguments for ` +
        `${named.length - spec.leadingLiterals} bindable columns`,
    );
    for (const c of spec.cols) {
      const slot = named.indexOf(c) - spec.leadingLiterals;
      const arg = args[slot] ?? "";
      const wantsBlob = c === "nightly_movers_json";
      const ok = wantsBlob
        ? /JSON\.stringify\(\s*t\.nightly\.movers\s*\)/.test(arg) && /t\.nightly\?\.movers/.test(arg)
        : new RegExp(
            c === "nightly_league_typical_shift"
              ? "bundle\\.teams\\.nightly_league_typical_shift"
              : `t\\.nightly\\?\\.${c.replace(/^nightly_/, "")}`,
          ).test(arg);
      check(
        slot >= 0 && ok,
        `import.ts: the ${c} slot binds \`${arg}\`, not the value it is named for`,
      );
    }
  }

  // The sixth no-op marker. Without it an existing Railway volume keeps NULL
  // blobs forever: the content hash is unchanged, so nothing rewrites.
  //
  // 🔴 Read the CONDITION, not the file. The first draft of this grepped the
  // whole source for "moversSettled" and stayed green when the term was
  // deleted from the no-op `if` and left declared above it — the exact shape of
  // the bug it exists to catch. Falsified at merge; repaired here, not in the
  // probe.
  check(/hasMovers/.test(src), "lib/hoops/import.ts: StoredState has no hasMovers marker");
  const noop = src.match(/if \(\s*!force &&[\s\S]*?\)\s*\{/);
  check(!!noop, "lib/hoops/import.ts: could not find the no-op condition — has it been rewritten?");
  check(
    !!noop && /moversSettled/.test(noop[0]),
    "lib/hoops/import.ts: moversSettled is not IN the no-op condition (declaring it is not using " +
      "it) — an existing volume would never backfill the movers, because the content hash is " +
      "unchanged and nothing would force the one rewrite",
  );
  check(
    !!noop && /explainSettled/.test(noop[0]) && /nightlySettled/.test(noop[0]),
    "lib/hoops/import.ts: an earlier backfill marker has fallen out of the no-op condition",
  );
  check(
    /nightly_movers_json IS NOT NULL/.test(src),
    "lib/hoops/import.ts: hasMovers is not read off nightly_movers_json — the marker must be the " +
      "BLOB, not one of the scalars beside it, because the blob is what the block cannot render " +
      "without",
  );
  notes.push("importer: both INSERTs name and bind every movers column, blob bound by position");
}

// ── 2. the committed bundle's own arithmetic and ordering ─────────────────
{
  let priced = 0;
  let withMovers = 0;
  let abstained = 0;
  let absorbedSlots = 0;
  for (const tri of tris) {
    const n = teamsFile.teams[tri].nightly;
    if (!n) continue;
    if (n.abstained) {
      abstained += 1;
      // 🔴 Nothing was re-priced for this team, so there is nothing to
      // explain. All six fields must be absent — an empty list would read on
      // screen as "nobody moved".
      check(
        n.movers == null &&
          n.delta_pre_mix == null &&
          n.delta_post_mix == null &&
          n.n_movers_total == null &&
          n.movers_delta_sum == null,
        `${tri}: the nightly read abstained, but the bundle explains its movement anyway`,
      );
      continue;
    }
    priced += 1;
    if (n.movers == null) {
      // Every priced team must ship movers, so a silent degrade cannot pass
      // as "nothing moved here".
      check(false, `${tri}: priced nightly, but no movers block — a silent degrade`);
      continue;
    }
    withMovers += 1;

    check(
      n.movers.length > 0 && n.movers.length <= TOP_N,
      `${tri}: ships ${n.movers.length} movers, expected 1..${TOP_N}`,
    );

    // Sorted biggest first, by SIZE of the move — a page that prints them in
    // the order it was handed is not printing the biggest three.
    for (let i = 1; i < n.movers.length; i += 1) {
      check(
        Math.abs(n.movers[i - 1].delta_pts) >= Math.abs(n.movers[i].delta_pts) - 1e-9,
        `${tri}: movers are not sorted by size — ${n.movers[i - 1].name} ` +
          `(${n.movers[i - 1].delta_pts}) before ${n.movers[i].name} (${n.movers[i].delta_pts})`,
      );
    }

    // The three numbers the page's closing sentence must keep apart.
    const shown = n.movers.reduce((s, m) => s + m.delta_pts, 0);
    check(
      n.movers_delta_sum != null && Math.abs(n.movers_delta_sum - shown) <= TOL,
      `${tri}: movers_delta_sum ${n.movers_delta_sum} != the sum of the shown deltas ` +
        `${shown.toFixed(4)}`,
    );
    check(
      n.delta_pre_mix != null &&
        n.delta_post_mix != null &&
        Math.abs(n.delta_pre_mix * (1 - n.results_w) - n.delta_post_mix) <= TOL,
      `${tri}: delta_post_mix ${n.delta_post_mix} != delta_pre_mix ${n.delta_pre_mix} × ` +
        `(1 − results_w ${n.results_w}) = ` +
        `${((n.delta_pre_mix ?? 0) * (1 - n.results_w)).toFixed(4)}`,
    );
    check(
      (n.n_movers_total ?? 0) >= n.movers.length,
      `${tri}: n_movers_total ${n.n_movers_total} is smaller than the ${n.movers.length} shipped`,
    );

    for (const m of n.movers) {
      check(DIRECTIONS.has(m.direction), `${tri}/${m.name}: unknown direction "${m.direction}"`);
      // 🔴 −1 is the replacement-level slot an absence's minutes were diverted
      // to. It is never a person, and the page must never link it.
      if (m.athlete_id === -1) {
        absorbedSlots += 1;
        check(
          m.direction === "absorbed",
          `${tri}: athlete_id −1 carries direction "${m.direction}" — the −1 slot is the next man ` +
            `up, never a person, and only ever "absorbed"`,
        );
      } else {
        check(
          m.direction !== "absorbed",
          `${tri}/${m.name}: direction "absorbed" on a real athlete_id ${m.athlete_id}`,
        );
        check(m.athlete_id > 0, `${tri}/${m.name}: athlete_id ${m.athlete_id}`);
      }
      // "out" is the word for a man who did not play, not for a minutes dip.
      if (m.direction === "out") {
        check(
          m.games_played_of_last_n === 0,
          `${tri}/${m.name}: called "out" having played ${m.games_played_of_last_n} of the window`,
        );
      }
      check(
        m.minutes_last_n >= 0 && m.minutes_typical >= 0,
        `${tri}/${m.name}: negative minutes (${m.minutes_last_n} / ${m.minutes_typical})`,
      );
    }
  }
  check(withMovers >= 25, `only ${withMovers} teams carry movers — expected nearly all 30`);
  check(
    teamsFile.nightly_league_typical_shift != null,
    "hoops_teams.json: nightly_league_typical_shift missing — the league-wide drift has to be " +
      "published apart from the movers, or it gets charged to somebody's name",
  );
  check(
    (teamsFile.nightly_movers_note ?? "").length > 40,
    "hoops_teams.json: nightly_movers_note missing — every block on this site carries its own " +
      "explanation, always visible",
  );
  notes.push(
    `bundle: ${withMovers}/${priced} priced teams explained, ${abstained} abstained (all ` +
      `unexplained), ${absorbedSlots} next-man-up slots, sums and the mix identity hold at ${TOL}`,
  );
}

// ── 3. real basketball, from a second source ──────────────────────────────
//
// espn_player_box (hoops-sim's own, checked there, not by anything here) says
// Giannis Antetokounmpo played NONE of Milwaukee's last ten games of 2025-26
// and Jayson Tatum played SEVEN of Boston's after missing most of the season.
// Each must therefore be his team's biggest mover, in the right direction, and
// by enough that the anchor is not a coin flip.
{
  const ANCHORS: Array<{
    tri: string;
    athleteId: number;
    name: string;
    direction: RawNightlyMover["direction"];
    played: number | null;
    sign: 1 | -1;
  }> = [
    {
      tri: "MIL",
      athleteId: 3032977,
      name: "Giannis Antetokounmpo",
      direction: "out",
      played: 0,
      sign: -1,
    },
    { tri: "BOS", athleteId: 4065648, name: "Jayson Tatum", direction: "back", played: null, sign: 1 },
  ];
  for (const a of ANCHORS) {
    const n = teamsFile.teams[a.tri]?.nightly;
    const movers = n?.movers ?? null;
    if (!movers || movers.length === 0) {
      check(false, `${a.tri} ships no movers, so the ${a.name} anchor cannot be checked`);
      continue;
    }
    const top = movers[0];
    // 🔴 If either man has left the league (or the team), this list is STALE —
    // say so, rather than reporting it as a decomposition bug.
    const onRoster = movers.some((m) => m.athlete_id === a.athleteId);
    check(
      onRoster,
      `the movers anchor list is STALE: athlete ${a.athleteId} (${a.name}) is no longer among ` +
        `${a.tri}'s movers. If he has left ${a.tri} or the league, pick a current anchor; this is ` +
        `not evidence of a bug in the decomposition.`,
    );
    if (!onRoster) continue;
    check(
      top.athlete_id === a.athleteId,
      `${a.tri}'s biggest mover is ${top.name} (${top.delta_pts}), not ${a.name} — real box scores ` +
        `say ${a.name} is the story of that team's last ten games`,
    );
    if (top.athlete_id !== a.athleteId) continue;
    check(
      top.direction === a.direction,
      `${a.name} is called "${top.direction}", but he is "${a.direction}" in the real box scores`,
    );
    if (a.played != null) {
      check(
        top.games_played_of_last_n === a.played,
        `${a.name} is shown as playing ${top.games_played_of_last_n} of the last ten; the box ` +
          `scores say ${a.played}`,
      );
    }
    check(
      Math.sign(top.delta_pts) === a.sign,
      `${a.name} moved ${a.tri} by ${top.delta_pts}, the wrong way for "${a.direction}"`,
    );
    const runnerUp = movers[1] ? Math.abs(movers[1].delta_pts) : 0;
    check(
      Math.abs(top.delta_pts) - runnerUp > 1.2,
      `${a.name} leads ${a.tri}'s movers by only ` +
        `${(Math.abs(top.delta_pts) - runnerUp).toFixed(2)} a game — too close for the anchor to ` +
        `mean anything`,
    );
  }
  notes.push(
    "anchors: Giannis is MIL's biggest mover (out, none of the last ten) and Tatum BOS's (back), " +
      "each clear of the runner-up by more than 1.2 a game",
  );
}

// ── 4. round trip through the REAL schema and the REAL INSERT ─────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-movers-check-"));
  const cwd = process.cwd();
  let db: import("better-sqlite3").Database | null = null;
  try {
    process.chdir(tmp);
    const { getDb } = await import(path.join(ROOT, "lib/db.ts"));
    db = getDb() as import("better-sqlite3").Database;

    const teamCols = (
      db.prepare(`PRAGMA table_info(hoops_teams)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const c of MOVER_TEAM_COLS) {
      check(teamCols.includes(c), `lib/db.ts: hoops_teams has no ${c} column`);
    }
    const paramCols = (
      db.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const c of MOVER_PARAM_COLS) {
      check(paramCols.includes(c), `lib/db.ts: hoops_params has no ${c} column`);
    }

    // The REAL INSERT text, lifted from import.ts and bound BY COLUMN NAME, so
    // a reordered column list cannot silently land a value in the wrong slot.
    const src = fs.readFileSync(path.join(ROOT, "lib/hoops/import.ts"), "utf-8");
    const m = src.match(/INSERT INTO hoops_teams\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/)!;
    const cols = m[1].split(",").map((c) => c.trim()).filter(Boolean);
    const unknown = cols.filter((c) => !teamCols.includes(c));
    check(
      unknown.length === 0,
      `import.ts writes hoops_teams column(s) the schema lacks: ${unknown.join(", ")}`,
    );

    if (problems.length === 0) {
      const ins = db.prepare(
        `INSERT INTO hoops_teams (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      );
      const bindTeam = (tri: string): unknown[] => {
        const t = teamsFile.teams[tri];
        const n = t.nightly;
        const byName: Record<string, unknown> = {
          tri,
          conference: t.conference,
          division: t.division,
          results_off: t.results.off,
          results_def: t.results.def,
          roster_off: t.roster.off,
          roster_def: t.roster.def,
          blend_off: t.blend.off,
          blend_def: t.blend.def,
          nightly_off: n?.off ?? null,
          nightly_def: n?.def ?? null,
          nightly_results_w: n?.results_w ?? null,
          nightly_n_basis_games: n?.n_basis_games ?? null,
          nightly_abstained: n ? (n.abstained ? 1 : 0) : null,
          nightly_movers_json: n?.movers ? JSON.stringify(n.movers) : null,
          nightly_delta_pre_mix: n?.delta_pre_mix ?? null,
          nightly_delta_post_mix: n?.delta_post_mix ?? null,
          nightly_n_movers_total: n?.n_movers_total ?? null,
          nightly_movers_delta_sum: n?.movers_delta_sum ?? null,
        };
        return cols.map((c) => byName[c] ?? null);
      };
      for (const tri of ["MIL", "BOS"]) ins.run(...bindTeam(tri));

      // A team with NO movers at all — the abstained shape, which this bundle
      // happens not to contain, driven live rather than merely asserted absent.
      const blank: Record<string, unknown> = {
        tri: "ZZQ",
        conference: "East",
        division: "Atlantic",
        results_off: 1,
        results_def: 1,
        roster_off: 1,
        roster_def: 1,
        blend_off: 1,
        blend_def: 1,
        nightly_abstained: 1,
      };
      ins.run(...cols.map((c) => blank[c] ?? null));

      // The read half is getTeamMovers' own SELECT and parse (queries.ts
      // imports through the "@/" alias plain node cannot resolve).
      const sel = db.prepare(
        `SELECT nightly_movers_json, nightly_delta_pre_mix, nightly_delta_post_mix,
                nightly_n_movers_total, nightly_movers_delta_sum
         FROM hoops_teams WHERE tri = ?`,
      );
      for (const tri of ["MIL", "BOS"]) {
        const row = sel.get(tri) as Record<string, unknown>;
        const want = teamsFile.teams[tri].nightly!;
        check(
          typeof row.nightly_movers_json === "string" &&
            JSON.stringify(JSON.parse(row.nightly_movers_json as string)) ===
              JSON.stringify(want.movers),
          `${tri}: the movers block changed on the trip through SQLite`,
        );
        check(
          row.nightly_delta_pre_mix === want.delta_pre_mix &&
            row.nightly_delta_post_mix === want.delta_post_mix &&
            row.nightly_n_movers_total === want.n_movers_total &&
            row.nightly_movers_delta_sum === want.movers_delta_sum,
          `${tri}: a movers scalar changed on the trip through SQLite — ` +
            `${JSON.stringify(row)}`,
        );
      }
      const blankRow = sel.get("ZZQ") as Record<string, unknown>;
      check(
        blankRow.nightly_movers_json === null && blankRow.nightly_delta_pre_mix === null,
        `a team with no movers came back as ${JSON.stringify(blankRow)} — it must stay NULL so ` +
          `getTeamMovers returns null and the block does not render; an empty list would read as ` +
          `"nobody moved" when the truth is "we never re-priced this team"`,
      );
      notes.push("round trip: MIL and BOS identical through the real schema + INSERT; a team with no read stays NULL");
    }
  } finally {
    db?.close();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 5. the read model and the page keep their promises ────────────────────
{
  const q = fs.readFileSync(path.join(ROOT, "lib/hoops/queries.ts"), "utf-8");
  check(
    /export function getTeamMovers/.test(q),
    "queries.ts: getTeamMovers is gone — the team page has no read",
  );
  check(
    /if \(!row\?\.nightly_movers_json\) return null;/.test(q),
    "queries.ts: getTeamMovers no longer returns null when the blob is absent",
  );
  check(
    /leagueTypicalShift/.test(q) && /nightly_league_typical_shift/.test(q),
    "queries.ts: NightlyMeta has lost leagueTypicalShift — the league-wide drift would go unsaid",
  );
  check(
    /SELECT \* FROM hoops_teams ORDER BY tri/.test(q),
    "queries.ts: getTeamRows no longer returns the raw row",
  );

  const page = fs.readFileSync(
    path.join(ROOT, "app/hoops/teams/[tri]/page.tsx"),
    "utf-8",
  );
  check(
    /\{movers && \(/.test(page),
    "the team page renders What moved unconditionally — a team with no read would get an empty block",
  );
  check(
    /athlete_id === -1/.test(page) && /next man up/.test(page),
    "the team page does not special-case athlete_id −1 — the absorption slot would be rendered as " +
      "a person and linked to a player page that cannot exist",
  );
  notes.push("read model + page: movers read nulls out cleanly, the −1 slot is never a person");
}

// ── report ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error("hoops movers check: FAIL");
  for (const p of problems.slice(0, 12)) console.error(`  ✗ ${p}`);
  if (problems.length > 12) console.error(`  … and ${problems.length - 12} more`);
  process.exit(1);
}
console.log("hoops movers check: PASS");
