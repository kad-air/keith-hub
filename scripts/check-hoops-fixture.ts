#!/usr/bin/env node
//
// 🔴 THE SHARED CROSS-IMPLEMENTATION FIXTURE — the load-bearing check of the
// whole hoops engine port (HOOPS_PLAN.md §7, issues #65 and #66).
//
//   npm run check:hoops:fixture      (standalone)
//   npm run build                    (runs it via prebuild)
//
// The TypeScript engine is a SECOND IMPLEMENTATION of an engine that took a
// whole milestone to validate on the Python side. Two implementations of one
// thing silently disagreeing is this project family's single most-repeated
// bug — a units mismatch between two modules that each looked self-consistent;
// a stale-score bug that survived inside a *green* acceptance table. Neither
// was caught by either implementation checking itself.
//
// So this asserts the SAME artifact that hoops-sim's own `hoops verify`
// asserts (`check_export_hub_fixture`): hoops-data/hoops_fixture.json, a fixed
// run_id and a fixed synthetic ParameterSet producing a known result. Neither
// half can be quietly relaxed to make a run go green without the other half
// noticing. That is what makes it a genuine second source rather than the
// internal consistency this project family explicitly rejects.
//
// Five laddered rungs, cheapest failure first, so a break says WHERE it broke:
//
//   1. seeding_digest        — the blake2b key/counter derivation
//   2. raw_generator_output  — raw Philox4x64 uint64s, before any float math
//   3. uniforms              — the uint64 → [0,1) transform
//   4. normals               — the uniform → standard-normal ziggurat
//   5. box_score             — the full possession engine
//
// Runs the REAL modules (node executes the TypeScript directly), not a
// reimplementation of them — a check that tests its own copy of the code is
// worth nothing.
//
// PART 2, hoops_realblob_cases.json, exists because falsification showed the
// synthetic fixture alone is not enough. Measured, not assumed — perturbing
// the engine and re-running both:
//
//   caught by the synthetic fixture ONLY: the pace latent, the efficiency
//     latent. Production ships pace_sigma = efficiency_sigma = 0.0, so
//     against the real blob you can delete both latents and nothing notices.
//   caught by the real-blob cases ONLY: overtime (the fixture's 8 replicates
//     never tie), the end-game time buckets, the margin buckets, and applying
//     margin feedback inside the end-game window.
//   caught by both: HCA halving, the pre-transition duration row, the
//     dispersion shrink, pending-possession carry-over, the possession flip,
//     the opening tip.
//
// So both ship. Neither is decoration.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { decodeParams } from "../lib/hoops/params.ts";
import { digestHex, stream, uniform, normal } from "../lib/hoops/rng.ts";
import { simulateGame } from "../lib/hoops/engine.ts";
import type { RawParamsFile } from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(ROOT, "hoops-data", "hoops_fixture.json");

const problems: string[] = [];
const pass: string[] = [];

function eq(label: string, mine: unknown, want: unknown): void {
  if (JSON.stringify(mine) === JSON.stringify(want)) {
    pass.push(label);
  } else {
    problems.push(
      `${label}\n      TypeScript: ${JSON.stringify(mine)}\n      Python:     ${JSON.stringify(want)}`,
    );
  }
}

if (!fs.existsSync(FIXTURE_PATH)) {
  console.error(
    `hoops fixture missing: ${FIXTURE_PATH}\n` +
      `Run \`uv run hoops export-hub ${path.join(ROOT, "hoops-data")}\` from ~/Code/hoops-sim.`,
  );
  process.exit(1);
}

const text = fs.readFileSync(FIXTURE_PATH, "utf-8");
const fx = JSON.parse(text);

/**
 * uint64s exceed 2^53, so JSON.parse would silently round them —
 * 6289176228507867706 comes back as ...868000. Pull the exact decimal
 * literals straight out of the file text instead. (This bit me while building
 * the check: the port was right and the harness was wrong.)
 */
function exactIntArray(field: string): string[] {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`fixture field ${field} not found`);
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The fixture stores floats rounded to 4dp; compare on the same footing. */
const r4 = (a: Float64Array | number[]): number[] =>
  Array.from(a).map((v) => Math.round(v * 1e4) / 1e4);

const ints = (a: Float64Array): number[] => Array.from(a).map((v) => Math.round(v));

