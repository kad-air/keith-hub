#!/usr/bin/env node
//
// 🔴 CROSS-IMPLEMENTATION CHECK for the multinomial draw (issue #67).
//
//   npm run check:hoops:multinomial   (standalone)
//   npm run build                     (runs it via prebuild)
//
// Same discipline as check-hoops-fixture.ts, one layer down. hoops-sim's
// `hoops.boxscore` allocates every integer box-score stat with
// `rng.stream(...).multinomial(team_total, shares)`. lib/hoops/binomial.ts is
// a SECOND IMPLEMENTATION of that draw, so it is asserted against the real
// numpy rather than against itself: hoops-data/hoops_multinomial_cases.json is
// produced by running numpy 2.x through hoops-sim's own `hoops.rng`
// (scripts/gen_multinomial_cases.py), and this replays the identical
// coordinates through the TypeScript port.
//
// A plausible-looking multinomial that draws the wrong NUMBER of uniforms is
// the failure this is built for: it returns sensible integers, sums correctly,
// and is silently desynchronised from Python from that call onward. Only a
// fixed fixture catches it, which is why the cases deliberately straddle
// numpy's inversion/BTPE threshold, its p > 0.5 complement flip, and the
// early-exhaustion path where trailing categories consume no randomness.
//
// Runs the REAL module — node executes the TypeScript directly.
//
// ── What falsification established (measured at merge, not assumed) ──────
//
// CAUGHT, each by perturbing lib/hoops/binomial.ts and re-running this:
//   the inversion/BTPE threshold moved by one at the boundary; the p > 0.5
//   complement flip removed; the conditional probability pix[j]/remaining_p
//   replaced by raw pix[j]; the last category drawn instead of taking the
//   remainder; BTPE's `c` and `p1` setup constants perturbed; BTPE's
//   parallelogram y off by one; BTPE's squeeze accept bound flipped from
//   t - rho to t + rho; the inversion PMF recurrence off by one; the
//   inversion restart bound narrowed from 10 sd to 2 sd.
//
// NOT CAUGHT, and each one is correct rather than a coverage gap — checked
// individually rather than waved away:
//   • Dropping BTPE's step-20 `v > 1` rejection. It fires 92 times across the
//     fixture, so it IS reached. But `random_binomial` only ever calls BTPE
//     with p <= 0.5, and there F <= 1 for every y, so a v > 1 that survives
//     step 20 is rejected by step 50/52 instead — same value, same two
//     uniforms redrawn. Mathematically equivalent, like the engine's
//     searchsorted left-vs-right case.
//   • Dropping BTPE's y < 0 / y > n / v === 0 guards. These are C-cast safety
//     valves; reaching one needs a uniform below ~1e-35. Unreachable, not
//     uncovered.
//   • Moving BTPE's squeeze region boundary (k > 20 -> k > 10). Swaps which of
//     two acceptance tests judges a mid-distance y; they agree except in
//     borderline cases far rarer than this fixture's volume.
//   • Loosening the exact-ratio accept by 0.01%. A precision perturbation —
//     it needs v to land inside a 1-in-10,000 window, so it is a statement
//     about fixture size, not about the port.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { stream, RNG_NAMESPACE } from "../lib/hoops/rng.ts";
import { randomMultinomial } from "../lib/hoops/binomial.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = path.join(ROOT, "hoops-data", "hoops_multinomial_cases.json");

interface Case {
  name: string;
  coords: string[];
  n: number;
  pvals: number[];
  expected: number[];
}

interface CasesFile {
  numpy_version: string;
  rng_namespace: string;
  run_id: string;
  purpose: string;
  cases: Case[];
  sequences: Array<{
    name: string;
    coords: string[];
    pvals: number[];
    ns: number[];
    expected: number[][];
  }>;
}

const problems: string[] = [];
const pass: string[] = [];

function eq(label: string, mine: unknown, want: unknown): void {
  if (JSON.stringify(mine) === JSON.stringify(want)) pass.push(label);
  else {
    problems.push(
      `${label}\n      TypeScript: ${JSON.stringify(mine)}\n      numpy:      ${JSON.stringify(want)}`,
    );
  }
}

if (!fs.existsSync(CASES_PATH)) {
  console.error(
    `multinomial cases missing: ${CASES_PATH}\n` +
      `Regenerate with:\n` +
      `  cd ~/Code/hoops-sim && uv run python ${path.join(ROOT, "scripts", "gen_multinomial_cases.py")}`,
  );
  process.exit(1);
}

const fx = JSON.parse(fs.readFileSync(CASES_PATH, "utf-8")) as CasesFile;

// The fixture is only evidence about THIS keying. If the namespace ever moves,
// every case below would still pass while proving nothing about the streams the
// box score actually uses.
if (fx.rng_namespace !== RNG_NAMESPACE) {
  console.error(
    `RNG namespace drift: the fixture was generated under "${fx.rng_namespace}" but ` +
      `lib/hoops/rng.ts uses "${RNG_NAMESPACE}". Regenerate the fixture.`,
  );
  process.exit(1);
}

for (const c of fx.cases) {
  const gen = stream(fx.run_id, fx.purpose, ...c.coords);
  const got = Array.from(randomMultinomial(gen, c.n, c.pvals));
  eq(`case ${c.name}`, got, c.expected);
  const total = got.reduce((a, b) => a + b, 0);
  if (total !== c.n) {
    problems.push(`case ${c.name} · allocation does not sum to n (${total} != ${c.n})`);
  }
}

