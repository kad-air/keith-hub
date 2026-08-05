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
// 🔴 STATUS, stated loudly rather than papered over: as of this check's
// authorship, kad-air/hoops-sim (the sender, #23) has not yet shipped
// `hoops-data/hoops_pricing_fixture.json` — `uv run hoops export-hub` still
// only produces the six read-model files plus the engine's own
// hoops_fixture.json. This receiver's HALF (lib/hoops/pricing.ts, the pure
// TS port of allocate_minutes / allocate_minutes_with_absorption /
// raw_team_strength / team_net_rating) is built and ready. Until the fixture
// file exists, this check can only confirm that readiness — it does NOT fail
// the build, so this is deliberately NOT the same enforcement posture as
// check-hoops-fixture.ts (which requires hoops_fixture.json to exist). The
// moment hoops_pricing_fixture.json lands in hoops-data/, this check starts
// asserting against it for real, no code change required here.
//
// EXPECTED SCHEMA (this receiver's own design — hoops-sim#24 names the 5
// required cases but not a byte-exact JSON shape, unlike hoops_fixture.json
// which both sides already agree on). If the sender's actual shape differs,
// this check's failure message will say so plainly rather than silently
// passing on the wrong comparison:
//
//   {
//     "constants": { "total_team_minutes": 240.0, "bench_default_minutes": 12.0,
//                     "absorption_phi": 0.146, "ghost_athlete_id": -1,
//                     "replacement_per36": -0.675, ... },
//     "league_recenter": 8.337,          // a fixture-specific scalar, not
//                                        // necessarily production's own
//     "cases": [
//       { "name": "...",
//         "players": [ { "athlete_id": 1, "raw_minutes": 34.2, "value_per36": 3.1 }, ... ],
//         "absent": [ { "athlete_id": 7, "raw_minutes": 30.0 } ],   // optional
//         "expected": { "raw_strength": .., "off": .., "def": .., "net": ..,
//                        "ghost_minutes": .. }   // ghost_minutes optional
//       },
//       ...
//     ]
//   }

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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

if (!fs.existsSync(FIXTURE_PATH)) {
  console.log(
    "hoops pricing-fixture check: SKIPPED — hoops-data/hoops_pricing_fixture.json not shipped yet " +
      "(kad-air/hoops-sim#24's last section, sender side not landed). lib/hoops/pricing.ts is built " +
      "and ready; this check activates the moment the file exists. Not a build failure.",
  );
  process.exit(0);
}

interface FixturePlayer {
  athlete_id: number;
  raw_minutes: number | null;
  value_per36: number | null;
}

interface FixtureCase {
  name: string;
  players: FixturePlayer[];
  absent?: FixturePlayer[];
  expected: {
    raw_strength: number;
    off: number;
    def: number;
    net: number;
    ghost_minutes?: number;
  };
}

interface FixtureFile {
  constants: PricingConstants;
  league_recenter: number;
  cases: FixtureCase[];
}

const problems: string[] = [];
const fail = (msg: string): void => {
  problems.push(msg);
};

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8")) as FixtureFile;

if (!fixture.constants || !fixture.cases || fixture.cases.length === 0) {
  fail("hoops_pricing_fixture.json: missing constants or cases");
} else {
  for (const c of fixture.cases) {
    const players: PricingPlayer[] = c.players.map((p) => ({
      athlete_id: p.athlete_id,
      raw_minutes: p.raw_minutes,
      value_per36: p.value_per36,
    }));
    const absentRaw = c.absent
      ? new Map(c.absent.map((p) => [p.athlete_id, p.raw_minutes ?? fixture.constants.bench_default_minutes]))
      : undefined;

    const result = teamNetRating(players, fixture.constants, fixture.league_recenter, absentRaw);

    const checks: Array<[string, number, number]> = [
      ["raw_strength", result.rawStrength, c.expected.raw_strength],
      ["off", result.off, c.expected.off],
      ["def", result.def, c.expected.def],
      ["net", result.net, c.expected.net],
    ];
    if (c.expected.ghost_minutes !== undefined) {
      checks.push(["ghost_minutes", result.ghostMinutes, c.expected.ghost_minutes]);
    }
    for (const [field, got, want] of checks) {
      if (!close(got, want)) {
        fail(`case "${c.name}": ${field} = ${got}, fixture expects ${want}`);
      }
    }
  }
  console.log(`  · ${fixture.cases.length} pricing case(s) checked against lib/hoops/pricing.ts`);
}

if (problems.length > 0) {
  console.error(`\nHOOPS PRICING FIXTURE CHECK FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log("hoops pricing-fixture check: PASS");
