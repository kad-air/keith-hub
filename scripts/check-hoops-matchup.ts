#!/usr/bin/env node
//
// THE MATCHUP SCREEN'S TWO NEW READS — best-of-seven odds and head-to-head.
//
//   npm run check:hoops:matchup   (standalone)
//   npm run build                 (runs via prebuild)
//
// Series odds are arithmetic over two single-game probabilities, so they are
// checked against closed forms and symmetries a wrong state walk cannot
// satisfy by accident. Head-to-head is a join over the committed bundle,
// anchored on a real-world fact about the 2025-26 schedule rather than on the
// join agreeing with itself.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { meetingsBetween } from "../lib/hoops/matchup.ts";
import {
  SERIES_FORMAT_2_2_1_1_1,
  seriesLengthDistribution,
  seriesWinProb,
} from "../lib/hoops/series.ts";
import type { RawLinesFile, RawResultsFile, RawScheduleFile } from "../lib/hoops/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems: string[] = [];
const notes: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) problems.push(msg);
};
const near = (a: number, b: number, tol = 1e-12): boolean => Math.abs(a - b) <= tol;

// ── 1. best of seven ──────────────────────────────────────────────────────
// Closed form for a constant per-game p: P = Σ_{k=4..7} C(k−1,3) p^4 (1−p)^(k−4).
const closed = (p: number): number =>
  [4, 5, 6, 7].reduce((s, k) => {
    const choose = (n: number, r: number): number => {
      let c = 1;
      for (let i = 1; i <= r; i++) c = (c * (n - r + i)) / i;
      return c;
    };
    return s + choose(k - 1, 3) * p ** 4 * (1 - p) ** (k - 4);
  }, 0);

check(near(seriesWinProb(0.5, 0.5), 0.5), "even teams on even floors must be a coin flip");
for (const p of [0.55, 0.6, 0.7, 0.8]) {
  check(
    near(seriesWinProb(p, p), closed(p), 1e-12),
    `constant p=${p}: state walk ${seriesWinProb(p, p)} != closed form ${closed(p)}`,
  );
}
// Complement symmetry: the other team, on the mirrored court pattern, must
// win exactly the remainder.
const mirror = SERIES_FORMAT_2_2_1_1_1.map((h) => !h);
for (const [ph, pa] of [
  [0.7, 0.55],
  [0.62, 0.48],
  [0.9, 0.3],
]) {
  const a = seriesWinProb(ph, pa);
  const b = seriesWinProb(1 - pa, 1 - ph, mirror);
  check(near(a + b, 1, 1e-12), `A (${ph},${pa}) ${a} + B ${b} != 1`);
}
// Monotone in each argument, and home court worth something: the team that
// holds it with the same per-floor edge must be favoured over the mirror.
check(
  seriesWinProb(0.7, 0.55) > seriesWinProb(0.65, 0.55) &&
    seriesWinProb(0.7, 0.55) > seriesWinProb(0.7, 0.5),
  "series odds must rise with either single-game probability",
);
// Symmetric edge (each side wins 55% on its own floor): the holder of home
// court has four of the seven games at home and must be favoured.
check(
  seriesWinProb(0.55, 0.45) > 0.5 && seriesWinProb(0.55, 0.45) < 0.6,
  `holding home court with a symmetric edge must favour the holder modestly, got ${seriesWinProb(0.55, 0.45)}`,
);
const dist = seriesLengthDistribution(0.66, 0.5);
check(
  near(dist.reduce((s, d) => s + d.prob, 0), 1, 1e-12) &&
    dist.every((d) => d.games >= 4 && d.games <= 7),
  "series length distribution must sum to 1 over 4..7 games",
);
let threw = false;
try {
  seriesWinProb(1.2, 0.5);
} catch {
  threw = true;
}
check(threw, "an out-of-range probability must throw, not return a number");
notes.push(
  `series: closed form matched at 4 p's, complement symmetry at 3 pairs, ` +
    `0.7/0.55 with home court → ${(seriesWinProb(0.7, 0.55) * 100).toFixed(1)}%`,
);

// ── 2. head to head over the committed bundle ─────────────────────────────
const schedule = JSON.parse(
  fs.readFileSync(path.join(ROOT, "hoops-data/hoops_schedule.json"), "utf-8"),
) as RawScheduleFile;
const lines = JSON.parse(
  fs.readFileSync(path.join(ROOT, "hoops-data/hoops_lines.json"), "utf-8"),
) as RawLinesFile;
const results = JSON.parse(
  fs.readFileSync(path.join(ROOT, "hoops-data/hoops_results.json"), "utf-8"),
) as RawResultsFile;

// Real-world anchor: the 2025-26 season opened on 2025-10-21 with Houston at
// Oklahoma City (ring night). Symmetric in argument order.
const okcHou = meetingsBetween(schedule.games, lines.lines, results.games, "OKC", "HOU");
const houOkc = meetingsBetween(schedule.games, lines.lines, results.games, "hou", "okc");
check(
  JSON.stringify(okcHou) === JSON.stringify(houOkc),
  "meetingsBetween must not depend on argument order or case",
);
const opener = okcHou.find((m) => m.date === "2025-10-21");
check(
  !!opener && opener.home === "OKC" && opener.away === "HOU",
  `2025-10-21 must be HOU at OKC, got ${JSON.stringify(opener)}`,
);
check(
  !!opener && opener.homeSpread != null && opener.homeSpread < 0,
  "the opener's closing line must exist and have the champion favoured at home",
);
check(
  okcHou.every((m, i) => i === 0 || m.date >= okcHou[i - 1].date),
  "meetings must be oldest first",
);
// Real-world anchor: division rivals play four times a season.
const denMin = meetingsBetween(schedule.games, lines.lines, results.games, "DEN", "MIN");
check(denMin.length === 4, `DEN–MIN (same division) must meet 4 times, got ${denMin.length}`);
// A final is attached only inside the results window, never invented outside it.
const windowFrom = results.games.reduce((lo, g) => (g.date < lo ? g.date : lo), "9999");
const allMeetings = new Set<string>();
for (const g of schedule.games) allMeetings.add([g.home, g.away].sort().join("-"));
let withFinal = 0;
let outsideWithFinal = 0;
for (const key of allMeetings) {
  const [a, b] = key.split("-");
  for (const m of meetingsBetween(schedule.games, lines.lines, results.games, a, b)) {
    if (m.homeScore != null) {
      withFinal += 1;
      if (m.date < windowFrom) outsideWithFinal += 1;
      const r = results.games.find((g) => g.game_id === m.gameId)!;
      check(
        r.home_score === m.homeScore && r.away_score === m.awayScore,
        `${m.gameId}: final does not match hoops_results`,
      );
    }
  }
}
check(withFinal === results.games.length, `${withFinal} finals attached, ${results.games.length} in the window`);
check(outsideWithFinal === 0, `${outsideWithFinal} meetings carry a final from before the results window`);
notes.push(
  `head to head: OKC–HOU ${okcHou.length} games incl. the 2025-10-21 opener at OKC; DEN–MIN 4; ` +
    `${withFinal} finals attached, all inside the window`,
);

// ── report ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error("hoops matchup check: FAIL");
  for (const p of problems.slice(0, 12)) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("hoops matchup check: PASS");
