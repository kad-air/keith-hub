// Decode the committed hoops-sim parameter blob into typed arrays, and refuse
// to decode one the engine doesn't recognise.
//
// 🔴 This is the stale-blob guard. `blob-contract.json` is what the TS engine
// port expects the blob to BE; `hoops_params.json` is what it actually is. A
// blob from an older parameter fit fails here — loudly, at import and at build
// (scripts/check-hoops.mjs) — rather than silently producing wrong simulations
// three milestones later.
//
// 2D arrays are flattened into a single Float64Array + stride, which is the
// shape the possession loop wants: `theta[table * gridSize + i]`. No numpy,
// no nested-array pointer chasing in the hot loop.

import CONTRACT from "./blob-contract.json";
import type { HoopsConstants, RawParameterSet, RawParamsFile } from "./types";

export const BLOB_CONTRACT = CONTRACT;

/** What the engine expects. A blob declaring anything else is stale. */
export const EXPECTED_PARAM_VERSION = CONTRACT.paramVersion;

export class StaleBlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleBlobError";
  }
}

/** A flattened row-major matrix. */
export interface Matrix {
  data: Float64Array;
  rows: number;
  cols: number;
}

export interface DecodedParams {
  paramVersion: string;
  fittedAt: string;
  dataAsOf: string;
  source: string;

  nTables: number;
  nStartTypes: number;
  nDurationRows: number;
  nOutcomeClasses: number;
  nRegulationPeriods: number;
  nMarginBuckets: number;
  nCategories: number;

  avgPossPerTeamGame: number;
  regulationPeriodSeconds: number;
  otPeriodSeconds: number;
  endgameWindowSeconds: number;
  paceSigma: number;
  efficiencySigma: number;
  durationLevelScale: number;
  durationDispersionScale: number;

  thetaGrid: Matrix; // nTables × gridSize
  gridPpp: Float64Array; // gridSize
  baseProbs: Matrix; // nTables × K
  baseMeanPpp: Float64Array; // nTables
  points: Float64Array; // K
  outcomeClassOfCategory: Int32Array; // K
  categories: [string, number][];
  tableLabels: string[];
  durationBinEdges: Float64Array; // durationBinEdges
  durationCumprobs: Matrix; // nDurationRows × durationBinEdges
  durationTableMean: Float64Array; // nDurationRows
  transitionCumprobs: Matrix; // nOutcomeClasses × nStartTypes
  marginFeedbackPpp: Float64Array; // nMarginBuckets
  marginFeedbackN: Float64Array; // nMarginBuckets

  constants: HoopsConstants;
}

function expect(cond: boolean, message: string): void {
  if (!cond) throw new StaleBlobError(message);
}

function flatten(rows: number[][], name: string, expectRows: number, expectCols: number): Matrix {
  expect(
    Array.isArray(rows) && rows.length === expectRows,
    `${name}: expected ${expectRows} rows, got ${Array.isArray(rows) ? rows.length : typeof rows}`,
  );
  const data = new Float64Array(expectRows * expectCols);
  for (let r = 0; r < expectRows; r++) {
    const row = rows[r];
    expect(
      Array.isArray(row) && row.length === expectCols,
      `${name}[${r}]: expected ${expectCols} cols, got ${Array.isArray(row) ? row.length : typeof row}`,
    );
    for (let c = 0; c < expectCols; c++) {
      const v = row[c];
      expect(Number.isFinite(v), `${name}[${r}][${c}] is not finite: ${v}`);
      data[r * expectCols + c] = v;
    }
  }
  return { data, rows: expectRows, cols: expectCols };
}

function vector(values: number[], name: string, expectLen: number): Float64Array {
  expect(
    Array.isArray(values) && values.length === expectLen,
    `${name}: expected length ${expectLen}, got ${Array.isArray(values) ? values.length : typeof values}`,
  );
  const out = new Float64Array(expectLen);
  for (let i = 0; i < expectLen; i++) {
    expect(Number.isFinite(values[i]), `${name}[${i}] is not finite: ${values[i]}`);
    out[i] = values[i];
  }
  return out;
}

/**
 * Decode + verify. Throws StaleBlobError on any disagreement with the
 * contract — a wrong number here is not recoverable, it's a wrong simulation.
 */