// One stream, many draws in order. Pins that generator state carries across
// calls identically (the p10/p90 pass depends on it), and — more importantly —
// supplies the VOLUME that BTPE's rare regions need before they fire even once.
let sequenceDraws = 0;
for (const seq of fx.sequences) {
  const gen = stream(fx.run_id, fx.purpose, ...seq.coords);
  const got = seq.ns.map((n) => Array.from(randomMultinomial(gen, n, seq.pvals)));
  // Report the FIRST diverging draw rather than dumping hundreds of rows —
  // a desync always shows up at a specific draw and everything after it is
  // noise from the same cause.
  const at = got.findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(seq.expected[i]));
  if (at === -1) pass.push(`sequence ${seq.name} (${seq.ns.length} draws)`);
  else {
    problems.push(
      `sequence ${seq.name} · first divergence at draw ${at} (n=${seq.ns[at]})` +
        `\n      TypeScript: ${JSON.stringify(got[at])}` +
        `\n      numpy:      ${JSON.stringify(seq.expected[at])}`,
    );
  }
  sequenceDraws += seq.ns.length;
}

// ── Guard the guard ──────────────────────────────────────────────────────
// A fixture that only exercises the easy path passes forever while proving
// nothing, so coverage is MEASURED here, not asserted by case name. Two
// independent measurements:
//
//   • Branch decisions, replayed exactly. numpy's expected output gives the
//     true per-category counts, so the conditional p and the remaining count
//     at every step are recoverable — no estimation.
//   • Uniforms actually consumed, counted through a wrapper around the real
//     generator. Inversion spends 1 per variate and BTPE spends 2 per
//     ATTEMPT, so anything above the branch-implied minimum is a rejection
//     that genuinely fired. This is the only way to know BTPE's triangle and
//     tail regions were reached rather than assumed.
const coverage = { inversion: 0, btpe: 0, flip: 0, exhaust: 0, rejections: 0 };

function countingGen(runId: string, purpose: string, coords: string[]) {
  const real = stream(runId, purpose, ...coords);
  const box = { uniforms: 0 };
  const proxy = {
    nextDouble(): number {
      box.uniforms += 1;
      return real.nextDouble();
    },
  } as unknown as Parameters<typeof randomMultinomial>[0];
  return { proxy, box };
}

/** Replay one draw's branch decisions against numpy's own answer. */
function tallyBranches(pvals: number[], n: number, expected: number[]): number {
  let remaining = 1.0;
  let dn = n;
  let minUniforms = 0;
  for (let j = 0; j < pvals.length - 1; j++) {
    if (dn <= 0) {
      coverage.exhaust += 1;
      break;
    }
    const p = pvals[j] / remaining;
    if (p === 0) {
      dn -= expected[j];
      remaining -= pvals[j];
      continue; // random_binomial returns 0 without drawing
    }
    if (p > 0.5) coverage.flip += 1;
    const effective = p <= 0.5 ? p : 1.0 - p;
    if (effective * dn <= 30.0) {
      coverage.inversion += 1;
      minUniforms += 1;
    } else {
      coverage.btpe += 1;
      minUniforms += 2;
    }
    dn -= expected[j];
    remaining -= pvals[j];
  }
  return minUniforms;
}

for (const c of fx.cases) {
  const { proxy, box } = countingGen(fx.run_id, fx.purpose, c.coords);
  randomMultinomial(proxy, c.n, c.pvals);
  coverage.rejections += Math.max(0, box.uniforms - tallyBranches(c.pvals, c.n, c.expected));
}
for (const seq of fx.sequences) {
  const { proxy, box } = countingGen(fx.run_id, fx.purpose, seq.coords);
  let minUniforms = 0;
  seq.ns.forEach((n, i) => {
    randomMultinomial(proxy, n, seq.pvals);
    minUniforms += tallyBranches(seq.pvals, n, seq.expected[i]);
  });
  coverage.rejections += Math.max(0, box.uniforms - minUniforms);
}

const COVERAGE_FLOOR: Record<keyof typeof coverage, number> = {
  inversion: 50,
  btpe: 50,
  flip: 10,
  exhaust: 1,
  rejections: 20,
};
for (const [branch, floor] of Object.entries(COVERAGE_FLOOR)) {
  const got = coverage[branch as keyof typeof coverage];
  if (got < floor) {
    problems.push(
      `coverage: the "${branch}" branch fired ${got} times, below the floor of ${floor}. ` +
        `Restore volume in scripts/gen_multinomial_cases.py rather than shipping a check ` +
        `that only proves the easy path — BTPE's rejection regions need HUNDREDS of draws ` +
        `before they fire even once, which is why the sequences are long.`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `\nMULTINOMIAL CHECK FAILED — lib/hoops/binomial.ts disagrees with numpy on ` +
      `${problems.length} of ${problems.length + pass.length} assertions:\n`,
  );
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    `\nA disagreement here is a desynchronised RNG stream, not a rounding difference —\n` +
      `numpy's binomial has two samplers that consume different numbers of uniforms.\n` +
      `Check the inversion/BTPE threshold (p*n <= 30, evaluated AFTER the p > 0.5 flip)\n` +
      `and the early-exhaustion break before looking anywhere else.\n`,
  );
  process.exit(1);
}

console.log(
  `hoops multinomial: PASS (${pass.length} assertions vs numpy ${fx.numpy_version})\n` +
    `  · ${fx.cases.length} single cases + ${fx.sequences.length} sequences (${sequenceDraws} draws off shared streams)\n` +
    `  · branches reached: ${coverage.inversion} inversion, ${coverage.btpe} BTPE, ` +
    `${coverage.flip} complement flips, ${coverage.exhaust} early exhaustions, ` +
    `${coverage.rejections} rejection redraws`,
);
