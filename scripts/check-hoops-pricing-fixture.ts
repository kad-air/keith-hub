#!/usr/bin/env node
//
// The pricing layer's cross-implementation fixture gate — kad-air/hoops-sim#24's
// last section: "the engine has a cross-implementation fixture
// (hoops_fixture.json). The pricing layer does not... ship one, same
// pattern — Python generates, both sides assert."
//
//   npm run check:hoops:pricing-fixture   (standalone)
//   npm run build                         (runs this first via prebuild)
//
// WHAT THIS PROVES. hoops-sim prices a roster edit by running its REAL
// `rosterratings.team_net_rating` over a fixed synthetic roster and writing the
// answers into hoops_pricing_fixture.json. This script runs lib/hoops/pricing.ts
// over the identical inputs and demands the identical answers. If the two ever
// disagree, the site is quoting a number the model would not — which is the one
// failure mode nobody would notice by reading the screen.
//
// 🔴 EVERY CASE CARRIES ITS OWN `features` LIST AND IS PRICED UNDER THAT LIST,
// never under whatever the live bundle happens to declare. Two families ship in
// every fixture and both must pass, forever:
//
//   v1  symmetric_off_def + plain proportional minutes — the formula that has
//       been live since 2026-08-05. It is a permanent BACKWARD-COMPATIBILITY
//       regression set: an old bundle must go on pricing exactly as it always
//       did after this receiver learns the new formula. The eight v1 answers
//       are additionally pinned below as literals recorded from the pre-hub-v2
//       fixture, so this check convicts a v1 regression even if the SENDER's
//       own numbers moved with it.
//
//   v2  split_off_def + depth_chart_minutes — the hub-v2 formula. A player's
//       offence lands on his new team's offence and his defence on its defence
//       instead of half his net landing on each; and minutes come off the
//       fitted rotation curve, because a real NBA rotation is top-heavy and
//       plain proportional shares are not.
//
// EXPECTED SCHEMA (the receiver's own design — hoops-sim#24 names the required
// cases but not a byte-exact JSON shape, unlike hoops_fixture.json which both
// sides already agree on):
//
//   {
//     "constants": { "total_team_minutes": 240.0, "bench_default_minutes": 12.0,
//                     "absorption_phi": 0.146, "ghost_athlete_id": -1,
//                     "replacement_per36": -1.0,
//                     "replacement_tilt_per36": 0.4,           // v2
//                     "depth_chart_w": 0.4,                    // v2
//                     "depth_chart_curve": {"1": 34.257, ...}  // v2
//                   },
//     "league_recenter": 5.0,
//     "league_recenter_tilt": 1.5,       // v2
//     "cases": [
//       { "name": "...",
//         "features": ["split_off_def", "depth_chart_minutes", ...],
//         "players": [ { "athlete_id": 1, "raw_minutes": 34.2, "value_per36": 3.1,
//                        "value_off_per36": 2.0, "value_def_per36": 1.1,
//                        "has_history": true }, ... ],
//         "absent": [ { "athlete_id": 7, "raw_minutes": 30.0 } ],   // optional
//         "expected": { "raw_strength": .., "off": .., "def": .., "net": ..,
//                        "tilt": .., "ghost_minutes": .. }
//       },
//       ...
//     ]
//   }

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pricingModeOf } from "../lib/hoops/contract.ts";
import {
  teamNetRating,
  type PricingConstants,
  type PricingPlayer,
} from "../lib/hoops/pricing.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(ROOT, "hoops-data", "hoops_pricing_fixture.json");

const TOLERANCE = 1e-6;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(b));
}

/**
 * 🔴 THE BACKWARD-COMPATIBILITY PINS. Recorded from the fixture as it stood
 * BEFORE hub-v2, keyed by the leading marker of each case name. These are the
 * eight numbers the live site has been pricing roster edits with. A change to
 * pricing.ts's v1 path fails here; so does a sender that quietly re-prices the
 * v1 cases, which comparing TS against the shipped fixture alone could never
 * catch (both sides would move together). Never soften one of these to make a
 * run go green — if a v1 number genuinely must move, that is a pricing_version
 * bump and a deliberate migration, not an edit to this table.
 */
const V1_PINS: Record<
  string,
  { raw_strength: number; off: number; net: number; ghost_minutes: number }