export function decodeParams(file: RawParamsFile): DecodedParams {
  expect(!!file && !!file.parameter_set, "hoops_params.json: missing parameter_set");
  const ps: RawParameterSet = file.parameter_set;

  // The load-bearing one: the fit this blob came from must be the fit the
  // engine was written against.
  expect(
    ps.param_version === EXPECTED_PARAM_VERSION,
    `stale parameter blob: hoops_params.json is PARAM_VERSION "${ps.param_version}", ` +
      `the engine expects "${EXPECTED_PARAM_VERSION}". ` +
      `Re-export from hoops-sim (uv run hoops export-hub) and update ` +
      `lib/hoops/blob-contract.json only after checking the engine still matches the fit.`,
  );

  // The blob carries its own shape constants; they must agree with the
  // contract AND with the actual array dimensions (checked below).
  expect(
    ps.n_tables === CONTRACT.nTables,
    `n_tables: blob says ${ps.n_tables}, contract says ${CONTRACT.nTables}`,
  );
  expect(
    ps.n_start_types === CONTRACT.nStartTypes,
    `n_start_types: blob says ${ps.n_start_types}, contract says ${CONTRACT.nStartTypes}`,
  );
  expect(
    ps.n_duration_rows === CONTRACT.nDurationRows,
    `n_duration_rows: blob says ${ps.n_duration_rows}, contract says ${CONTRACT.nDurationRows}`,
  );
  expect(
    ps.n_outcome_classes === CONTRACT.nOutcomeClasses,
    `n_outcome_classes: blob says ${ps.n_outcome_classes}, contract says ${CONTRACT.nOutcomeClasses}`,
  );
  expect(
    ps.n_regulation_periods === CONTRACT.nRegulationPeriods,
    `n_regulation_periods: blob says ${ps.n_regulation_periods}, contract says ${CONTRACT.nRegulationPeriods}`,
  );
  expect(
    ps.n_margin_buckets === CONTRACT.nMarginBuckets,
    `n_margin_buckets: blob says ${ps.n_margin_buckets}, contract says ${CONTRACT.nMarginBuckets}`,
  );

  // K is derived at fit time (measured at 18 on the 2025-26 fit) — not pinned
  // in the contract, but it must be self-consistent across the four arrays
  // that are all indexed by it.
  const nCategories = ps.categories.length;
  expect(nCategories > 0, "categories: empty");
  expect(
    ps.points.length === nCategories,
    `points: length ${ps.points.length} != categories ${nCategories}`,
  );
  expect(
    ps.outcome_class_of_category.length === nCategories,
    `outcome_class_of_category: length ${ps.outcome_class_of_category.length} != categories ${nCategories}`,
  );

  const gridSize = CONTRACT.gridSize;
  const nBinEdges = CONTRACT.durationBinEdges;

  const gridPpp = vector(ps.grid_ppp, "grid_ppp", gridSize);
  expect(
    Math.abs(gridPpp[0] - CONTRACT.gridPppMin) < 1e-9,
    `grid_ppp[0]: ${gridPpp[0]} != contract min ${CONTRACT.gridPppMin}`,
  );
  expect(
    Math.abs(gridPpp[gridSize - 1] - CONTRACT.gridPppMax) < 1e-9,
    `grid_ppp[last]: ${gridPpp[gridSize - 1]} != contract max ${CONTRACT.gridPppMax}`,
  );

  const decoded: DecodedParams = {
    paramVersion: ps.param_version,
    fittedAt: ps.fitted_at,
    dataAsOf: ps.data_as_of,
    source: ps.source,

    nTables: ps.n_tables,
    nStartTypes: ps.n_start_types,
    nDurationRows: ps.n_duration_rows,
    nOutcomeClasses: ps.n_outcome_classes,
    nRegulationPeriods: ps.n_regulation_periods,
    nMarginBuckets: ps.n_margin_buckets,
    nCategories,

    avgPossPerTeamGame: ps.avg_poss_per_team_game,
    regulationPeriodSeconds: ps.regulation_period_seconds,
    otPeriodSeconds: ps.ot_period_seconds,
    endgameWindowSeconds: ps.endgame_window_seconds,
    paceSigma: ps.pace_sigma,
    efficiencySigma: ps.efficiency_sigma,
    durationLevelScale: ps.duration_level_scale,
    durationDispersionScale: ps.duration_dispersion_scale,

    thetaGrid: flatten(ps.theta_grid, "theta_grid", ps.n_tables, gridSize),
    gridPpp,
    baseProbs: flatten(ps.base_probs, "base_probs", ps.n_tables, nCategories),
    baseMeanPpp: vector(ps.base_mean_ppp, "base_mean_ppp", ps.n_tables),
    points: vector(ps.points, "points", nCategories),
    outcomeClassOfCategory: Int32Array.from(ps.outcome_class_of_category),
    categories: ps.categories,
    tableLabels: ps.table_labels,
    durationBinEdges: vector(ps.duration_bin_edges, "duration_bin_edges", nBinEdges),
    durationCumprobs: flatten(
      ps.duration_cumprobs,
      "duration_cumprobs",
      ps.n_duration_rows,
      nBinEdges,
    ),
    durationTableMean: vector(ps.duration_table_mean, "duration_table_mean", ps.n_duration_rows),
    transitionCumprobs: flatten(
      ps.transition_cumprobs,
      "transition_cumprobs",
      ps.n_outcome_classes,
      ps.n_start_types,
    ),
    marginFeedbackPpp: vector(ps.margin_feedback_ppp, "margin_feedback_ppp", ps.n_margin_buckets),
    marginFeedbackN: vector(ps.margin_feedback_n, "margin_feedback_n", ps.n_margin_buckets),

    constants: file.constants,
  };

  expect(
    !!decoded.constants && Number.isFinite(decoded.constants.blend_weight),
    "constants: missing or malformed",
  );

  // Scalar sanity: every table_labels entry present, and the label count
  // matches the table count (the engine indexes tables by position).
  expect(
    decoded.tableLabels.length === decoded.nTables,
    `table_labels: length ${decoded.tableLabels.length} != n_tables ${decoded.nTables}`,
  );

  return decoded;
}
