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
// join agreeing with itself. Section 3 pins the favourite's view the answer
// section renders (the favourite leads, not the home team), anchored on the
// real engine's own count of who won how many simulated games.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { boxscoreGameId } from "../lib/hoops/boxscore.ts";
import { simulateGame } from "../lib/hoops/engine.ts";
import {
  encodeRunId,
  favouriteView,
  fmtWinProb,
  marginLabel,
  meetingsBetween,
  mirrorHistogram,
  mirrorQuantiles,
  summarizeSim,
  type Histogram,
  type SimSummary,
} from "../lib/hoops/matchup.ts";
import { decodeParams } from "../lib/hoops/params.ts";
import { offDefOf, rankTeams } from "../lib/hoops/rating.ts";
import {
  SERIES_FORMAT_2_2_1_1_1,
  seriesLengthDistribution,
  seriesWinProb,
} from "../lib/hoops/series.ts";
import type {
  RawLinesFile,
  RawParamsFile,
  RawResultsFile,
  RawScheduleFile,
  RawTeamsFile,
  TeamRow,
} from "../lib/hoops/types.ts";

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

// ── 3. the favourite's view ───────────────────────────────────────────────
//
// The matchup screen leads with the favourite, and every signed figure it
// prints is favourite − underdog. The screen used to hard-wire the home team
// into the headline, the accent and the right-hand half of the histogram, so
// a 38% home side read as the team the page was pushing. Everything the
// answer section renders goes through `favouriteView`; this pins what it
// must do, first on synthetic summaries where the right answer is known by
// construction, then against the REAL engine over the committed bundle,
// where the accent bars have to hold exactly the games the engine itself
// says the favourite won.

function synth(pHome: number, meanMargin: number, hist: Histogram): SimSummary {
  return {
    runId: "HOM-AWY-hb-0000000000000000",
    home: "HOM",
    away: "AWY",
    neutralSite: false,
    ratingMode: "blend",
    nSims: hist.counts.reduce((s, c) => s + c, 0),
    homeWinProb: pHome,
    homeSpread: -meanMargin,
    meanMargin,
    meanTotal: 220,
    meanHomeScore: 110 + meanMargin / 2,
    meanAwayScore: 110 - meanMargin / 2,
    mcStderrMargin: 0.4,
    sdMargin: 13,
    otPct: 6,
    margin: { p5: -17, p25: -6, p50: 3, p75: 11, p95: 24 },
    total: { p5: 200, p25: 212, p50: 220, p75: 228, p95: 240 },
    marginHist: hist,
  };
}
// Bins [-6,-3) [-3,0) [0,3) [3,6) [6,9): 3 + 5 underdog-side games, 7 + 4 + 1 home-side.
const HIST: Histogram = { min: -6, binWidth: 3, counts: [3, 5, 7, 4, 1] };