> = {
  "ordinary full roster": {
    raw_strength: 10.873015873, off: 2.936507937, net: 5.873015873, ghost_minutes: 0.0,
  },
  "bench-default-minutes": {
    raw_strength: 11.842105263, off: 3.421052632, net: 6.842105263, ghost_minutes: 0.0,
  },
  absorption_off: {
    raw_strength: 14.715447154, off: 4.857723577, net: 9.715447154, ghost_minutes: 0.0,
  },
  absorption_on: {
    raw_strength: 14.00862709, off: 4.504313545, net: 9.00862709, ghost_minutes: 7.933584906,
  },
  "fictional player": {
    raw_strength: 19.444444444, off: 7.222222222, net: 14.444444444, ghost_minutes: 0.0,
  },
  "delta identity, part 1": {
    raw_strength: 9.333333333, off: 2.166666667, net: 4.333333333, ghost_minutes: 0.0,
  },
  "delta identity, part 2": {
    raw_strength: 26.666666667, off: 10.833333333, net: 21.666666667, ghost_minutes: 0.0,
  },
  "delta identity, part 3": {
    raw_strength: 3.333333333, off: -0.833333333, net: -1.666666667, ghost_minutes: 0.0,
  },
};

if (!fs.existsSync(FIXTURE_PATH)) {
  console.error(
    "HOOPS PRICING FIXTURE CHECK FAILED — hoops-data/hoops_pricing_fixture.json is missing.\n" +
      "Regenerate it with `uv run hoops export-hub <dest>` in ~/Code/hoops-sim and copy it in.",
  );
  process.exit(1);
}

interface FixturePlayer {
  athlete_id: number;
  raw_minutes: number | null;
  value_per36: number | null;
  value_off_per36?: number | null;
  value_def_per36?: number | null;
  has_history?: boolean;
  pts_per36?: number | null;
}

interface FixtureCase {
  name: string;
  features?: string[];
  players: FixturePlayer[];
  absent?: FixturePlayer[];
  expected: {
    raw_strength: number;
    off: number;
    def: number;
    net: number;
    tilt?: number;
    ghost_minutes?: number;
    goto_share?: number;
    goto_credit?: number;
  };
}

interface FixtureFile {
  constants: PricingConstants;
  league_recenter: number;
  league_recenter_tilt?: number;
  cases: FixtureCase[];
}

const problems: string[] = [];
const fail = (msg: string): void => {
  problems.push(msg);
};

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8")) as FixtureFile;

let v1Count = 0;
let v2Count = 0;
const pinnedSeen = new Set<string>();

