#!/usr/bin/env node
//
// The hoops read-model gate. Runs as `prebuild`, so `npm run build` — the
// project's type gate — is also the data gate. Exits non-zero, loudly, on any
// problem; that is the whole point.
//
//   npm run check:hoops        (standalone)
//   npm run build              (runs this first via prebuild)
//
// What it is, and what it deliberately is not:
//
//   This is NOT the export agreeing with itself. hoops-sim's own
//   `validate_export` already does the producer-side checks. This asserts the
//   committed bundle against things that are true INDEPENDENTLY of it:
//
//     • the real NBA — 30 franchises with fixed conference/division
//       assignments (lib/hoops/nba-franchises.json), an 82-game schedule,
//       1,230 games, and games that cannot end tied;
//     • mathematics — a probability row sums to 1, a CDF is monotone from 0
//       to 1, a grid is its own declared min/max/step;
//     • the engine's declared contract (lib/hoops/blob-contract.json) — the
//       stale-blob guard. A blob from an older fit fails the BUILD rather
//       than silently producing wrong simulations three milestones later.
//
//   Landmine regressions, both carried over from hoops-sim's CLAUDE.md:
//     • hoops_lines.json must never carry score columns (the line provider
//       disagrees with the truth on 3/1315 games; real finals live only in
//       hoops_results.json).
//     • hoops_results.json must never contain a tied final (the symptom of
//       reading a stale "End of period" play-by-play row instead of dim_game).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "hoops-data");

const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "lib", "hoops", "blob-contract.json"), "utf-8"),
);
const FRANCHISES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "lib", "hoops", "nba-franchises.json"), "utf-8"),
).franchises;

const TRIS = Object.keys(FRANCHISES).sort();

// Known-true NBA structure. 30 teams × 82 games / 2 = 1,230.
const N_TEAMS = 30;
const GAMES_PER_TEAM = 82;
const N_SCHEDULE_GAMES = (N_TEAMS * GAMES_PER_TEAM) / 2;

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}

function check(cond, msg) {
  if (!cond) fail(msg);
}

function readJson(name) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) {
    fail(
      `${name}: missing. Run \`uv run hoops export-hub ${DATA}\` from ~/Code/hoops-sim and commit the result.`,
    );
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    fail(`${name}: not valid JSON — ${err.message}`);
    return null;
  }
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// ───────────────────────────────────────────────────────────── params ──