// ── Rung 1: the seeding digest ───────────────────────────────────────────
const sd = fx.rungs.seeding_digest;
eq("rung 1 · seeding_digest.key_hex", digestHex(16, [sd.namespace, fx.run_id]), sd.key_hex);
eq(
  "rung 1 · seeding_digest.counter_hex",
  digestHex(32, [sd.purpose, ...sd.coords]),
  sd.counter_hex,
);

// ── Rung 2: raw Philox4x64 output ────────────────────────────────────────
eq(
  "rung 2 · raw_generator_output",
  stream(fx.run_id, sd.purpose, ...sd.coords)
    .randomRaw(8)
    .map(String),
  exactIntArray("raw_generator_output"),
);

// ── Rung 3: uniforms ─────────────────────────────────────────────────────
const nSims: number = fx.inputs.n_sims;
eq(
  "rung 3 · uniforms.opening_tip",
  r4(uniform(nSims, fx.run_id, "opening_tip", fx.game_id)),
  fx.rungs.uniforms.opening_tip,
);
eq(
  "rung 3 · uniforms.outcome_period1_poss1",
  r4(uniform(nSims, fx.run_id, "outcome", fx.game_id, 1, 1)),
  fx.rungs.uniforms.outcome_period1_poss1,
);

// ── Rung 4: normals (the ziggurat) ───────────────────────────────────────
eq(
  "rung 4 · normals.pace_z",
  r4(normal(nSims, fx.run_id, "pace", fx.game_id)),
  fx.rungs.normals.pace_z,
);
eq(
  "rung 4 · normals.efficiency_z",
  r4(normal(nSims, fx.run_id, "efficiency", fx.game_id)),
  fx.rungs.normals.efficiency_z,
);

// ── Rung 5: the full possession engine ───────────────────────────────────
//
// expectVersion: null because the fixture's ParameterSet is deliberately
// SYNTHETIC ("hub-fixture-v1"), so the pinned result doesn't move every time
// the real model is re-fit. It still uses every real structural constant, so a
// port bug in the indexing/gather logic shows up here exactly as it would
// against the real blob. Never pass null for anything that reaches a screen.
//
// `constants` is the ratings/roster-edit block; the possession engine never
// reads it, and the fixture doesn't ship one.
const fixtureFile = {
  generated_at: "",
  parameter_set: fx.param_set,
  constants: {
    absorption_phi: 0,
    absorption_rotation_floor_minutes: 0,
    bench_default_minutes: 0,
    blend_weight: 0,
    ghost_athlete_id: -1,
    playoff_alpha: 0,
    replacement_percentile: 0,
    total_team_minutes: 0,
  },
} as unknown as RawParamsFile;

const params = decodeParams(fixtureFile, { expectVersion: null });

const result = simulateGame({
  params,
  runId: fx.run_id,
  gameId: fx.game_id,
  homeTeam: fx.home_team,
  awayTeam: fx.away_team,
  homeOff: fx.inputs.home_off,
  homeDef: fx.inputs.home_def,
  awayOff: fx.inputs.away_off,
  awayDef: fx.inputs.away_def,
  hcaPts: fx.inputs.hca_pts,
  nSims: fx.inputs.n_sims,
  neutralSite: fx.inputs.neutral_site,
});

const box = fx.box_score;
eq("rung 5 · box_score.final_home_score", ints(result.finalHomeScore), box.final_home_score);
eq("rung 5 · box_score.final_away_score", ints(result.finalAwayScore), box.final_away_score);
eq("rung 5 · box_score.margin", ints(result.margin), box.margin);
eq("rung 5 · box_score.total", ints(result.total), box.total);
eq("rung 5 · box_score.poss_count_home", ints(result.possCountHome), box.poss_count_home);
eq("rung 5 · box_score.poss_count_away", ints(result.possCountAway), box.poss_count_away);
eq("rung 5 · box_score.n_ot_periods", ints(result.nOtPeriods), box.n_ot_periods);
eq("rung 5 · box_score.mean_margin", Math.round(result.meanMargin * 1e4) / 1e4, box.mean_margin);
eq("rung 5 · box_score.mean_total", Math.round(result.meanTotal * 1e4) / 1e4, box.mean_total);

