#!/usr/bin/env node
//
// 🔴 THE BOX-SCORE GATE (issue #67's named check).
//
//   npm run check:hoops:boxscore     (standalone)
//   npm run build                    (runs it via prebuild)
//
// Runs the REAL modules against the REAL committed bundle — node executes the
// TypeScript directly, and the rosters/params come off hoops-data/*.json
// rather than a hand-built stub, so a bundle that breaks the box score fails
// the build instead of shipping.
//
// Seven things are asserted, and they are deliberately different KINDS of
// evidence rather than seven versions of the same one. Every one of them
// exists because falsification showed the others could not see the failure it
// catches — the counts and thresholds quoted below are measured, not chosen.
//
//   1. THE INTEGER IDENTITY (the issue's own check). A sampled box score's
//      player lines must sum EXACTLY to the realised team total, for every
//      stat, for every matchup, for every run_id — AND that team total must be
//      the score the ENGINE simulated, not a number the box score produced.
//      The second half is not pedantry: nudging the realised points total by
//      +1 left all 2,150 other assertions green, because every sum was then
//      taken against the nudged number.
//
//   2. THE MINUTES BUDGET. Every team's allocated minutes sum to the export's
//      own total_team_minutes constant. Read by name from the bundle, never
//      hardcoded as 240 here.
//
//   3. REPRODUCIBILITY, AND THE BATCH-SIZE TRAP. The same run_id must give a
//      byte-identical sampled game on every call — that is the entire promise
//      of /hoops/game/[runId]. A fresh nonce must give a different one, or
//      "sim another night" would replay the same night forever.
//
//      🔴 And the trap this check exists to nail shut: replicate 0 of an
//      n = 1 run is NOT replicate 0 of an n = 1000 run. `possession_counter`
//      is a whole-batch loop variable (hoops-sim's sim.py line ~355, ported
//      faithfully), so period 2's draw coordinates depend on how long the
//      SLOWEST replicate in the batch took in period 1. Verified directly:
//      the same run_id gives DEN 128-137 at n=1 and 135-134 at n=1000. So a
//      sampled game may never be built by reusing the matchup screen's
//      multi-replicate simulation — it would stop being reproducible from its
//      own run_id. buildBoxscore refuses that combination, and this asserts
//      the refusal rather than trusting a comment.
//
//   4. LEAGUE-PLAUSIBLE LEVELS — the second-source assertion. Every one of the
//      30 teams' expected totals is checked against real NBA team box-score
//      ranges, which are an external fact this repo cannot fudge. This exists
//      because the honest failure mode of the hub-side stat model is a wrong
//      LEVEL, not a wrong shape: the bundle carries no team game logs, so the
//      team total is built from per-36 rates times allocated minutes (see
//      lib/hoops/boxscore.ts). The obvious alternative — summing each player's
//      per-GAME rates — passes every internal-consistency check while
//      inflating rebounds and assists by ~30%, because a per-game rate is
//      conditioned on the games that player actually played. Only a check
//      against the real world catches that, which is exactly why it is here.
//
//   5. PACE FLOWS INTO EVERY STAT. Rebounds must track possessions across
//      sampled games of the same matchup (measured r = 0.99). Replacing each
//      replicate's own possession count with the league average — which
//      deletes the entire reason non-PTS stats are a per-possession rate —
//      leaves team levels in bounds and every sum intact, and is invisible
//      without this.
//
//   6. WHO SCORES, not just how much. Each player's share of his team's
//      projected points, against his share of the team's MEASURED points
//      (`game_rates.pts`, which is an input to nothing here). The absolute
//      points MAE cannot do this job: it carries a systematic -2.46 bias from
//      the rotation-fill mechanism, and mis-weighting three-pointers as twos
//      moves it from 2.46 to 2.50 — invisible. On shares the same
//      perturbation reads 0.192 -> 0.585.
//
//   7. run_id ROUND-TRIP. Encode → parse → identical coordinates, and every
//      malformed shape rejected, because /hoops/game/[runId] turns a parse
//      failure into a 404 and a parse SUCCESS into a simulation.
//
// KNOWN UNCOVERED, stated rather than papered over: the imputed-rates path in
// boxscore.ts (`ratesFor`'s per-game fallback) is unreachable with the current
// bundle — exactly one of 533 players lacks per-36 rates and he does not make
// any rotation. Perturbing that branch changes nothing here, correctly.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildBoxscore,
  boxscoreGameId,
  STAT_ORDER,
} from "../lib/hoops/boxscore.ts";
import type { BoxPlayer, Stat } from "../lib/hoops/boxscore.ts";
import { simulateGame } from "../lib/hoops/engine.ts";
import { encodeRunId, parseRunId } from "../lib/hoops/matchup.ts";
import { decodeParams } from "../lib/hoops/params.ts";
import { offDefOf } from "../lib/hoops/rating.ts";
import type {
  RawParamsFile,
  RawPlayersFile,
  RawTeamsFile,
  RatingMode,
  TeamRow,
} from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "hoops-data");

