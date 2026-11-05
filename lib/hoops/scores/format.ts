// Pure display helpers for the scores section (status line, period labels).

import { SCORES_TZ, tipTime, tzLabel } from "./dates.ts";
import type { Game } from "./types.ts";

/** "1 2 3 4 OT 2OT" — headers for a line score with `n` periods. */
export function periodLabels(n: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= Math.max(4, n); i++) out.push(i <= 4 ? String(i) : i === 5 ? "OT" : `${i - 4}OT`);
  return out;
}

/** What the top line of a game says: the tip time in the viewer's zone
 *  before it ("7:30 PM MT", "2:30 AM GMT"), the live clock during, the
 *  source's "Final" / "Final/OT" after. */
export function statusLabel(g: Game, tz: string = SCORES_TZ): string {
  if (g.postponed) return g.statusDetail || "Postponed";
  if (g.state === "pre") {
    const at = new Date(g.startUtc);
    return `${tipTime(g.startUtc, tz)} ${tzLabel(tz, Number.isNaN(at.getTime()) ? new Date() : at)}`;
  }
  return g.statusDetail || (g.state === "post" ? "Final" : "Live");
}
