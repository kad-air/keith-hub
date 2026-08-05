#!/usr/bin/env python
"""Generate the REAL-BLOB half of the cross-implementation engine check.

    cd ~/Code/hoops-sim && uv run python ~/Code/keith-hub/scripts/gen_real_blob_cases.py

Writes ``hoops-data/hoops_realblob_cases.json``: Python ``simulate_game``
results for a handful of real matchups, run against the exact rounded
ParameterSet that ships in ``hoops_params.json``. keith-hub's
``scripts/check-hoops-fixture.ts`` re-runs the same matchups through the
TypeScript engine and asserts every per-replicate value matches.

WHY THIS EXISTS ALONGSIDE hoops_fixture.json — the two are complementary, and
neither alone is sufficient. Measured by falsification, not assumed:

  * ``hoops_fixture.json`` is synthetic, 8 replicates, K=4, a 25-point grid.
    It is the ONLY check that exercises ``pace_sigma`` / ``efficiency_sigma``,
    because production ships both at 0.0 — with the real blob you can delete
    the pace and efficiency latents entirely and nothing notices.
  * These real-blob cases are 1,000 game-replicates over the real K=18 tables
    and 206-point grid, and they reach overtime, the end-game time buckets and
    the margin-feedback buckets that 8 replicates never do. Perturbing any of
    those in the engine slips past the synthetic fixture and is caught here.

REGENERATE THIS WHENEVER THE BLOB IS REGENERATED. The check is keyed to the
blob's content hash and fails loudly if they drift apart — deliberately, since
a new fit means the cross-implementation evidence has to be re-established, not
assumed to carry over.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd

from hoops.params import ParameterSet
from hoops.sim import simulate_game

HUB = Path(__file__).resolve().parent.parent
DATA = HUB / "hoops-data"

RUN_ID = "real-blob-crosscheck-v1"
N_SIMS = 200

# Chosen to span the state space the synthetic fixture can't reach: a lopsided
# favourite, a near coin-flip (which is where overtime actually happens), a
# neutral-site game, and two mid-strength pairings.
CASES = [
    ("OKC", "DEN", False),
    ("BOS", "NYK", False),
    ("MEM", "WAS", True),
    ("LAL", "GSW", False),
    ("CHA", "SAS", False),
]


def load_shipped_params(blob: dict) -> ParameterSet:
    """Build a ParameterSet from the ROUNDED, committed blob.

    Deliberately not `hoops.params.fit_from_possessions_v3` — the point is to
    simulate against the same numbers keith-hub actually ships, so any
    disagreement is the ENGINE, never float rounding in the export.
    """
    ps = blob["parameter_set"]
    arr = lambda k, dt=float: np.asarray(ps[k], dtype=dt)  # noqa: E731
    return ParameterSet(
        param_version=ps["param_version"],
        data_as_of=date.fromisoformat(ps["data_as_of"]),
        fitted_at=datetime.fromisoformat(ps["fitted_at"]),
        source=ps["source"],
        categories=[tuple(c) for c in ps["categories"]],
        points=arr("points"),
        outcome_class_of_category=arr("outcome_class_of_category", np.int64),
        table_labels=ps["table_labels"],
        base_probs=arr("base_probs"),
        base_mean_ppp=arr("base_mean_ppp"),
        grid_ppp=arr("grid_ppp"),
        theta_grid=arr("theta_grid"),
        transition_cumprobs=arr("transition_cumprobs"),
        duration_bin_edges=arr("duration_bin_edges"),
        duration_cumprobs=arr("duration_cumprobs"),
        pace_sigma=ps["pace_sigma"],
        efficiency_sigma=ps["efficiency_sigma"],
        duration_level_scale=ps["duration_level_scale"],
        duration_table_mean=arr("duration_table_mean"),
        duration_dispersion_scale=ps["duration_dispersion_scale"],
        margin_feedback_ppp=arr("margin_feedback_ppp"),
        margin_feedback_n=arr("margin_feedback_n"),
        avg_poss_per_team_game=ps["avg_poss_per_team_game"],
        team_ratings_current={},
        team_ratings_by_game=pd.DataFrame(),
    )


def main() -> int:
    params_path = DATA / "hoops_params.json"
    teams_path = DATA / "hoops_teams.json"
    if not params_path.exists():
        print(f"missing {params_path} — run `uv run hoops export-hub {DATA}` first")
        return 1

    params_bytes = params_path.read_bytes()
    blob = json.loads(params_bytes)
    ps = load_shipped_params(blob)
    teams = json.loads(teams_path.read_bytes())
    hca = teams["hca_pts"]

    cases = []
    n_ot_total = 0
    for home, away, neutral in CASES:
        rh, ra = teams["teams"][home]["blend"], teams["teams"][away]["blend"]
        r = simulate_game(
            ps, RUN_ID, f"xc-{home}-{away}", home, away,
            home_off=rh["off"], home_def=rh["def"],
            away_off=ra["off"], away_def=ra["def"],
            hca_pts=hca, n_sims=N_SIMS, neutral_site=neutral,
        )
        n_ot_total += int((r.n_ot_periods > 0).sum())
        cases.append(dict(
            home=home, away=away, neutral_site=neutral,
            home_off=rh["off"], home_def=rh["def"],
            away_off=ra["off"], away_def=ra["def"],
            final_home_score=[int(v) for v in r.final_home_score],
            final_away_score=[int(v) for v in r.final_away_score],
            poss_count_home=[int(v) for v in r.poss_count_home],
            poss_count_away=[int(v) for v in r.poss_count_away],
            n_ot_periods=[int(v) for v in r.n_ot_periods],
            mean_margin=round(float(r.mean_margin), 10),
            mean_total=round(float(r.mean_total), 10),
        ))
        print(f"  {home} vs {away}: margin {r.mean_margin:+.2f}, total {r.mean_total:.1f}")

    out = dict(
        description=(
            "Python simulate_game run against the EXACT rounded ParameterSet shipped in "
            "hoops_params.json. The TypeScript engine must reproduce every per-replicate value. "
            "Regenerate with scripts/gen_real_blob_cases.py whenever the blob is regenerated."
        ),
        run_id=RUN_ID,
        n_sims=N_SIMS,
        hca_pts=hca,
        param_version=blob["parameter_set"]["param_version"],
        # Ties these cases to the exact bytes they were produced from.
        params_sha256=hashlib.sha256(params_bytes).hexdigest(),
        replicates_reaching_ot=n_ot_total,
        cases=cases,
    )
    dest = DATA / "hoops_realblob_cases.json"
    dest.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    print(f"wrote {dest} ({len(CASES)} games x {N_SIMS} replicates, {n_ot_total} reached OT)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