const problems: string[] = [];
let assertions = 0;
let fidelity = "";

function check(cond: boolean, message: string): void {
  assertions += 1;
  if (!cond) problems.push(message);
}

function read<T>(name: string): T {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) {
    console.error(
      `hoops bundle missing: ${p}\n` +
        `Run \`uv run hoops export-hub ${DATA}\` from ~/Code/hoops-sim.`,
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

const paramsFile = read<RawParamsFile>("hoops_params.json");
const teamsFile = read<RawTeamsFile>("hoops_teams.json");
const playersFile = read<RawPlayersFile>("hoops_players.json");

const params = decodeParams(paramsFile);
const hcaPts = teamsFile.hca_pts;

const rosters = new Map<string, BoxPlayer[]>();
for (const p of playersFile.players) {
  if (!rosters.has(p.team)) rosters.set(p.team, []);
  rosters.get(p.team)!.push({
    athlete_id: p.athlete_id,
    name: p.name,
    minutes: p.minutes,
    per36: p.per36,
    game_rates: p.game_rates,
  });
}

const teamRows = new Map<string, TeamRow>();
for (const [tri, t] of Object.entries(teamsFile.teams)) {
  teamRows.set(tri, {
    tri,
    conference: t.conference,
    division: t.division,
    results_off: t.results.off,
    results_def: t.results.def,
    roster_off: t.roster.off,
    roster_def: t.roster.def,
    blend_off: t.blend.off,
    blend_def: t.blend.def,
  });
}

const TRIS = [...teamRows.keys()].sort();

interface Matchup {
  home: string;
  away: string;
  neutral: boolean;
  mode: RatingMode;
}

/** Every one of the 30 teams appears exactly once, so no team's stat level
 *  goes unchecked. Rating mode and court rotate so neither is a constant. */
const SWEEP: Matchup[] = TRIS.reduce<Matchup[]>((acc, tri, i) => {
  if (i % 2 === 1) {
    const modes: RatingMode[] = ["results", "roster", "blend"];
    acc.push({
      home: TRIS[i - 1],
      away: tri,
      neutral: i % 6 === 1,
      mode: modes[(i >> 1) % 3],
    });
  }
  return acc;
}, []);

function ratings(m: Matchup) {
  const h = offDefOf(teamRows.get(m.home)!, m.mode);
  const a = offDefOf(teamRows.get(m.away)!, m.mode);
  return { homeOff: h.off, homeDef: h.def, awayOff: a.off, awayDef: a.def };
}

function boxInput(m: Matchup, runId: string, mode: "expected" | "sample", nSims?: number) {
  return {
    params,
    runId,
    home: m.home,
    away: m.away,
    homeRoster: rosters.get(m.home)!,
    awayRoster: rosters.get(m.away)!,
    ...ratings(m),
    hcaPts,
    neutralSite: m.neutral,
    mode,
    nSims,
  };
}

// ── 1 + 2. Integer identity and the minutes budget, over many run_ids ────
const BUDGET = paramsFile.constants.total_team_minutes;
let sampledGames = 0;
let otSampled = 0;
const paceProbe: Array<{ poss: number; reb: number }> = [];

for (const m of SWEEP) {
  for (let k = 0; k < 4; k++) {
    const runId = encodeRunId(
      { home: m.home, away: m.away, neutralSite: m.neutral, ratingMode: m.mode },
      `check-${k}`,
    );
    const box = buildBoxscore(boxInput(m, runId, "sample"));
    sampledGames += 1;
    if ((box.nOt ?? 0) > 0) otSampled += 1;

    for (const side of [box.home, box.away]) {
      for (const stat of STAT_ORDER) {
        const summed = side.players.reduce((s, p) => s + p.stats[stat], 0);
        check(
          summed === side.teamSim[stat],
          `${m.away}@${m.home} run ${runId} · ${side.tri} ${stat}: player lines sum to ` +
            `${summed} but the realised team total is ${side.teamSim[stat]}`,
        );
        check(
          side.players.every((p) => Number.isInteger(p.stats[stat]) && p.stats[stat] >= 0),
          `${m.away}@${m.home} · ${side.tri} ${stat}: sample mode produced a non-integer or ` +
            `negative player line`,
        );
      }
      check(
        Math.abs(side.totals.min - BUDGET) < 1e-9,
        `${m.away}@${m.home} · ${side.tri}: allocated minutes sum to ${side.totals.min}, ` +
          `not the bundle's own total_team_minutes (${BUDGET})`,
      );
    }

    // The final score IS the sum of the points column — the property that
    // makes a sampled game a real box score rather than a score with a table
    // underneath it.
    check(
      box.homeScore === box.home.players.reduce((s, p) => s + p.stats.pts, 0) &&
        box.awayScore === box.away.players.reduce((s, p) => s + p.stats.pts, 0),
      `${m.away}@${m.home} run ${runId}: final score does not equal the summed points column`,
    );

    // 🔴 And the score must be the ENGINE's, not one the box score invented.
    // Without this anchor every assertion above is satisfiable by a box score
    // that allocates a made-up total perfectly — falsification caught exactly
    // that: nudging the realised points total by +1 left all 2,150 other
    // assertions green, because the lines were then summed against the nudged
    // number rather than against the simulated game.
    const engine = simulateGame({
      params,
      runId,
      gameId: boxscoreGameId(m.home, m.away),
      homeTeam: m.home,
      awayTeam: m.away,
      ...ratings(m),
      hcaPts,
      neutralSite: m.neutral,
      nSims: 1,
    });
    check(
      box.homeScore === Math.round(engine.finalHomeScore[0]) &&
        box.awayScore === Math.round(engine.finalAwayScore[0]) &&
        box.nOt === engine.nOtPeriods[0],
      `${m.away}@${m.home} run ${runId}: the box score reports ${box.homeScore}-${box.awayScore} ` +
        `(${box.nOt} OT) but the engine simulated ` +
        `${engine.finalHomeScore[0]}-${engine.finalAwayScore[0]} (${engine.nOtPeriods[0]} OT)`,
    );
    check(
      Math.abs(box.possHome - engine.possCountHome[0]) < 1e-9 &&
        Math.abs(box.possAway - engine.possCountAway[0]) < 1e-9,
      `${m.away}@${m.home} run ${runId}: box score possessions ` +
        `(${box.possHome}/${box.possAway}) disagree with the engine's ` +
        `(${engine.possCountHome[0]}/${engine.possCountAway[0]})`,
    );

    // Pace must flow into the non-PTS stats — that is the whole reason they
    // are a per-possession rate rather than a per-game constant. Recorded per
    // game here and correlated below.
    paceProbe.push({ poss: engine.possCountHome[0], reb: box.home.totals.reb });
    check(
      box.homeScore !== box.awayScore,
      `${m.away}@${m.home} run ${runId}: a sampled game ended tied — basketball games cannot`,
    );
  }
}

// A sweep that never reaches overtime would silently stop covering the OT
// path in sample mode (the realised n_ot, and the extra period's possessions
// flowing into every stat). Say so rather than passing quietly.
check(
  otSampled > 0,
  `no sampled game in ${sampledGames} reached overtime — the realised-OT path is uncovered. ` +
    `Add run_ids or matchups closer to a coin flip.`,
);

// ── 1b. Pace really does flow into the non-PTS stats ─────────────────────
//
// Every non-PTS stat is `team rate per possession x THIS replicate's own
// possession count`. Replacing that possession count with the league average
// leaves team levels inside their bounds and every sum intact — falsification
// confirmed it slipped past every other assertion here — so the coupling is
// measured directly. Sampled games within one matchup share a roster, so
// rebounds should track possessions almost perfectly (measured: r = 0.99).
{
  const byMatchup = new Map<number, Array<{ poss: number; reb: number }>>();
  paceProbe.forEach((p, i) => {
    const key = Math.floor(i / 4); // 4 run_ids per matchup, same roster
    if (!byMatchup.has(key)) byMatchup.set(key, []);
    byMatchup.get(key)!.push(p);
  });
  let flat = 0;
  let correlated = 0;
  for (const group of byMatchup.values()) {
    const n = group.length;
    const mp = group.reduce((s, g) => s + g.poss, 0) / n;
    const mr = group.reduce((s, g) => s + g.reb, 0) / n;
    const sp = Math.sqrt(group.reduce((s, g) => s + (g.poss - mp) ** 2, 0));
    const sr = Math.sqrt(group.reduce((s, g) => s + (g.reb - mr) ** 2, 0));
    if (sp === 0) continue; // identical pace in all four — nothing to learn
    if (sr === 0) {
      flat += 1;
      continue;
    }
    const r = group.reduce((s, g) => s + (g.poss - mp) * (g.reb - mr), 0) / (sp * sr);
    if (r > 0.9) correlated += 1;
  }
  check(
    flat === 0,
    `${flat} matchups produced identical rebound totals across games with DIFFERENT possession ` +
      `counts — pace has stopped flowing into the non-PTS stats`,
  );
  check(
    correlated >= byMatchup.size - 2,
    `only ${correlated} of ${byMatchup.size} matchups show rebounds tracking possessions ` +
      `(r > 0.9) — the per-possession stat pathway is not behaving`,
  );
}

// ── 3. Reproducibility, and the batch-size trap ──────────────────────────
{
  const m = SWEEP[0];
  const coords = {
    home: m.home,
    away: m.away,
    neutralSite: m.neutral,
    ratingMode: m.mode,
  };
  const runId = encodeRunId(coords, "repro");

  // The deep-link promise: the same run_id, forever, is the same game.
  const first = buildBoxscore(boxInput(m, runId, "sample"));
  const second = buildBoxscore(boxInput(m, runId, "sample"));
  check(
    JSON.stringify(first) === JSON.stringify(second),
    `the same run_id (${runId}) produced two different sampled games — /hoops/game/[runId] ` +
      `is not reproducible`,
  );

  // A fresh nonce must actually re-roll.
  const rolls = new Set<string>();
  for (let k = 0; k < 8; k++) {
    const b = buildBoxscore(boxInput(m, encodeRunId(coords, `roll-${k}`), "sample"));
    rolls.add(`${b.homeScore}-${b.awayScore}`);
  }
  check(
    rolls.size >= 6,
    `8 different nonces produced only ${rolls.size} distinct finals — "sim another night" is ` +
      `not re-rolling`,
  );

  // 🔴 The batch-size trap. Reusing a multi-replicate simulation for a sampled
  // game would produce a game that its own run_id cannot reproduce, because
  // possession_counter is a whole-batch loop variable. buildBoxscore must
  // refuse; this asserts the refusal instead of trusting the comment above it.
  const many = simulateGame({
    params,
    runId,
    gameId: boxscoreGameId(m.home, m.away),
    homeTeam: m.home,
    awayTeam: m.away,
    ...ratings(m),
    hcaPts,
    neutralSite: m.neutral,
    nSims: 1000,
  });
  let refused = false;
  try {
    buildBoxscore({ ...boxInput(m, runId, "sample"), simulation: many });
  } catch {
    refused = true;
  }
  check(
    refused,
    `buildBoxscore accepted a 1000-replicate simulation for a sample-mode box score. ` +
      `Replicate 0 is batch-size dependent, so the resulting game would not be reproducible ` +
      `from its own run_id.`,
  );

  // And pin the finding itself, so a future change that made replicate 0
  // batch-independent shows up as a deliberate decision rather than a silent
  // one — it would mean the possession-counter scope moved, which is a
  // cross-implementation divergence from hoops-sim's sim.py.
  const one = simulateGame({
    params,
    runId,
    gameId: boxscoreGameId(m.home, m.away),
    homeTeam: m.home,
    awayTeam: m.away,
    ...ratings(m),
    hcaPts,
    neutralSite: m.neutral,
    nSims: 1,
  });
  check(
    one.finalHomeScore[0] !== many.finalHomeScore[0] ||
      one.finalAwayScore[0] !== many.finalAwayScore[0],
    `replicate 0 is now identical at n=1 and n=1000. That is a BEHAVIOUR CHANGE, not an ` +
      `improvement: hoops-sim's simulate_game scopes possession_counter to the whole batch, so ` +
      `the two must differ. Check whether the counter's scope moved — the engine would no ` +
      `longer be a faithful port.`,
  );
}

// ── 4. League-plausible levels, against the real NBA ─────────────────────
//
// Wide on purpose: these are not a fit, they are the range outside which a
// number is not a basketball number. A 2024-25 NBA team averages ~113 pts,
// ~43 reb, ~26 ast, ~7.6 stl, ~4.9 blk, ~13.5 tov per game; a single team's
// season average has never come close to leaving these bounds.
const LEVEL_BOUNDS: Record<Stat, [number, number]> = {
  pts: [95, 135],
  reb: [33, 56],
  ast: [17, 36],
  stl: [4, 13],
  blk: [2.5, 9],
  tov: [8, 20],
};

const byId = new Map(playersFile.players.map((p) => [p.athlete_id, p]));
const ptsErrors: number[] = [];
const shareErrors: number[] = [];
const seenTeams = new Set<string>();
for (const m of SWEEP) {
  const runId = encodeRunId(
    { home: m.home, away: m.away, neutralSite: m.neutral, ratingMode: m.mode },
    "levels",
  );
  const box = buildBoxscore(boxInput(m, runId, "expected", 300));

  for (const side of [box.home, box.away]) {
    seenTeams.add(side.tri);
    for (const stat of STAT_ORDER) {
      const [lo, hi] = LEVEL_BOUNDS[stat];
      const v = side.teamSim[stat];
      check(
        v >= lo && v <= hi,
        `${side.tri} expected ${stat} = ${v.toFixed(1)} per game, outside the real-NBA range ` +
          `[${lo}, ${hi}]. The team-level stat model (per-36 x allocated minutes, ` +
          `lib/hoops/boxscore.ts) has drifted off the real world — this is the check that ` +
          `catches a wrong LEVEL, which every internal-consistency test passes.`,
      );
      // Expected mode's player lines are shares of the team mean, so they must
      // still add up — fractionally this time.
      const summed = side.players.reduce((s, p) => s + p.stats[stat], 0);
      check(
        Math.abs(summed - v) < 1e-6,
        `${side.tri} expected ${stat}: player lines sum to ${summed}, team mean is ${v}`,
      );
    }
    check(
      Math.abs(side.totals.min - BUDGET) < 1e-9,
      `${side.tri} expected mode: allocated minutes sum to ${side.totals.min}, not ${BUDGET}`,
    );
    // The p10/p90 band must STRADDLE the mean with real width on both sides.
    // Checking only the width lets a collapsed p10 through — falsification
    // caught that: setting p10 to the median kept the band 8 points wide and
    // passed.
    const top = [...side.players].sort((a, b) => b.stats.pts - a.stats.pts)[0];
    const p10 = top.ptsP10 ?? 0;
    const p90 = top.ptsP90 ?? 0;
    check(
      p10 <= top.stats.pts && top.stats.pts <= p90,
      `${side.tri}: leading scorer's expected ${top.stats.pts.toFixed(1)} points falls outside ` +
        `his own p10-p90 band [${p10.toFixed(1)}, ${p90.toFixed(1)}]`,
    );
    check(
      top.stats.pts - p10 >= 2.5 && p90 - top.stats.pts >= 2.5,
      `${side.tri}: leading scorer's band is lopsided or collapsed — ` +
        `p10 ${p10.toFixed(1)}, mean ${top.stats.pts.toFixed(1)}, p90 ${p90.toFixed(1)}. ` +
        `Both halves should be several points wide.`,
    );

    // Every projected player must be a real rotation player, not the tail of
    // a 20-man roster.
    check(
      side.players.length >= 8 && side.players.length <= 13,
      `${side.tri}: projected ${side.players.length} players — outside hoops-sim's own ` +
        `ROTATION_MIN/ROTATION_MAX bounds of 8-13`,
    );

    // 🔴 THE SECOND-SOURCE ANCHOR ON PLAYER LINES. Everything above checks the
    // box score against itself or against league-wide bounds; this checks each
    // PLAYER against a measured quantity the bundle carries independently.
    // `game_rates.pts` is season points per game straight from the game logs,
    // and it is NOT an input to any line here — the lines come from per-36
    // shooting rates times allocated minutes times the engine's team total.
    // Without this the shares can be badly wrong while every total stays
    // right, which falsification demonstrated: counting three-pointers as two
    // points changed who scores without moving a single team number.
    for (const pl of side.players) {
      const src = byId.get(pl.athlete_id);
      if (!src?.game_rates || src.game_rates.gp < 20 || pl.minutes < 18) continue;
      ptsErrors.push(pl.stats.pts - src.game_rates.pts);
    }

    // The LEVEL check above carries a large systematic bias (see below), which
    // swamps any error in WHO is scoring — measured: mis-weighting three-
    // pointers as twos moved the absolute MAE from 2.46 to 2.50, invisible.
    // Comparing each player's share of his team's projected points against his
    // share of the team's measured points removes the level entirely and makes
    // the same perturbation jump out (0.19 -> 0.59).
    const eligible = side.players.filter((pl) => {
      const src = byId.get(pl.athlete_id);
      return src?.game_rates != null && src.game_rates.gp >= 20;
    });
    const projTotal = eligible.reduce((s, pl) => s + pl.stats.pts, 0);
    const measTotal = eligible.reduce(
      (s, pl) => s + (byId.get(pl.athlete_id)!.game_rates!.pts),
      0,
    );
    if (projTotal > 0 && measTotal > 0) {
      for (const pl of eligible) {
        const meas = byId.get(pl.athlete_id)!.game_rates!.pts;
        shareErrors.push(100 * (pl.stats.pts / projTotal - meas / measTotal));
      }
    }
  }
}

// Measured on the current bundle: MAE 2.47, bias -2.47 across 225 rotation
// players. The bias is systematic and EXPECTED rather than a defect — a
// rotation is picked until it fills 265 historical minutes and then
// renormalised onto a 240-minute budget, so every projected starter plays
// slightly fewer minutes than his season average. That is hoops-sim's own
// mechanism (roster.ROTATION_FILL_MINUTES), ported, not a hub-side artifact.
// The bounds are set to catch a real regression, not to pin today's number.
{
  const n = ptsErrors.length;
  const mae = ptsErrors.reduce((s, d) => s + Math.abs(d), 0) / n;
  const bias = ptsErrors.reduce((s, d) => s + d, 0) / n;
  check(
    n >= 150,
    `only ${n} rotation players cleared the points-fidelity bar — the anchor has lost its power`,
  );
  check(
    mae < 3.5,
    `projected points are ${mae.toFixed(2)} off measured points per game on average (was 2.47). ` +
      `The per-36 basis or the share allocation has drifted away from what these players ` +
      `actually do.`,
  );
  check(
    Math.abs(bias) < 3.5,
    `projected points carry a ${bias.toFixed(2)} point systematic bias (was -2.47). A bias this ` +
      `size means the participant list or the minutes allocation is wrong, not that the ` +
      `shares are noisy.`,
  );
  const sn = shareErrors.length;
  const shareMae = shareErrors.reduce((s, d) => s + Math.abs(d), 0) / sn;
  check(
    shareMae < 0.35,
    `each player's share of his team's projected points is ${shareMae.toFixed(3)} percentage ` +
      `points off his share of the team's MEASURED points (was 0.192). This is the check that ` +
      `sees WHO is scoring rather than how much the team scores — for scale, counting three-` +
      `pointers as twos reads 0.585 here and is invisible to every other assertion in this file.`,
  );
  fidelity =
    `points fidelity vs measured per-game scoring: MAE ${mae.toFixed(2)}, bias ${bias.toFixed(2)} ` +
    `over ${n} rotation players; share-of-team-points MAE ${shareMae.toFixed(3)}pp over ${sn}`;
}

check(
  seenTeams.size === 30,
  `the level sweep covered ${seenTeams.size} teams, not all 30 — a team's stat level is ` +
    `going unchecked`,
);

// ── 5. run_id round-trip ─────────────────────────────────────────────────
{
  const modes: RatingMode[] = ["results", "roster", "blend"];
  for (const mode of modes) {
    for (const neutral of [false, true]) {
      const coords = { home: "DEN", away: "OKC", neutralSite: neutral, ratingMode: mode };
      const id = encodeRunId(coords, "rt");
      const back = parseRunId(id);
      check(
        back !== null &&
          back.home === "DEN" &&
          back.away === "OKC" &&
          back.neutralSite === neutral &&
          back.ratingMode === mode,
        `run_id round-trip failed for ${JSON.stringify(coords)} — encoded ${id}, parsed ` +
          `${JSON.stringify(back)}`,
      );
    }
  }
  check(
    encodeRunId({ home: "DEN", away: "OKC", neutralSite: false, ratingMode: "blend" }, "a") !==
      encodeRunId({ home: "DEN", away: "OKC", neutralSite: false, ratingMode: "blend" }, "b"),
    "two different nonces produced the same run_id — every Sim tap would replay one game",
  );
  const bad = [
    "",
    "DEN-OKC",
    "DEN-OKC-hb",
    "DEN-DEN-hb-0123456789abcdef",
    "DEN-OKC-xb-0123456789abcdef",
    "DEN-OKC-hz-0123456789abcdef",
    "DEN-OKC-hb-nothex0123456789",
    "DEN-OKC-hb-0123456789abcde",
    "den-okc-hb-0123456789abcdef",
    "DEN-OKC-hb-0123456789abcdef-extra",
  ];
  for (const b of bad) {
    check(parseRunId(b) === null, `parseRunId accepted a malformed id: ${JSON.stringify(b)}`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(
    `\nBOX SCORE CHECK FAILED — ${problems.length} of ${assertions} assertions:\n`,
  );
  for (const p of problems.slice(0, 40)) console.error(`  ✗ ${p}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  console.error("");
  process.exit(1);
}

console.log(
  `hoops box score: PASS (${assertions} assertions)\n` +
    `  · ${sampledGames} sampled games (${otSampled} reaching OT) — every player line an integer, ` +
    `every stat column summing exactly to the realised team total\n` +
    `  · ${SWEEP.length} expected box scores covering all 30 teams, every stat level inside real-NBA bounds\n` +
    `  · run_ids reproduce exactly, fresh nonces re-roll, and a batch simulation is refused for a sampled game\n` +
    `  · ${fidelity}\n` +
    `  · minutes allocate to the bundle's own total_team_minutes (${BUDGET})`,
);
