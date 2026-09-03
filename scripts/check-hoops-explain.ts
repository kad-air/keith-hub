#!/usr/bin/env node
//
// THE EXPLAIN BLOCK — the player page's "how we got here".
//
//   npm run check:hoops:explain   (standalone)
//   npm run build                 (runs via prebuild)
//
// WHAT THIS PROVES. The bundle ships, per player, the ingredients of his stack
// rating: the wage sheet's read of his box line (itemised), his plus-minus
// history, the weights that mixed them, the aging offset, and what seven
// seasons of tape moved him by. The page prints those as a ledger that is
// supposed to ADD UP to the rating. The ways it can quietly stop adding up:
//
//   • the importer drops the blob on the floor (the value_off_per36 story),
//   • the read model returns a blob for a different player, or a stale one,
//   • the exporter's per-36 conversion drifts from the stack fields on the
//     same row, so the page's last line disagrees with the ranking's number,
//   • the ledger's arithmetic (blend, items, mu + move) stops reconciling,
//   • an existing volume keeps NULL blobs forever because the no-op check
//     never learned to force the backfill rewrite.
//
// Second source: the stack fields on the SAME row (stack_off_per36 etc.),
// which were produced by hoops-sim's own solve and are checked there against
// real-NBA anchors — not by anything in this file.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { playerRowsFromBundle } from "../lib/hoops/playervalue.ts";
import type { RawPlayersFile } from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const problems: string[] = [];
const notes: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) problems.push(msg);
};
const TOL = 3e-3;

const playersFile = JSON.parse(
  fs.readFileSync(path.join(ROOT, "hoops-data/hoops_players.json"), "utf-8"),
) as RawPlayersFile;

// ── 1. the committed bundle carries the block, and it reconciles ──────────
const rows = playerRowsFromBundle(playersFile);
const carriers = rows.filter((r) => r.value_pg != null);
const withs = carriers.filter((r) => r.explain != null);
check(
  withs.length === carriers.length && withs.length >= 400,
  `hoops_players.json: ${withs.length}/${carriers.length} stack carriers have an explain block`,
);
const model = playersFile.explain_model ?? null;
check(model != null, "hoops_players.json: explain_model block missing");

let blendChecked = 0;
let itemChecked = 0;
for (const r of withs) {
  const e = r.explain!;
  for (const side of ["off", "def"] as const) {
    const stack = side === "off" ? r.stack_off_per36 : r.stack_def_per36;
    check(
      stack != null && Math.abs(e.final[side] - stack) <= TOL,
      `${r.name}: explain.final.${side} ${e.final[side]} != stack_${side}_per36 ${stack}`,
    );
    const move = side === "off" ? e.tape.move_off : e.tape.move_def;
    check(
      Math.abs(e.mu[side] + move - e.final[side]) <= TOL,
      `${r.name}: mu + move != final on ${side}`,
    );
    if (e.prior_kind === "box+history" && !e.prior_floored && e.history && e.box && e.weights) {
      const rec =
        e.weights[side] * e.history[side] + (1 - e.weights[side]) * e.box[side] + e.aging[side];
      check(
        Math.abs(rec - e.mu[side]) <= TOL,
        `${r.name}: w*hist + (1-w)*box + aging = ${rec.toFixed(4)} != mu ${e.mu[side]} on ${side}`,
      );
      blendChecked += 1;
    }
    if (e.box) {
      const items = e.box.items.filter((it) => it.side === side);
      const sum = items.reduce((s, it) => s + it.contrib, 0);
      const base = side === "off" ? e.box.baseline_off : e.box.baseline_def;
      check(
        Math.abs(sum + base - e.box[side]) <= TOL,
        `${r.name}: sum(items) + baseline = ${(sum + base).toFixed(4)} != box.${side} ${e.box[side]}`,
      );
      if (model) {
        for (const it of items) {
          const c = model.coefficients[side][it.stat];
          check(
            c != null && Math.abs(c * (it.rate - it.league) - it.contrib) <= 5e-3,
            `${r.name}: ${it.stat} contrib ${it.contrib} != coef ${c} * (rate - league)`,
          );
        }
      }
      itemChecked += 1;
    }
  }
}
check(blendChecked >= 50, `only ${blendChecked} box+history players reconciled the blend`);
check(itemChecked >= 400, `only ${itemChecked} players reconciled the wage-sheet items`);
notes.push(
  `${withs.length} carriers: mu + move == final, final == stack fields; blend rebuilt on ` +
    `${blendChecked}, items summed on ${itemChecked}`,
);

// Sign convention, anchored on real basketball rather than on the bundle
// agreeing with itself: on the wage sheet a steal must earn defence and a
// turnover must cost offence, or the itemisation is reading the wrong sign.
if (model) {
  check(
    (model.wage_sheet.steal ?? 0) > 0 && (model.wage_sheet.turnover ?? 0) < 0,
    `explain_model.wage_sheet: steal ${model.wage_sheet.steal}, turnover ${model.wage_sheet.turnover} — a steal must be paid, a turnover charged`,
  );
  check(
    (model.wage_sheet.made_3 ?? 0) > (model.wage_sheet.made_2 ?? 0),
    `explain_model.wage_sheet: a made three (${model.wage_sheet.made_3}) must earn more than a made two (${model.wage_sheet.made_2})`,
  );
}