// ── Part 2: the real-blob cases ──────────────────────────────────────────
//
// Same engine, same cross-implementation discipline, but against the ACTUAL
// shipped ParameterSet — K=18, the 206-point grid, the real end-game tables,
// and enough replicates to reach overtime.
const CASES_PATH = path.join(ROOT, "hoops-data", "hoops_realblob_cases.json");
const PARAMS_PATH = path.join(ROOT, "hoops-data", "hoops_params.json");

if (!fs.existsSync(CASES_PATH)) {
  console.error(
    `real-blob cases missing: ${CASES_PATH}\n` +
      `Generate with:  cd ~/Code/hoops-sim && uv run python ${path.join(ROOT, "scripts", "gen_real_blob_cases.py")}`,
  );
  process.exit(1);
}

const paramsBytes = fs.readFileSync(PARAMS_PATH);
const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf-8"));

// The pinned results belong to specific blob bytes. If the blob is
// regenerated, this evidence has to be re-established rather than assumed to
// carry over — so this FAILS rather than skipping. Softening it to a skip
// would quietly delete the only coverage of overtime and the end-game tables.
const paramsHash = createHash("sha256").update(paramsBytes).digest("hex");
if (paramsHash !== cases.params_sha256) {
  console.error(
    `\nREAL-BLOB CASES ARE STALE — hoops_params.json has changed since they were generated.\n\n` +
      `  cases were built from: ${cases.params_sha256.slice(0, 16)}…\n` +
      `  hoops_params.json is:  ${paramsHash.slice(0, 16)}…\n\n` +
      `Regenerate them (the blob refresh is a two-command job, this is the second):\n` +
      `  cd ~/Code/hoops-sim && uv run python ${path.join(ROOT, "scripts", "gen_real_blob_cases.py")}\n`,
  );
  process.exit(1);
}

const realParams = decodeParams(JSON.parse(paramsBytes.toString("utf-8")));
let otReplicates = 0;
for (const c of cases.cases) {
  const r = simulateGame({
    params: realParams,
    runId: cases.run_id,
    gameId: `xc-${c.home}-${c.away}`,
    homeTeam: c.home,
    awayTeam: c.away,
    homeOff: c.home_off,
    homeDef: c.home_def,
    awayOff: c.away_off,
    awayDef: c.away_def,
    hcaPts: cases.hca_pts,
    nSims: cases.n_sims,
    neutralSite: c.neutral_site,
  });
  const tag = `real blob · ${c.home} vs ${c.away}`;
  eq(`${tag} · final_home_score`, ints(r.finalHomeScore), c.final_home_score);
  eq(`${tag} · final_away_score`, ints(r.finalAwayScore), c.final_away_score);
  eq(`${tag} · poss_count_home`, ints(r.possCountHome), c.poss_count_home);
  eq(`${tag} · poss_count_away`, ints(r.possCountAway), c.poss_count_away);
  eq(`${tag} · n_ot_periods`, ints(r.nOtPeriods), c.n_ot_periods);
  otReplicates += Array.from(r.nOtPeriods).filter((v) => v > 0).length;
}

// Guard the guard: if a future blob or case set stopped reaching overtime,
// this check would still pass while silently covering less. Say so instead.
if (otReplicates === 0) {
  problems.push(
    "real-blob cases no longer reach overtime — the OT path is uncovered. " +
      "Pick matchups closer to a coin flip in scripts/gen_real_blob_cases.py.",
  );
}

// ── Report ───────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(
    `\nSHARED FIXTURE FAILED — the TypeScript engine disagrees with Python on ` +
      `${problems.length} of ${problems.length + pass.length} assertions:\n`,
  );
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    `\nThe rungs are ordered so the FIRST failure localises the break: digest → raw Philox →\n` +
      `uniforms → normals → engine. Fix the earliest failing rung first; later ones are\n` +
      `usually downstream of it. The same fixture is asserted by \`uv run hoops verify\` in\n` +
      `~/Code/hoops-sim — if that also fails, the Python side moved and this file is stale.\n`,
  );
  process.exit(1);
}

console.log(
  `hoops shared fixture: PASS (${pass.length} assertions)\n` +
    `  · 5 rungs on the synthetic fixture — digest, raw Philox, uniforms, ziggurat normals, box score\n` +
    `  · ${cases.cases.length} real-blob matchups x ${cases.n_sims} replicates, ` +
    `${otReplicates} reaching overtime, every per-replicate value identical to Python`,
);
