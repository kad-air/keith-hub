// What the TS engine port expects the committed hoops-sim blob to BE.
//
// Single source of truth, read by lib/hoops/params.ts (the runtime guard) and
// scripts/check-hoops.ts (the build gate), so the two can never drift on a
// number. A blob from an older parameter fit must fail loudly here rather than
// silently produce wrong simulations three milestones later.
//
// Regenerate the blob with `uv run hoops export-hub <keith-hub>/hoops-data`
// from ~/Code/hoops-sim. Only bump paramVersion here after confirming the
// engine still matches the new fit.

export const BLOB_CONTRACT = {
  paramVersion: "m2-possession-v2",
  nTables: 47,
  nStartTypes: 5,
  nDurationRows: 62,
  nOutcomeClasses: 4,
  nRegulationPeriods: 4,
  nMarginBuckets: 7,
  gridPppMin: 0.15,
  gridPppMax: 2.2,
  gridPppStep: 0.01,
  gridSize: 206,
  durationBinEdges: 121,
  teamCount: 30,
} as const;

export default BLOB_CONTRACT;
