// Read the committed hoops-sim export off disk.
//
// The bundle lives at `hoops-data/*.json` in the repo, NOT under `data/` —
// `data/` is gitignored AND is where Railway mounts the persistent volume, so
// anything committed there would be invisible in production. Same runtime
// pattern as `config/feeds.yml`: read from `process.cwd()` with fs.
//
// Regenerate with, in ~/Code/hoops-sim:
//   uv run hoops export-hub ~/Code/keith-hub/hoops-data
// then commit the result. Manual cadence — deliberately NOT wired into the
// background poller (see CLAUDE.md, "Hoops").

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type {
  HoopsBundle,
  RawLinesFile,
  RawParamsFile,
  RawPlayersFile,
  RawResultsFile,
  RawScheduleFile,
  RawTeamsFile,
} from "./types";

export const HOOPS_DATA_DIR = path.join(process.cwd(), "hoops-data");

/** The six read-model files. hoops_fixture.json is not part of the read model —
 *  it's the cross-implementation RNG fixture, consumed by the engine port. */
export const BUNDLE_FILES = [
  "hoops_params.json",
  "hoops_teams.json",
  "hoops_players.json",
  "hoops_schedule.json",
  "hoops_results.json",
  "hoops_lines.json",
] as const;

function readJson<T>(filename: string): T {
  const p = path.join(HOOPS_DATA_DIR, filename);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Hoops export missing: ${p}. Run \`uv run hoops export-hub ${HOOPS_DATA_DIR}\` ` +
        `from ~/Code/hoops-sim and commit the result.`,
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

let bundleCache: HoopsBundle | null = null;

export function loadBundle(): HoopsBundle {
  if (bundleCache) return bundleCache;
  bundleCache = {
    params: readJson<RawParamsFile>("hoops_params.json"),
    teams: readJson<RawTeamsFile>("hoops_teams.json"),
    players: readJson<RawPlayersFile>("hoops_players.json"),
    schedule: readJson<RawScheduleFile>("hoops_schedule.json"),
    results: readJson<RawResultsFile>("hoops_results.json"),
    lines: readJson<RawLinesFile>("hoops_lines.json"),
  };
  return bundleCache;
}

/**
 * Content hash over all six files. This is the import's idempotency key: the
 * importer re-runs only when the committed bytes actually changed, so a
 * deploy picks up a new export automatically and a restart doesn't rewrite
 * 3,000 rows for nothing.
 */
export function bundleHash(): string {
  const h = crypto.createHash("sha256");
  for (const f of BUNDLE_FILES) {
    h.update(f);
    h.update(fs.readFileSync(path.join(HOOPS_DATA_DIR, f)));
  }
  return h.digest("hex");
}

/** Raw text of the parameter blob — stored verbatim in hoops_params.blob. */
export function readParamsBlobText(): string {
  return fs.readFileSync(path.join(HOOPS_DATA_DIR, "hoops_params.json"), "utf-8");
}
