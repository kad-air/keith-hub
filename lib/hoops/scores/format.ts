// Pure display helpers for the scores section (status line, period labels).

import { tipTime } from "./dates.ts";
import type { Game } from "./types.ts";

/** "1 2 3 4 OT 2OT" — headers for a line score with `n` periods. */
export function periodLabels(n: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= Math.max(4, n); i++) out.push(i <= 4 ? String(i) : i === 5 ? "OT" : `${i - 4}OT`);
  return out;
}

/** What the top line of a game says: the tip time (Mountain) before it, the
 *  live clock during, the source's "Final" / "Final/OT" after. */
export function statusLabel(g: Game): string {
  if (g.postponed) return g.statusDetail || "Postponed";
  if (g.state === "pre") return `${tipTime(g.startUtc)} MT`;
  return g.statusDetail || (g.state === "post" ? "Final" : "Live");
}
