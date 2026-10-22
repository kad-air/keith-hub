// Notable individual performances — which box-score lines are worth calling
// out. Pure: box scores in, ranked lines out.
//
// 🔴 Every threshold lives in NOTABLE, and nowhere else. The page prints the
// rules from this object too, so the copy can't drift from the maths.
//
// Not detected, because the upstream doesn't carry it: career and season
// highs. ESPN's summary has no per-player history, and deriving a season high
// would mean crawling every box score of the season.

import { gameSlug } from "./parse.ts";
import type { GameBox, NotableLine, PlayerBoxLine } from "./types.ts";

export const NOTABLE = {
  /** A scoring night on its own. */
  points: 40,
  rebounds: 20,
  assists: 15,
  steals: 7,
  blocks: 7,
  threes: 9,
  /** A playmaking-and-scoring night: both at once. */
  assistsWithPoints: { ast: 10, pts: 25 },
  /** Double-digits in three (or more) of PTS/REB/AST/STL/BLK. */
  tripleDoubleCats: 3,
  /** "5x5": at least this many in all five counting stats. */
  fiveByFive: 5,
} as const;

/** The rules, in words, for the page. */
export const NOTABLE_RULES: string[] = [
  `${NOTABLE.points}+ pts`,
  "triple-double",
  `${NOTABLE.rebounds}+ reb`,
  `${NOTABLE.assists}+ ast`,
  `${NOTABLE.assistsWithPoints.pts}+ pts & ${NOTABLE.assistsWithPoints.ast}+ ast`,
  `${NOTABLE.threes}+ threes`,
  `${NOTABLE.steals}+ stl`,
  `${NOTABLE.blocks}+ blk`,
  `${NOTABLE.fiveByFive}x5`,
];

/** Why this line is notable, most impressive first; empty when it isn't. */
export function notableReasons(p: PlayerBoxLine): { reasons: string[]; score: number } {
  if (p.dnp) return { reasons: [], score: 0 };
  const reasons: string[] = [];
  let score = 0;
  const cats = [p.pts, p.reb, p.ast, p.stl, p.blk];
  const doubles = cats.filter((v) => v >= 10).length;
  if (doubles >= 4) {
    reasons.push("Quadruple-double");
    score += 100;
  } else if (doubles >= NOTABLE.tripleDoubleCats) {
    reasons.push("Triple-double");
    score += 50;
  }
  if (cats.every((v) => v >= NOTABLE.fiveByFive)) {
    reasons.push(`${NOTABLE.fiveByFive}x5`);
    score += 40;
  }
  if (p.pts >= NOTABLE.points) {
    reasons.push(`${p.pts} points`);
    score += 30 + (p.pts - NOTABLE.points) * 2;
  }
  if (p.reb >= NOTABLE.rebounds) {
    reasons.push(`${p.reb} rebounds`);
    score += 25 + (p.reb - NOTABLE.rebounds) * 2;
  }
  if (p.ast >= NOTABLE.assists) {
    reasons.push(`${p.ast} assists`);
    score += 25 + (p.ast - NOTABLE.assists) * 2;
  } else if (p.ast >= NOTABLE.assistsWithPoints.ast && p.pts >= NOTABLE.assistsWithPoints.pts) {
    reasons.push(`${p.pts} & ${p.ast}`);
    score += 20;
  }
  if (p.tpm >= NOTABLE.threes) {
    reasons.push(`${p.tpm} threes`);
    score += 20 + (p.tpm - NOTABLE.threes) * 2;
  }
  if (p.stl >= NOTABLE.steals) {
    reasons.push(`${p.stl} steals`);
    score += 20;
  }
  if (p.blk >= NOTABLE.blocks) {
    reasons.push(`${p.blk} blocks`);
    score += 20;
  }
  // Ties between equally-flagged lines go to the bigger all-round night.
  if (reasons.length) score += (p.pts + p.reb + p.ast + p.stl + p.blk) / 100;
  return { reasons, score };
}

/** Every notable line across a day's FINISHED box scores, best first. A
 *  live game is skipped: 38 points with six minutes left isn't a line yet. */
export function findNotable(boxes: GameBox[], date: string): NotableLine[] {
  const out: NotableLine[] = [];
  for (const box of boxes) {
    if (box.game.state !== "post") continue;
    const href = `/hoops/scores/${date}/${gameSlug(box.game)}`;
    for (const team of box.teams) {
      const opp = box.teams.find((t) => t !== team)?.tri ?? "";
      for (const p of team.players) {
        const { reasons, score } = notableReasons(p);
        if (!reasons.length) continue;
        out.push({
          gameId: box.game.id,
          date,
          href,
          tri: team.tri,
          opp,
          playerId: p.id,
          name: p.name,
          line: p,
          reasons,
          score,
        });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