function checkParams(file) {
  if (!file) return;
  const ps = file.parameter_set;
  if (!ps) return fail("hoops_params.json: missing parameter_set");

  // 🔴 The stale-blob guard.
  check(
    ps.param_version === CONTRACT.paramVersion,
    `STALE BLOB: hoops_params.json is PARAM_VERSION "${ps.param_version}", the engine expects ` +
      `"${CONTRACT.paramVersion}" (lib/hoops/blob-contract.json). Re-export from hoops-sim, and ` +
      `only bump the contract after confirming the engine still matches the fit.`,
  );

  const dims = [
    ["n_tables", CONTRACT.nTables],
    ["n_start_types", CONTRACT.nStartTypes],
    ["n_duration_rows", CONTRACT.nDurationRows],
    ["n_outcome_classes", CONTRACT.nOutcomeClasses],
    ["n_regulation_periods", CONTRACT.nRegulationPeriods],
    ["n_margin_buckets", CONTRACT.nMarginBuckets],
  ];
  for (const [key, want] of dims) {
    check(ps[key] === want, `hoops_params.json: ${key} is ${ps[key]}, contract says ${want}`);
  }

  const K = Array.isArray(ps.categories) ? ps.categories.length : 0;
  check(K > 0, "hoops_params.json: categories is empty");
  check(
    ps.points?.length === K && ps.outcome_class_of_category?.length === K,
    `hoops_params.json: points/outcome_class_of_category disagree with categories (K=${K})`,
  );
  notes.push(`K (fitted outcome categories) = ${K}`);

  // Declared dimensions vs actual array shapes.
  const matrix = (name, arr, rows, cols) => {
    check(
      Array.isArray(arr) && arr.length === rows,
      `hoops_params.json: ${name} has ${arr?.length} rows, expected ${rows}`,
    );
    if (!Array.isArray(arr)) return;
    const badRow = arr.findIndex((r) => !Array.isArray(r) || r.length !== cols);
    check(badRow === -1, `hoops_params.json: ${name}[${badRow}] has wrong width (expected ${cols})`);
    const badVal = arr.findIndex((r) => Array.isArray(r) && r.some((v) => !finite(v)));
    check(badVal === -1, `hoops_params.json: ${name}[${badVal}] contains a non-finite value`);
  };
  const vector = (name, arr, len) => {
    check(
      Array.isArray(arr) && arr.length === len,
      `hoops_params.json: ${name} has length ${arr?.length}, expected ${len}`,
    );
    if (Array.isArray(arr)) {
      check(arr.every(finite), `hoops_params.json: ${name} contains a non-finite value`);
    }
  };

  matrix("theta_grid", ps.theta_grid, CONTRACT.nTables, CONTRACT.gridSize);
  matrix("base_probs", ps.base_probs, CONTRACT.nTables, K);
  matrix(
    "duration_cumprobs",
    ps.duration_cumprobs,
    CONTRACT.nDurationRows,
    CONTRACT.durationBinEdges,
  );
  matrix("transition_cumprobs", ps.transition_cumprobs, CONTRACT.nOutcomeClasses, CONTRACT.nStartTypes);
  vector("grid_ppp", ps.grid_ppp, CONTRACT.gridSize);
  vector("base_mean_ppp", ps.base_mean_ppp, CONTRACT.nTables);
  vector("duration_bin_edges", ps.duration_bin_edges, CONTRACT.durationBinEdges);
  vector("duration_table_mean", ps.duration_table_mean, CONTRACT.nDurationRows);
  vector("margin_feedback_ppp", ps.margin_feedback_ppp, CONTRACT.nMarginBuckets);
  vector("margin_feedback_n", ps.margin_feedback_n, CONTRACT.nMarginBuckets);
  check(
    ps.table_labels?.length === CONTRACT.nTables,
    `hoops_params.json: table_labels has ${ps.table_labels?.length}, expected ${CONTRACT.nTables}`,
  );

  // Mathematics, not convention: an outcome-probability row sums to 1. The
  // blob is rounded to 4dp, so K=18 categories can drift by up to 9e-4.
  if (Array.isArray(ps.base_probs)) {
    let worst = 0;
    let worstRow = -1;
    ps.base_probs.forEach((row, i) => {
      const s = row.reduce((a, b) => a + b, 0);
      if (Math.abs(s - 1) > worst) {
        worst = Math.abs(s - 1);
        worstRow = i;
      }
    });
    check(
      worst <= 2e-3,
      `hoops_params.json: base_probs[${worstRow}] sums to ${(1 + worst).toFixed(6)}, not 1`,
    );
    notes.push(`base_probs worst row-sum error = ${worst.toExponential(1)}`);
  }

  // A CDF runs 0 → 1, monotonically.
  if (Array.isArray(ps.duration_cumprobs)) {
    ps.duration_cumprobs.forEach((row, i) => {
      if (!Array.isArray(row)) return;
      check(Math.abs(row[0]) < 1e-9, `duration_cumprobs[${i}] starts at ${row[0]}, not 0`);
      check(
        Math.abs(row[row.length - 1] - 1) < 1e-6,
        `duration_cumprobs[${i}] ends at ${row[row.length - 1]}, not 1`,
      );
      for (let j = 1; j < row.length; j++) {
        if (row[j] < row[j - 1] - 1e-9) {
          fail(`duration_cumprobs[${i}] is not monotone at index ${j}`);
          break;
        }
      }
    });
  }
  if (Array.isArray(ps.transition_cumprobs)) {
    ps.transition_cumprobs.forEach((row, i) => {
      check(
        Math.abs(row[row.length - 1] - 1) < 1e-6,
        `transition_cumprobs[${i}] ends at ${row[row.length - 1]}, not 1`,
      );
    });
  }

  // The PPP grid is its own declared min/max/step.
  if (Array.isArray(ps.grid_ppp)) {
    const g = ps.grid_ppp;
    check(
      Math.abs(g[0] - CONTRACT.gridPppMin) < 1e-9,
      `grid_ppp starts at ${g[0]}, contract says ${CONTRACT.gridPppMin}`,
    );
    check(
      Math.abs(g[g.length - 1] - CONTRACT.gridPppMax) < 1e-9,
      `grid_ppp ends at ${g[g.length - 1]}, contract says ${CONTRACT.gridPppMax}`,
    );
    const badStep = g.findIndex((v, i) => i > 0 && Math.abs(v - g[i - 1] - CONTRACT.gridPppStep) > 1e-9);
    check(badStep === -1, `grid_ppp step breaks at index ${badStep}`);
  }
  if (Array.isArray(ps.duration_bin_edges)) {
    const d = ps.duration_bin_edges;
    check(d[0] === 0, `duration_bin_edges starts at ${d[0]}, not 0`);
    const badStep = d.findIndex((v, i) => i > 0 && Math.abs(v - d[i - 1] - 1) > 1e-9);
    check(badStep === -1, `duration_bin_edges step breaks at index ${badStep}`);
  }

  check(!!file.constants && finite(file.constants.blend_weight), "hoops_params.json: constants missing");
  notes.push(`fit ${ps.param_version} · data as of ${ps.data_as_of}`);
}