// (a) Home favoured: the view is the summary, untouched.
{
  const v = favouriteView(synth(0.62, 4.5, HIST));
  check(v.fav === "HOM" && v.dog === "AWY" && v.favIsHome && !v.coinFlip, "62% home side must lead");
  check(near(v.favWinProb, 0.62) && near(v.dogWinProb, 0.38), "home favourite: probabilities carried as-is");
  check(near(v.favSpread, -4.5) && near(v.meanMargin, 4.5), "home favourite: spread and margin unchanged");
  check(JSON.stringify(v.marginHist) === JSON.stringify(HIST), "home favourite: histogram unchanged");
  check(v.margin.p25 === -6 && v.margin.p75 === 11, "home favourite: quantiles unchanged");
  check(
    near(v.favScore, 112.25) && near(v.dogScore, 107.75),
    `home favourite: the score must be home first (112.25–107.75), got ${v.favScore}–${v.dogScore}`,
  );
}
// (b) Away favoured — the Orlando-at-Brooklyn case: everything flips.
{
  const v = favouriteView(synth(0.381, -4.5, HIST));
  check(v.fav === "AWY" && v.dog === "HOM" && !v.favIsHome && !v.coinFlip, "61.9% away side must lead");
  check(near(v.favWinProb, 0.619) && near(v.dogWinProb, 0.381), "away favourite: probabilities swapped");
  check(near(v.favSpread, -4.5), `away favourite: the line must read AWY -4.5, got ${v.favSpread}`);
  check(near(v.meanMargin, 4.5), "away favourite: the mean margin is from its side");
  // synth(…, −4.5): home scores 107.75, away 112.25 — the away favourite leads the score.
  check(
    near(v.favScore, 112.25) && near(v.dogScore, 107.75),
    `away favourite: the score must be away first (112.25–107.75), got ${v.favScore}–${v.dogScore}`,
  );
  check(
    v.marginHist.min === -9 &&
      v.marginHist.binWidth === 3 &&
      v.marginHist.counts.join(",") === "1,4,7,5,3",
    `away favourite: histogram must mirror about zero, got ${JSON.stringify(v.marginHist)}`,
  );
  // The bin that held the home team's 7 wins by 0–3 now sits at [-3,0) — the
  // underdog's wins by 0–3 — and vice versa: same games, other side.
  check(
    v.margin.p5 === -24 && v.margin.p25 === -11 && v.margin.p50 === -3 && v.margin.p75 === 6 && v.margin.p95 === 17,
    `away favourite: quantiles must mirror (p25 ↔ −p75, p5 ↔ −p95), got ${JSON.stringify(v.margin)}`,
  );
  // Mirroring is its own inverse, and loses no game.
  const back = mirrorHistogram(v.marginHist);
  check(JSON.stringify(back) === JSON.stringify(HIST), "mirroring a histogram twice must give it back");
  check(JSON.stringify(mirrorQuantiles(v.margin)) === JSON.stringify(synth(0, 0, HIST).margin), "mirroring quantiles twice must give them back");
}
// (c) The coin flip falls back to the home team — decided at the DISPLAYED
// precision, so two numbers that both print 50.0% never make the page look
// as if it chose between them; and exactly 0.5 is home too.
for (const p of [0.5, 0.5004, 0.4996]) {
  const v = favouriteView(synth(p, 0.1, HIST));
  check(v.fav === "HOM" && v.favIsHome && v.coinFlip, `homeWinProb ${p} prints as a coin flip and must lead with the home team`);
  check(fmtWinProb(v.favWinProb) === fmtWinProb(v.dogWinProb), `coin flip at ${p}: both must print the same`);
  check(near(v.favScore, 110.05) && near(v.dogScore, 109.95), `coin flip at ${p}: the score is home first, like the headline`);
}
// …but the moment they print differently the UNROUNDED number decides, even
// a hair past the line.
{
  const v = favouriteView(synth(0.4994, -0.1, HIST));
  check(v.fav === "AWY" && !v.coinFlip, "49.9% vs 50.1% is not a coin flip: the away team leads");
  const w = favouriteView(synth(0.5006, 0.1, HIST));
  check(w.fav === "HOM" && !w.coinFlip, "50.1% vs 49.9%: the home team leads on merit, not fallback");
}
// (d) The words. A positive favourite-side margin names the favourite, a
// negative one the underdog, and zero is "level" — at the printed precision.
check(marginLabel(4.5, "ORL", "BKN", 1) === "ORL by 4.5", "mean margin label");
check(marginLabel(-13, "ORL", "BKN") === "BKN by 13", "underdog-side quantile label");
check(marginLabel(0.04, "ORL", "BKN", 1) === "level", "a margin that prints as 0.0 is level");
check(marginLabel(-0.4, "ORL", "BKN") === "level", "a margin that rounds to 0 is level");
check(marginLabel(-60, "ORL", "BKN") === "BKN by 60" && marginLabel(48, "ORL", "BKN") === "ORL by 48", "axis end labels");