if (!fixture.constants || !fixture.cases || fixture.cases.length === 0) {
  fail("hoops_pricing_fixture.json: missing constants or cases");
} else {
  for (const c of fixture.cases) {
    if (!c.features || c.features.length === 0) {
      fail(
        `case "${c.name}": no "features" list. Every case must say which pricing formula it is ` +
          `priced under — guessing is how this check passes while proving nothing.`,
      );
      continue;
    }
    const mode = pricingModeOf(c.features);
    if (mode.split || mode.depthChart) v2Count += 1;
    else v1Count += 1;

    const players: PricingPlayer[] = c.players.map((p) => ({
      athlete_id: p.athlete_id,
      raw_minutes: p.raw_minutes,
      value_per36: p.value_per36,
      value_off_per36: p.value_off_per36,
      value_def_per36: p.value_def_per36,
      has_history: p.has_history,
      pts_per36: p.pts_per36,
    }));
    const absentRaw = c.absent
      ? new Map(
          c.absent.map((p) => [
            p.athlete_id,
            p.raw_minutes ?? fixture.constants.bench_default_minutes,
          ]),
        )
      : undefined;

    const result = teamNetRating(
      players,
      fixture.constants,
      fixture.league_recenter,
      absentRaw,
      { split: mode.split, depthChart: mode.depthChart, goto: mode.goto },
      fixture.league_recenter_tilt ?? 0,
    );

    const checks: Array<[string, number, number]> = [
      ["raw_strength", result.rawStrength, c.expected.raw_strength],
      ["off", result.off, c.expected.off],
      ["def", result.def, c.expected.def],
      ["net", result.net, c.expected.net],
    ];
    if (c.expected.tilt !== undefined) {
      checks.push(["tilt", result.tilt, c.expected.tilt]);
    }
    if (c.expected.ghost_minutes !== undefined) {
      checks.push(["ghost_minutes", result.ghostMinutes, c.expected.ghost_minutes]);
    }
    for (const [field, got, want] of checks) {
      if (!close(got, want)) {
        fail(`case "${c.name}": ${field} = ${got}, fixture expects ${want}`);
      }
    }

    // The two identities that must hold in BOTH families, restated here rather
    // than only trusted from the fixture's own numbers: net is off - def (the
    // margin channel, which the split must never touch), and tilt is off + def
    // (the total channel, which is structurally 0 under symmetric pricing —
    // that being the whole defect the split fixes). The +1 shifts both sides
    // off zero so the relative tolerance stays meaningful near it.
    if (!close(result.off - result.def, result.net)) {
      fail(`case "${c.name}": off - def = ${result.off - result.def}, but net = ${result.net}`);
    }
    if (!close(result.off + result.def + 1, result.tilt + 1)) {
      fail(`case "${c.name}": off + def = ${result.off + result.def}, but tilt = ${result.tilt}`);
    }
    if (!mode.split && result.tilt !== 0) {
      fail(`case "${c.name}": symmetric pricing must give tilt exactly 0, got ${result.tilt}`);
    }
    // hub-v3: the go-to-scorer term is gated by the contract and lands on the
    // net only. A case without the token must read exactly 0 credit even when
    // its players carry pts_per36 (the "declared off" witness); a case with it
    // must reproduce hoops-sim's own share and credit, and the credit must be
    // the whole difference between raw_strength and the minutes-weighted sum.
    if (!mode.goto && result.gotoCredit !== 0) {
      fail(`case "${c.name}": goto_scorer not declared, but the port charged ${result.gotoCredit}`);
    }
    if (c.expected.goto_credit != null) {
      if (!close(result.gotoCredit + 1, c.expected.goto_credit + 1)) {
        fail(`case "${c.name}": goto_credit ${result.gotoCredit} vs hoops-sim ${c.expected.goto_credit}`);
      }
      if (!close(result.gotoShare + 1, (c.expected.goto_share ?? 0) + 1)) {
        fail(`case "${c.name}": goto_share ${result.gotoShare} vs hoops-sim ${c.expected.goto_share}`);
      }
    }

    // The backward-compatibility pins.
    for (const [marker, pin] of Object.entries(V1_PINS)) {
      if (!c.name.startsWith(marker)) continue;
      pinnedSeen.add(marker);
      if (mode.split || mode.depthChart) {
        fail(`case "${c.name}" matches a v1 pin but declares v2 features ${c.features.join(", ")}`);
        continue;
      }
      const pins: Array<[string, number, number]> = [
        ["raw_strength", result.rawStrength, pin.raw_strength],
        ["off", result.off, pin.off],
        ["net", result.net, pin.net],
        ["ghost_minutes", result.ghostMinutes, pin.ghost_minutes],
      ];
      for (const [field, got, want] of pins) {
        if (!close(got, want)) {
          fail(
            `case "${c.name}": ${field} = ${got} but the PRE-HUB-V2 pin says ${want}. The v1 ` +
              `pricing formula has changed — that is a backward-compatibility break.`,
          );
        }
      }
    }
  }

  for (const marker of Object.keys(V1_PINS)) {
    if (!pinnedSeen.has(marker)) {
      fail(
        `no case name starts with the pinned v1 marker "${marker}" — a backward-compatibility ` +
          `case was dropped or renamed`,
      );
    }
  }
  if (v1Count === 0) fail("no v1 (symmetric / proportional) cases in the fixture");
  if (v2Count === 0) fail("no v2 (split / depth-chart) cases in the fixture");

  console.log(
    `  · ${fixture.cases.length} pricing case(s) checked against lib/hoops/pricing.ts ` +
      `(${v1Count} v1, ${v2Count} v2), ${pinnedSeen.size} backward-compatibility pins held`,
  );
}

if (problems.length > 0) {
  console.error(`\nHOOPS PRICING FIXTURE CHECK FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log("hoops pricing-fixture check: PASS");