// ────────────────────────────────────────────────────────────── teams ──

function checkTeams(file) {
  if (!file) return;
  const teams = file.teams ?? {};
  const got = Object.keys(teams).sort();

  check(got.length === N_TEAMS, `hoops_teams.json: expected ${N_TEAMS} teams, got ${got.length}`);

  // EXTERNAL: the actual NBA franchise list.
  const missing = TRIS.filter((t) => !got.includes(t));
  const extra = got.filter((t) => !TRIS.includes(t));
  check(missing.length === 0, `hoops_teams.json: missing franchises ${missing.join(", ")}`);
  check(extra.length === 0, `hoops_teams.json: unknown tri codes ${extra.join(", ")}`);

  for (const [tri, t] of Object.entries(teams)) {
    const truth = FRANCHISES[tri];
    if (!truth) continue;
    // EXTERNAL: conference/division are facts about the league, not the fit.
    check(
      t.conference === truth.conference,
      `hoops_teams.json: ${tri} is in the ${t.conference}, the NBA says ${truth.conference}`,
    );
    check(
      t.division === truth.division,
      `hoops_teams.json: ${tri} division is ${t.division}, the NBA says ${truth.division}`,
    );
    for (const mode of ["results", "roster", "blend"]) {
      const r = t[mode];
      check(!!r, `hoops_teams.json: ${tri} has no ${mode} rating`);
      if (!r) continue;
      check(
        finite(r.off) && finite(r.def),
        `hoops_teams.json: ${tri}.${mode} has a non-finite rating`,
      );
      check(
        Math.abs(r.off) < 40 && Math.abs(r.def) < 40,
        `hoops_teams.json: ${tri}.${mode} rating is implausible (${r.off}/${r.def})`,
      );
    }
  }

  // EXTERNAL: 15 per conference, 6 divisions of 5.
  const byConf = {};
  const byDiv = {};
  for (const t of Object.values(teams)) {
    byConf[t.conference] = (byConf[t.conference] ?? 0) + 1;
    byDiv[t.division] = (byDiv[t.division] ?? 0) + 1;
  }
  check(
    byConf.East === 15 && byConf.West === 15,
    `hoops_teams.json: conference split is ${JSON.stringify(byConf)}, expected 15/15`,
  );
  check(
    Object.keys(byDiv).length === 6 && Object.values(byDiv).every((n) => n === 5),
    `hoops_teams.json: division sizes are ${JSON.stringify(byDiv)}, expected six divisions of 5`,
  );

  check(finite(file.hca_pts) && file.hca_pts > 0 && file.hca_pts < 6, `hoops_teams.json: hca_pts ${file.hca_pts} is implausible`);
}

// ──────────────────────────────────────────────────────────── players ──