// (e) Against the real engine. Pick, from the committed bundle, pairs where
// the AWAY team is the stronger side and pairs where the HOME team is, run
// the real possession engine, summarise, and demand: the favourite is the
// team the engine gave more than half the games to; the accent (favourite-
// side) bins hold EXACTLY the engine's count of favourite wins — bins are
// snapped to multiples of the bin width so zero is always an edge, and no
// game ends level, so this is an identity, not an approximation; the view's
// quantiles are the engine's margins read from the favourite's side; and the
// line is negative for the favourite whenever its mean margin is positive.
{
  const params = decodeParams(
    JSON.parse(fs.readFileSync(path.join(ROOT, "hoops-data/hoops_params.json"), "utf-8")) as RawParamsFile,
  );
  const teamsFile = JSON.parse(
    fs.readFileSync(path.join(ROOT, "hoops-data/hoops_teams.json"), "utf-8"),
  ) as RawTeamsFile;
  const rows = new Map<string, TeamRow>();
  for (const [tri, t] of Object.entries(teamsFile.teams)) {
    rows.set(tri, {
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
  const ranked = rankTeams([...rows.values()], "blend");
  const best = ranked.slice(0, 3).map((t) => t.tri);
  const worst = ranked.slice(-3).map((t) => t.tri);
  // Strong team away at a weak team's floor (away favourite), and the same
  // pairs the other way round (home favourite). HCA alone cannot bridge the
  // gap between the league's top three and bottom three.
  const cases: { home: string; away: string; expectAwayFav: boolean }[] = [];
  for (let i = 0; i < 3; i++) {
    cases.push({ home: worst[i], away: best[i], expectAwayFav: true });
    cases.push({ home: best[i], away: worst[i], expectAwayFav: false });
  }
  let awayFavs = 0;
  let homeFavs = 0;
  for (const c of cases) {
    const h = offDefOf(rows.get(c.home)!, "blend");
    const a = offDefOf(rows.get(c.away)!, "blend");
    const runId = encodeRunId(
      { home: c.home, away: c.away, neutralSite: false, ratingMode: "blend" },
      "favourite-check",
    );
    const result = simulateGame({
      params,
      runId,
      gameId: boxscoreGameId(c.home, c.away),
      homeTeam: c.home,
      awayTeam: c.away,
      homeOff: h.off,
      homeDef: h.def,
      awayOff: a.off,
      awayDef: a.def,
      hcaPts: teamsFile.hca_pts,
      neutralSite: false,
      nSims: 600,
    });
    const s = summarizeSim(result, "blend");
    const v = favouriteView(s);
    const n = result.nSims;
    let homeWins = 0;
    for (let i = 0; i < n; i++) if (result.margin[i] > 0) homeWins += 1;
    check(homeWins + [...result.margin].filter((m) => m < 0).length === n, `${c.away}@${c.home}: a simulated game ended level`);
    const engineFav = homeWins * 2 > n ? c.home : c.away;
    check(
      v.fav === engineFav,
      `${c.away}@${c.home}: view leads with ${v.fav}, the engine gave ${engineFav} ${Math.max(homeWins, n - homeWins)} of ${n}`,
    );
    check(
      v.favIsHome === !c.expectAwayFav,
      `${c.away}@${c.home}: expected the ${c.expectAwayFav ? "away" : "home"} side to be favoured (#${ranked.findIndex((t) => t.tri === c.away) + 1} away at #${ranked.findIndex((t) => t.tri === c.home) + 1})`,
    );
    if (v.favIsHome) homeFavs += 1;
    else awayFavs += 1;
    // The accent bars ARE the favourite's wins.
    const favWins = v.favIsHome ? homeWins : n - homeWins;
    let accent = 0;
    let grey = 0;
    v.marginHist.counts.forEach((cnt, i) => {
      const centre = v.marginHist.min + i * v.marginHist.binWidth + v.marginHist.binWidth / 2;
      if (centre > 0) accent += cnt;
      else grey += cnt;
    });
    check(
      accent === favWins && grey === n - favWins,
      `${c.away}@${c.home}: accent bins hold ${accent} games, the favourite (${v.fav}) won ${favWins} of ${n}`,
    );
    check(near(v.favWinProb, favWins / n), `${c.away}@${c.home}: favWinProb ${v.favWinProb} != ${favWins}/${n}`);
    // Quantiles from the favourite's side: the engine's margins, signed for
    // the favourite, sorted, read at the same positions `summarizeSim` uses.
    const sign = v.favIsHome ? 1 : -1;
    const favMargins = Array.from(result.margin, (m) => sign * m).sort((x, y) => x - y);
    const at = (q: number): number => {
      const pos = q * (n - 1);
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      return lo === hi ? favMargins[lo] : favMargins[lo] + (pos - lo) * (favMargins[hi] - favMargins[lo]);
    };
    check(
      near(v.margin.p5, at(0.05), 1e-9) && near(v.margin.p25, at(0.25), 1e-9) && near(v.margin.p75, at(0.75), 1e-9) && near(v.margin.p95, at(0.95), 1e-9),
      `${c.away}@${c.home}: favourite-side quantiles do not match the engine's margins`,
    );
    check(near(v.meanMargin, sign * result.meanMargin, 1e-9), `${c.away}@${c.home}: favourite-side mean margin`);
    // The Score stat: the favourite's mean score first, each read straight
    // off the engine's own finals for that side — never off the summary.
    let sumHome = 0;
    let sumAway = 0;
    for (let i = 0; i < n; i++) {
      sumHome += result.finalHomeScore[i];
      sumAway += result.finalAwayScore[i];
    }
    const favMean = (v.favIsHome ? sumHome : sumAway) / n;
    const dogMean = (v.favIsHome ? sumAway : sumHome) / n;
    check(
      near(v.favScore, favMean, 1e-9) && near(v.dogScore, dogMean, 1e-9),
      `${c.away}@${c.home}: score must read ${v.fav} ${favMean.toFixed(1)}–${dogMean.toFixed(1)} ${v.dog}, got ${v.favScore.toFixed(1)}–${v.dogScore.toFixed(1)}`,
    );
    check(
      near(v.favScore - v.dogScore, v.meanMargin, 1e-9),
      `${c.away}@${c.home}: the two mean scores must differ by the favourite-side mean margin`,
    );
    check(
      (v.meanMargin > 0) === (v.favSpread < 0),
      `${c.away}@${c.home}: a favourite with a positive mean margin must carry a negative line, got ${v.favSpread}`,
    );
    check(
      marginLabel(v.meanMargin, v.fav, v.dog, 1).startsWith(v.meanMargin > 0 ? v.fav : v.dog),
      `${c.away}@${c.home}: the caption names the wrong team for the mean margin`,
    );
  }
  check(awayFavs === 3 && homeFavs === 3, `expected 3 away favourites and 3 home favourites, got ${awayFavs}/${homeFavs}`);
  notes.push(
    `favourite's view: ${cases.length} real sims (${awayFavs} away-favoured, ${homeFavs} home-favoured) — accent bins = ` +
      `the engine's favourite wins exactly; coin flip at 50.0% falls back to home`,
  );
}

// ── report ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error("hoops matchup check: FAIL");
  for (const p of problems.slice(0, 12)) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("hoops matchup check: PASS");
