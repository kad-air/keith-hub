// One chart colour per franchise, for the all-teams projection trend on
// /hoops/sim/projections.
//
// Each is the team's own brand colour (primary, or the secondary where the
// primary is a navy or black that would vanish on the dark page), lifted
// enough to read on the dark palette's ink. The light palette darkens the same
// colour in CSS (`.hoops-team` in app/globals.css), so one value serves both
// themes. Within a division the picks are spread on purpose — three red teams
// in one division would make the conference view unreadable — which is why
// ATL is its volt green and GSW its blue rather than its gold.

export const TEAM_CHART_COLORS: Record<string, string> = {
  // East · Atlantic
  BOS: "#2fa05a",
  BKN: "#c9c9c9",
  NYK: "#f58426",
  PHI: "#3d86e6",
  TOR: "#e5383b",
  // East · Central
  CHI: "#d9364a",
  CLE: "#c0517a",
  DET: "#5b7fe8",
  IND: "#fdbb30",
  MIL: "#5aa55f",
  // East · Southeast
  ATL: "#c1d32f",
  CHA: "#1fb0c0",
  MIA: "#e0344a",
  ORL: "#2f95e6",
  WAS: "#b8c4cc",
  // West · Northwest
  DEN: "#fec524",
  MIN: "#78be20",
  OKC: "#3a9ae6",
  POR: "#e03a3e",
  UTA: "#9677e0",
  // West · Pacific
  GSW: "#4c7bdb",
  LAC: "#d9364a",
  LAL: "#fdb927",
  PHX: "#e56020",
  SAC: "#9468d0",
  // West · Southwest
  DAL: "#2e8ade",
  HOU: "#e0344a",
  MEM: "#8aa6d6",
  NOP: "#c8a35c",
  SAS: "#c4ced4",
};

/** A neutral for a tri the table doesn't know (never expected: the import
 *  gate pins the 30 tris). */
export const FALLBACK_TEAM_COLOR = "#aca08a";

export function teamChartColor(tri: string): string {
  return TEAM_CHART_COLORS[tri] ?? FALLBACK_TEAM_COLOR;
}

// ── pinned lines: colours that stay apart ──────────────────────────────────
//
// Team colours are unique within a division, not across the league, so pinning
// teams from different divisions can put two near-identical lines side by side
// (LAL and DEN are both gold; OKC and DET both mid-blue). `distinctColors`
// keeps a team's own colour where it reads apart from the ones already given
// out and swaps in one from PINNED_PALETTE where it doesn't.

/** Fallback colours for pinned lines, lifted for the dark page like the team
 *  colours above (the light palette darkens them in CSS the same way). Every
 *  pair is at least MIN_APART apart in OKLab. */
export const PINNED_PALETTE: readonly string[] = [
  "#e5383b", // red
  "#2fa05a", // green
  "#2f7fe8", // blue
  "#fdc030", // gold
  "#a46ae6", // violet
  "#20bcc8", // teal
  "#f58426", // orange
  "#ec5cb4", // pink
  "#c4ced4", // silver
  "#8f5f34", // brown
];

/** How far apart (OKLab distance) two pinned lines' colours must be. LAL/NYK
 *  (0.127) already read as one hue on the light page; BOS/OKC (0.215) don't. */
export const MIN_APART = 0.14;

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex → OKLab [L, a, b]. */
export function oklab(hex: string): [number, number, number] {
  const r = toLinear(parseInt(hex.slice(1, 3), 16));
  const g = toLinear(parseInt(hex.slice(3, 5), 16));
  const b = toLinear(parseInt(hex.slice(5, 7), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * A colour for each of `tris`, in order (pin order, so earlier pins keep
 * theirs as more are added). A team keeps its own colour when that is at least
 * MIN_APART from every colour already handed out; otherwise it gets a palette
 * colour — preferring one that is also clear of the own colours of the teams
 * still to come, so a swap doesn't take a later team's colour from it — the one
 * furthest from the rest (first in palette order on a tie). Past about ten
 * teams nothing is far enough from everything, and the furthest is the best
 * there is.
 */
export function distinctColors(tris: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used: string[] = [];
  const nearestIn = (c: string, set: readonly string[]) =>
    set.reduce((m, u) => Math.min(m, colorDistance(c, u)), Infinity);
  tris.forEach((tri, i) => {
    if (out[tri]) return;
    const own = teamChartColor(tri);
    let pick = own;
    if (nearestIn(own, used) < MIN_APART) {
      const later = tris.slice(i + 1).map(teamChartColor);
      const furthest = (score: (c: string) => number) => {
        let best = -1;
        let hit: string | null = null;
        for (const c of PINNED_PALETTE) {
          const d = score(c);
          if (d > best + 1e-9) {
            best = d;
            hit = c;
          }
        }
        return { hit, best };
      };
      const clear = furthest((c) => Math.min(nearestIn(c, used), nearestIn(c, later)));
      pick = (clear.best >= MIN_APART ? clear.hit : furthest((c) => nearestIn(c, used)).hit) ?? own;
    }
    out[tri] = pick;
    used.push(pick);
  });
  return out;
}