function checkPlayers(file) {
  if (!file) return;
  const players = file.players ?? [];
  check(players.length > 0, "hoops_players.json: no players");

  const perTeam = {};
  const seen = new Set();
  for (const p of players) {
    check(TRIS.includes(p.team), `hoops_players.json: ${p.name} has unknown team "${p.team}"`);
    // The producer's own gate enforces this; assert it survived the trip.
    check(finite(p.minutes), `hoops_players.json: ${p.name} has non-finite minutes`);
    check(
      !finite(p.minutes) || (p.minutes > 0 && p.minutes <= 48),
      `hoops_players.json: ${p.name} has implausible minutes ${p.minutes}`,
    );
    check(!seen.has(p.athlete_id), `hoops_players.json: duplicate athlete_id ${p.athlete_id}`);
    seen.add(p.athlete_id);
    perTeam[p.team] = (perTeam[p.team] ?? 0) + 1;
  }

  for (const tri of TRIS) {
    // An NBA team carries a minimum of 14 under contract; 10 is a floor no
    // real roster can fall below, so a short one means a dropped join.
    check(
      (perTeam[tri] ?? 0) >= 10,
      `hoops_players.json: ${tri} has only ${perTeam[tri] ?? 0} players`,
    );
  }

  const noValue = players.filter((p) => p.value_per36 == null).length;
  notes.push(
    `${players.length} players · ${noValue} without a value (no-history rookies — allowed)`,
  );
}

// ─────────────────────────────────────────── schedule / results / lines ──

function checkSchedule(file) {
  if (!file) return null;
  const games = file.games ?? [];

  // EXTERNAL: an NBA regular season is 82 games each, 1,230 in total.
  check(
    games.length === N_SCHEDULE_GAMES,
    `hoops_schedule.json: ${games.length} games, an NBA regular season is ${N_SCHEDULE_GAMES}`,
  );

  const ids = new Set();
  const played = {};
  for (const g of games) {
    check(!ids.has(g.game_id), `hoops_schedule.json: duplicate game_id ${g.game_id}`);
    ids.add(g.game_id);
    check(g.home !== g.away, `hoops_schedule.json: ${g.game_id} has ${g.home} playing itself`);
    check(TRIS.includes(g.home), `hoops_schedule.json: unknown home team ${g.home}`);
    check(TRIS.includes(g.away), `hoops_schedule.json: unknown away team ${g.away}`);
    check(
      typeof g.date === "string" && !Number.isNaN(Date.parse(g.date)),
      `hoops_schedule.json: ${g.game_id} has unparseable date ${g.date}`,
    );
    played[g.home] = (played[g.home] ?? 0) + 1;
    played[g.away] = (played[g.away] ?? 0) + 1;
  }
  const wrong = TRIS.filter((t) => played[t] !== GAMES_PER_TEAM);
  check(
    wrong.length === 0,
    `hoops_schedule.json: ${wrong.map((t) => `${t}=${played[t] ?? 0}`).join(", ")} — every team plays ${GAMES_PER_TEAM}`,
  );

  return { ids, byId: new Map(games.map((g) => [g.game_id, g])) };
}

function checkResults(file) {
  if (!file) return;
  const games = file.games ?? [];
  check(games.length > 0, "hoops_results.json: no games");

  for (const g of games) {
    check(TRIS.includes(g.home) && TRIS.includes(g.away), `hoops_results.json: unknown team in ${g.game_id}`);
    check(g.home !== g.away, `hoops_results.json: ${g.game_id} has ${g.home} playing itself`);
    check(
      Number.isInteger(g.home_score) && Number.isInteger(g.away_score),
      `hoops_results.json: ${g.game_id} has non-integer scores`,
    );
    // 🔴 LANDMINE: an NBA game cannot end tied. A tie here is the signature
    // of reading a stale "End of period" pbp row instead of dim_game.
    check(
      g.home_score !== g.away_score,
      `hoops_results.json: ${g.game_id} ended ${g.home_score}-${g.away_score} — NBA games cannot end tied ` +
        `(the stale-pbp-score landmine; finals must come from dim_game)`,
    );
    const lo = Math.min(g.home_score, g.away_score);
    const hi = Math.max(g.home_score, g.away_score);
    check(
      lo >= 50 && hi <= 200,
      `hoops_results.json: ${g.game_id} score ${g.home_score}-${g.away_score} is outside any real NBA game`,
    );
  }
  notes.push(`${games.length} real finals, none tied`);
}