// ── 2. the importer writes it and the read model returns it ───────────────
{
  const src = fs.readFileSync(path.join(ROOT, "lib/hoops/import.ts"), "utf-8");
  const m = src.match(/INSERT INTO hoops_players\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/);
  check(!!m, "lib/hoops/import.ts: could not find the hoops_players INSERT");
  if (m) {
    const named = m[1].split(",").map((c) => c.trim()).filter(Boolean);
    const bound = m[2].split(",").map((c) => c.trim()).filter(Boolean);
    check(named.length === bound.length, "hoops_players INSERT names/binds mismatch");
    check(named.includes("explain_json"), "hoops_players INSERT does not write explain_json");
  }
  const mp = src.match(/INSERT INTO hoops_params\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/);
  check(
    !!mp && mp[1].includes("explain_model_json"),
    "hoops_params INSERT does not write explain_model_json",
  );
  check(
    /hasExplain/.test(src) && /explainSettled/.test(src),
    "lib/hoops/import.ts: the no-op check has not learned hasExplain/explainSettled — an existing volume would keep NULL blobs forever",
  );
  // 🔴 The BINDING, by position. Naming the column proves nothing about what
  // lands in it — the first draft of this check bound the values itself and
  // stayed green while the real importer wrote NULL (falsified at merge). So
  // read the importer's own `insPlayer.run(...)` argument list and demand that
  // the argument in explain_json's slot is the serialised block.
  if (m) {
    const named = m[1].split(",").map((c) => c.trim()).filter(Boolean);
    const runStart = src.indexOf("insPlayer.run(");
    const runEnd = src.indexOf(");", runStart);
    const args = src
      .slice(runStart + "insPlayer.run(".length, runEnd)
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/,$/, ""));
    check(
      runStart > 0 && args.length === named.length,
      `import.ts: insPlayer.run binds ${args.length} arguments for ${named.length} columns`,
    );
    const slot = named.indexOf("explain_json");
    const arg = args[slot] ?? "";
    check(
      slot >= 0 && /p\.explain/.test(arg) && /JSON\.stringify\(p\.explain\)/.test(arg),
      `import.ts: the explain_json slot binds \`${arg}\`, not the serialised block`,
    );
  }
}

// Round trip through the REAL schema (lib/db.ts, in a throwaway cwd — its
// migrations are what add explain_json/explain_model_json to a pre-existing
// table) and the REAL INSERT text lifted from import.ts, bound by column name
// so a reordered column cannot silently land in the wrong slot. queries.ts
// itself imports through the "@/" alias plain node cannot resolve, so the
// read half is the same SELECT it runs; what is under test is that the blob
// survives the trip byte for byte.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoops-explain-check-"));
const cwd = process.cwd();
try {
  process.chdir(tmp);
  const { getDb } = await import(path.join(ROOT, "lib/db.ts"));
  const db = getDb() as import("better-sqlite3").Database;
  const playerCols = (
    db.prepare(`PRAGMA table_info(hoops_players)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const paramCols = (
    db.prepare(`PRAGMA table_info(hoops_params)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  check(playerCols.includes("explain_json"), "lib/db.ts: hoops_players has no explain_json column");
  check(
    paramCols.includes("explain_model_json"),
    "lib/db.ts: hoops_params has no explain_model_json column",
  );

  const src = fs.readFileSync(path.join(ROOT, "lib/hoops/import.ts"), "utf-8");
  const m = src.match(/INSERT INTO hoops_players\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/)!;
  const cols = m[1].split(",").map((c) => c.trim()).filter(Boolean);
  const unknown = cols.filter((c) => !playerCols.includes(c));
  check(unknown.length === 0, `import.ts writes column(s) the schema lacks: ${unknown.join(", ")}`);
  if (problems.length === 0) {
    const ins = db.prepare(
      `INSERT INTO hoops_players (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    );
    const bind = (r: (typeof withs)[number]): unknown[] =>
      cols.map((c) => {
        const v = (r as unknown as Record<string, unknown>)[c];
        if (c === "explain_json") return r.explain ? JSON.stringify(r.explain) : null;
        if (c === "game_rates" || c === "per36") return v ? JSON.stringify(v) : null;
        return v ?? null;
      });
    const sample = withs.slice(0, 25);
    for (const r of sample) ins.run(...bind(r));
    for (const r of sample) {
      const got = db
        .prepare(`SELECT explain_json FROM hoops_players WHERE athlete_id = ?`)
        .get(r.athlete_id) as { explain_json: string | null } | undefined;
      check(
        !!got?.explain_json && JSON.stringify(JSON.parse(got.explain_json)) === JSON.stringify(r.explain),
        `${r.name}: explain block changed on the trip through SQLite`,
      );
    }
    notes.push(`round trip: ${sample.length} explain blocks identical through the real schema + INSERT`);
  }

  // Payload discipline: only the single-player read hydrates the blob. The
  // list reads feed a ~530-row client payload that shows none of it.
  const q = fs.readFileSync(path.join(ROOT, "lib/hoops/queries.ts"), "utf-8");
  check(
    /function getPlayer[\s\S]*?hydratePlayer\(row, true\)/.test(q),
    "queries.ts: getPlayer no longer hydrates the explain blob",
  );
  check(
    !/rows\.map\(\(r\) => hydratePlayer\(r, true\)\)/.test(q) && !/rows\.map\(hydratePlayer\)/.test(q),
    "queries.ts: a list read hydrates explain blobs (or passes map's index as the flag)",
  );
} finally {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── report ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error("hoops explain check: FAIL");
  for (const p of problems.slice(0, 12)) console.error(`  ✗ ${p}`);
  if (problems.length > 12) console.error(`  … and ${problems.length - 12} more`);
  process.exit(1);
}
console.log("hoops explain check: PASS");
