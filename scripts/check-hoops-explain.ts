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
//
// 🔴 2026-09-03 (issue #70 round 2, wing-defence.md §9e): the wage sheet
// stopped being ONE set of prices for the whole league — a group-interacted
// arm (`explain_model.positional_arm`) prices each position group's box
// events differently. Each item now ships the `coef` it was ACTUALLY priced
// at, and reconciliation reads THAT first, falling back to the pooled
// `explain_model.coefficients` only for an older bundle with no per-item
// coef at all. A second assertion (1a2, below) guards the regression a naive
// fix would miss: a sender that silently stopped shipping real per-player
// wages (items reading identical to the pooled sheet) would still satisfy
// `contrib == coef * (rate - league)` — so a real, differentiated number of
// carriers is required directly whenever the bundle isn't on the pooled arm.
// Same round: the owner's "0 = replacement player" decision (issue #70 F5)
// added `explain.replacement_per36`, cross-checked here against the player
// row's own `value_per36_above_replacement`.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { additiveTerms, compareVerdict, verdictSentence } from "../lib/hoops/compare.ts";
import { playerRowsFromBundle } from "../lib/hoops/playervalue.ts";
import { fmtSigned } from "../lib/hoops/rating.ts";
import type { RawPlayerExplain, RawPlayersFile } from "../lib/hoops/types.ts";

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
let replacementChecked = 0;
for (const r of withs) {
  const e = r.explain!;
  // Issue #70 F5 ("0 = replacement player"): explain.replacement_per36 rides
  // the SAME bundle-level constant the player row's own
  // value_per36_above_replacement was built from — cross-check them against
  // each other rather than trusting either in isolation.
  if (e.replacement_per36 != null && r.value_per36_above_replacement != null) {
    const rebuilt = e.final.off + e.final.def - e.replacement_per36;
    check(
      Math.abs(rebuilt - r.value_per36_above_replacement) <= TOL,
      `${r.name}: final.off + final.def - explain.replacement_per36 = ${rebuilt.toFixed(4)} != ` +
        `value_per36_above_replacement ${r.value_per36_above_replacement}`,
    );
    replacementChecked += 1;
  }
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
      // 🔴 Reconcile against THE ITEM'S OWN coef first (wing-defence.md §9e).
      // model.coefficients is the POOLED, league-wide sheet — on a
      // group-interacted arm (positional_arm2/3) a player is priced at his
      // OWN position group's wages, which the ridge shrinks toward the
      // pooled ones but does not equal. Reconciling against the pooled sheet
      // unconditionally is exactly the bug that promotion exposed: 3/532
      // carriers failed outright and the other 529 "near-missed" — passed a
      // loose tolerance while quietly reading the wrong number. Fall back to
      // the pooled coefficient only for an OLDER bundle whose items carry no
      // `coef` of their own at all.
      for (const it of items) {
        const c = it.coef ?? (model ? model.coefficients[side]?.[it.stat] : undefined) ?? null;
        if (c == null) continue; // no coefficient source at all — very old bundle
        check(
          Math.abs(c * (it.rate - it.league) - it.contrib) <= 5e-3,
          `${r.name}: ${it.stat} contrib ${it.contrib} != coef ${c} * (rate - league)`,
        );
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
if (replacementChecked > 0) {
  check(
    replacementChecked >= 400,
    `only ${replacementChecked} carriers reconciled explain.replacement_per36 against ` +
      `value_per36_above_replacement`,
  );
  notes.push(
    `replacement zero: ${replacementChecked} carriers' final.off + final.def - ` +
      `replacement_per36 == value_per36_above_replacement`,
  );
}

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

// ── 1a2. per-item coef is a REAL, per-player wage, not a copy of the pooled
// sheet ─────────────────────────────────────────────────────────────────
//
// The regression the coef fix above exists to guard: a sender that silently
// stopped shipping per-player wages (fell back to items identical to the
// pooled sheet) would still pass every reconciliation check above — a
// coefficient equal to the pooled one satisfies `contrib == coef * (rate -
// league)` just as well as the real one does. So this asserts the ACTUAL
// DIFFERENTIATION directly: whenever the bundle's own positional_arm isn't
// the plain pooled arm ("arm1" — one set of wages for the whole league),
// require a real, meaningful number of carriers to show at least one item
// whose coef genuinely differs from model.coefficients. Measured on the
// committed bundle (positional_arm2): 531 of 532 carriers have an item that
// differs from the pooled sheet by more than 0.01.
const POOLED_ARM = "arm1";
if (model && model.positional_arm && model.positional_arm !== POOLED_ARM) {
  const MIN_DIFFERENTIATED = 100;
  let differentiated = 0;
  for (const r of withs) {
    const items = r.explain?.box?.items ?? [];
    const differs = items.some((it) => {
      if (it.coef == null) return false;
      const pooled = model.coefficients[it.side]?.[it.stat];
      return pooled != null && Math.abs(it.coef - pooled) > 1e-3;
    });
    if (differs) differentiated += 1;
  }
  check(
    differentiated >= MIN_DIFFERENTIATED,
    `only ${differentiated}/${withs.length} carriers show a per-item coef that differs from the ` +
      `pooled sheet on positional_arm=${model.positional_arm} — the sender may have stopped ` +
      `shipping real per-player wages (items reading identical to the pooled sheet would still ` +
      `pass every reconciliation check above)`,
  );
  notes.push(
    `per-item coef: ${differentiated}/${withs.length} carriers priced off a wage that differs ` +
      `from the pooled sheet (positional_arm=${model.positional_arm})`,
  );
}

// ── 1b. the side-by-side comparison ───────────────────────────────────────
//
// /hoops/players/compare says, in one sentence, who is rated higher and what
// the single biggest reason is. Two ways that sentence can lie:
//
//   • it names a reason that is not actually the biggest gap between the two
//     ledgers (or one that double-counts, which is why the reason is picked
//     over the ADDITIVE terms and not over the printed rows — see the header
//     of lib/hoops/compare.ts),
//   • it prints a number that is not in either block.
//
// Second source for the first: the max is re-found here, longhand, straight
// off the raw JSON, without calling the module's own scan. Second source for
// the second: every figure in the sentence is extracted back out and has to
// match a quantity read off the two blocks.
{
  // Two real players from the committed bundle, chosen because they are the
  // two shapes the page has to handle at once: Jokić carries a plus-minus
  // history to mix into his scouting report, Wembanyama does not. If either
  // leaves the league, this list is stale and that is what the failure says.
  const ANCHORS: Array<[number, string]> = [
    [3112335, "Nikola Jokic"],
    [5104157, "Victor Wembanyama"],
  ];
  const picked = ANCHORS.map(([id, name]) => {
    const r = withs.find((x) => x.athlete_id === id);
    check(
      r != null && r.name === name,
      `compare anchors are stale: athlete ${id} is ${r?.name ?? "absent"}, not ${name} — pick two current players`,
    );
    return r;
  });

  // The decomposition has to ADD UP or "the biggest term" means nothing. This
  // runs over every carrier in the bundle, not just the anchors.
  let termChecked = 0;
  for (const r of withs) {
    const e = r.explain as RawPlayerExplain;
    const terms = additiveTerms(e);
    for (const side of ["off", "def"] as const) {
      const sum = terms.filter((t) => t.side === side).reduce((s, t) => s + t.value, 0);
      check(
        Math.abs(sum - e.final[side]) <= TOL,
        `${r.name}: additive terms sum to ${sum.toFixed(4)}, not final.${side} ${e.final[side]}`,
      );
    }
    termChecked += 1;
  }

  const [A, B] = picked;
  if (A?.explain && B?.explain) {
    const ae = A.explain;
    const be = B.explain;
    const aShort = A.name.split(" ").slice(-1)[0];
    const bShort = B.name.split(" ").slice(-1)[0];
    const v = compareVerdict(
      { name: aShort, e: ae, valuePg: A.value_pg },
      { name: bShort, e: be, valuePg: B.value_pg },
    );

    // Real basketball, not internal agreement: the man the bundle prices
    // higher a game must be the man the page calls higher.
    const aPg = A.value_pg ?? 0;
    const bPg = B.value_pg ?? 0;
    check(
      v.leader === (aPg >= bPg ? "a" : "b"),
      `compare: ${aShort} ${aPg} vs ${bShort} ${bPg} a game, but the verdict leads with ${v.leader}`,
    );
    check(
      Math.abs((v.gameGap ?? -1) - Math.abs(aPg - bPg)) <= 1e-9,
      `compare: gameGap ${v.gameGap} != |${aPg} − ${bPg}|`,
    );

    // 🔴 The reason, re-found longhand off the raw blocks. Nothing below calls
    // additiveTerms or compareVerdict — a bug that mis-picks in one place has
    // to be reproduced by hand here to survive.
    const fineOf = (e: RawPlayerExplain): boolean =>
      e.prior_kind === "box+history" &&
      !e.prior_floored &&
      e.box != null &&
      e.history != null &&
      e.weights != null;
    const fine = fineOf(ae) && fineOf(be);
    const byHand = (e: RawPlayerExplain, side: "off" | "def"): Record<string, number> => {
      const move = side === "off" ? e.tape.move_off : e.tape.move_def;
      if (fine && e.box && e.history && e.weights) {
        const out: Record<string, number> = {
          history: e.weights[side] * e.history[side],
          box: (1 - e.weights[side]) * e.box[side],
          tape: move,
        };
        if (e.aging[side] !== 0) out.aging = e.aging[side];
        return out;
      }
      return { scouting: e.mu[side], tape: move };
    };
    let bestKey = "";
    let bestSide: "off" | "def" = "off";
    let bestAbs = -1;
    for (const side of ["off", "def"] as const) {
      const at = byHand(ae, side);
      const bt = byHand(be, side);
      for (const k of Object.keys(at)) {
        if (!(k in bt)) continue;
        const d = Math.abs(at[k] - bt[k]);
        if (d > bestAbs) {
          bestAbs = d;
          bestKey = k;
          bestSide = side;
        }
      }
    }
    check(
      v.reason.key === bestKey && v.reason.side === bestSide,
      `compare: the sentence names ${v.reason.key}/${v.reason.side}, but the biggest gap is ${bestKey}/${bestSide} (${bestAbs.toFixed(4)})`,
    );
    check(
      Math.abs(Math.abs(v.reason.diff) - bestAbs) <= 1e-9,
      `compare: reason diff ${v.reason.diff} does not match the hand-found gap ${bestAbs}`,
    );

    // Every figure in the sentence comes off the two blocks. "36" is the only
    // literal ("points per 36 minutes"); anything else must be a quantity.
    const sentence = verdictSentence(v, aShort, bShort);
    const allowed = new Set<string>(["36"]);
    allowed.add(fmtSigned(v.aNet, 2));
    allowed.add(fmtSigned(v.bNet, 2));
    allowed.add(v.rateGap.toFixed(2));
    if (v.gameGap != null) allowed.add(v.gameGap.toFixed(2));
    allowed.add(fmtSigned(v.reason.a, 2));
    allowed.add(fmtSigned(v.reason.b, 2));
    for (const e of [ae, be]) {
      allowed.add(String(e.tape.n_off_poss));
      allowed.add(String(e.tape.n_def_poss));
    }
    const tokens = sentence.match(/[-+]?\d[\d,]*(?:\.\d+)?/g) ?? [];
    check(tokens.length >= 4, `compare: the sentence carries only ${tokens.length} figures`);
    for (const t of tokens) {
      const bare = t.replace(/,/g, "");
      check(
        allowed.has(bare),
        `compare: the sentence prints ${t}, which is not a number from either block`,
      );
    }
    // The two halves it must reconcile against, independently of the verdict:
    // the ratings it quotes are the blocks' own finals.
    check(
      Math.abs(v.aNet - (ae.final.off + ae.final.def)) <= 1e-9 &&
        Math.abs(v.bNet - (be.final.off + be.final.def)) <= 1e-9,
      "compare: the quoted rates are not off + def from the blocks",
    );
    check(
      sentence.includes(aShort) && sentence.includes(bShort),
      `compare: the sentence names neither man — "${sentence}"`,
    );
    notes.push(
      `compare: additive terms sum to the rating on ${termChecked} carriers; ` +
        `${aShort} vs ${bShort} → ${v.reason.key}/${v.reason.side}, ` +
        `${tokens.length} figures all traced back to the blocks`,
    );
  }
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