function checkLines(file, schedule) {
  if (!file) return;
  const lines = file.lines ?? [];
  check(lines.length > 0, "hoops_lines.json: no lines");

  // 🔴 LANDMINE: the line provider's own scores disagree with the truth on
  // 3/1315 games, so this file must never carry any.
  const scoreKey = Object.keys(lines[0] ?? {}).find((k) => k.includes("score"));
  check(
    !scoreKey,
    `hoops_lines.json carries a "${scoreKey}" column — it must supply LINES ONLY; real finals live ` +
      `in hoops_results.json (the line provider disagrees with the truth on 3/1315 games)`,
  );

  for (const l of lines) {
    if (schedule) {
      const g = schedule.byId.get(l.game_id);
      check(!!g, `hoops_lines.json: ${l.game_id} is not in the schedule`);
      if (g) {
        check(
          g.home === l.home && g.away === l.away,
          `hoops_lines.json: ${l.game_id} is ${l.away}@${l.home}, the schedule says ${g.away}@${g.home}`,
        );
      }
    }
    if (l.home_spread != null) {
      check(
        finite(l.home_spread) && Math.abs(l.home_spread) <= 40,
        `hoops_lines.json: ${l.game_id} spread ${l.home_spread} is implausible`,
      );
    }
    if (l.total != null) {
      check(
        finite(l.total) && l.total >= 150 && l.total <= 300,
        `hoops_lines.json: ${l.game_id} total ${l.total} is implausible`,
      );
    }
  }
  notes.push(`${lines.length} closing lines, all matched to a scheduled game`);
}

// ──────────────────────────────────────────────────────────── fixture ──

function checkFixture(file) {
  if (!file) return;
  // The cross-implementation fixture isn't asserted here — that's the engine
  // port's job (issue #65, which asserts the SAME file the Python side pins).
  // This only confirms the artifact it will need actually shipped, intact.
  const rungs = file.rungs ?? {};
  for (const rung of ["seeding_digest", "raw_generator_output", "uniforms", "normals"]) {
    check(rung in rungs, `hoops_fixture.json: missing rung "${rung}"`);
  }
  check(!!file.box_score, "hoops_fixture.json: missing the box_score rung");
  check(!!file.run_id && !!file.param_set, "hoops_fixture.json: missing run_id or param_set");
  // The fixture's OWN param_set is deliberately synthetic — it must NOT be
  // the production fit, or the "known box score" would move on every re-fit.
  check(
    file.param_set?.param_version !== CONTRACT.paramVersion,
    `hoops_fixture.json: param_set is the production fit "${CONTRACT.paramVersion}". It must stay ` +
      `synthetic, or the pinned result moves every time the model is re-fit.`,
  );
  check(
    file.param_set?.n_tables === CONTRACT.nTables &&
      file.param_set?.n_duration_rows === CONTRACT.nDurationRows,
    "hoops_fixture.json: param_set doesn't use the real structural constants",
  );
}

// ─────────────────────────────────────────────────────────────── run ──

const params = readJson("hoops_params.json");
const teams = readJson("hoops_teams.json");
const players = readJson("hoops_players.json");
const scheduleFile = readJson("hoops_schedule.json");
const results = readJson("hoops_results.json");
const lines = readJson("hoops_lines.json");
const fixture = readJson("hoops_fixture.json");

checkParams(params);
checkTeams(teams);
checkPlayers(players);
const schedule = checkSchedule(scheduleFile);
checkResults(results);
checkLines(lines, schedule);
checkFixture(fixture);

for (const n of notes) console.log(`  · ${n}`);

if (problems.length > 0) {
  console.error(`\nHOOPS READ-MODEL CHECK FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    `\nRegenerate with:  cd ~/Code/hoops-sim && uv run hoops export-hub ${DATA}\n`,
  );
  process.exit(1);
}

console.log(`hoops read-model check: PASS (${TRIS.length} franchises, contract ${CONTRACT.paramVersion})`);
