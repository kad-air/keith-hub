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
