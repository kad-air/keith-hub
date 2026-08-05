#!/usr/bin/env python
"""Generate the cross-implementation check for the multinomial draw.

    cd ~/Code/hoops-sim && uv run python ~/Code/keith-hub/scripts/gen_multinomial_cases.py

Writes ``hoops-data/hoops_multinomial_cases.json``: the exact integer output of
``hoops.rng.stream(...).multinomial(n, pvals)`` under the REAL numpy, for a set
of cases chosen to hit every branch of numpy's sampler. keith-hub's
``scripts/check-hoops-multinomial.ts`` replays the same coordinates through
``lib/hoops/binomial.ts`` and asserts every integer matches.

WHY THIS EXISTS. ``hoops.boxscore`` allocates every integer box-score stat with
``rng.stream(...).multinomial(team_total, shares)``. keith-hub ships a second
implementation of that allocation, so the same rule the possession engine lives
under applies: the two implementations have to be proven equal against a fixed
fixture, not assumed equal because the maths "is just a multinomial". numpy's
multinomial is a chain of binomials, and its binomial has two samplers
(inversion below ``p*n == 30``, BTPE above) that consume different numbers of
uniforms — a port that picks the wrong one still returns plausible integers
while being silently desynchronised from Python forever after.

THE CASES, and what each one is for (a port can pass some and fail others,
which is the point):

  * ``inversion_*``  — every conditional p*n stays under 30, so only the
    inversion sampler runs. This is the realistic box-score shape: ~110 points
    across ~15 players.
  * ``btpe_*``       — a conditional p*n well over 30, forcing BTPE, including
    a case whose first conditional p is above 0.5 so the complement flip fires
    BEFORE the sampler is chosen.
  * ``exhaust_*``    — the count runs out partway down the list, so the trailing
    categories consume NO randomness at all. A port that keeps drawing here
    stays in sync on this call and desynchronises on the next one.
  * ``degenerate_*`` — a share of exactly 0, a share of ~1, and n = 0.
  * ``sequence_*``   — MANY draws in a row off ONE stream. Two jobs. It is the
    pattern ``_build_expected_team`` uses for its p10/p90 pass, so it pins that
    generator state carries across calls; and it is the only way to reach
    BTPE's rare regions, because a single BTPE draw lands in the central
    parallelogram and accepts immediately ~77% of the time. The triangle
    region's ``v > 1`` rejection and the tail regions need hundreds of draws
    before they fire even once.

🔴 THE CASE LIST WAS SIZED BY FALSIFICATION, NOT BY TASTE. An earlier version
with one BTPE draw per shape passed while five separate perturbations of the
port went undetected (a dropped step-20 rejection, a moved squeeze boundary,
a mis-set branch threshold). The long sequences below are what closed that;
see check-hoops-multinomial.ts's own header for the two perturbations that
remain undetectable and why that is correct rather than a gap.

REGENERATE only if the case list changes — this fixture is not keyed to the
blob (it exercises the RNG, not the fit), so a re-fit does not invalidate it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from hoops import rng

OUT = Path.home() / "Code" / "keith-hub" / "hoops-data" / "hoops_multinomial_cases.json"

RUN_ID = "multinomial-fixture-v1"


def norm(p: list[float]) -> list[float]:
    """numpy requires pvals to sum to 1 within tolerance; the callers in
    hoops.boxscore always renormalize first, so the fixture does too."""
    total = float(sum(p))
    return [float(x) / total for x in p]


# Realistic box-score share vectors, taken to be the shape a 15-man rotation
# actually produces (a few heavy usage players, a long thin tail).
ROTATION_15 = norm([
    0.185, 0.155, 0.130, 0.105, 0.085, 0.070, 0.058, 0.048,
    0.040, 0.032, 0.025, 0.020, 0.020, 0.015, 0.012,
])
ROTATION_8 = norm([0.24, 0.19, 0.15, 0.12, 0.10, 0.08, 0.07, 0.05])

CASES: list[dict] = [
    # --- inversion only: every conditional mean stays under 30 -------------
    {"name": "inversion_pts_15man", "n": 112, "pvals": ROTATION_15, "coords": ["DEN", "pts"]},
    {"name": "inversion_reb_15man", "n": 44, "pvals": ROTATION_15, "coords": ["DEN", "reb"]},
    {"name": "inversion_ast_8man", "n": 26, "pvals": ROTATION_8, "coords": ["OKC", "ast"]},
    {"name": "inversion_tov_8man", "n": 13, "pvals": ROTATION_8, "coords": ["OKC", "tov"]},
    {"name": "inversion_stl_tiny", "n": 7, "pvals": ROTATION_15, "coords": ["BOS", "stl"]},

    # --- BTPE: a conditional p*n comfortably over 30 ------------------------
    {"name": "btpe_two_way", "n": 10000, "pvals": [0.5, 0.5], "coords": ["btpe", "a"]},
    {"name": "btpe_skewed", "n": 5000, "pvals": norm([0.7, 0.2, 0.1]), "coords": ["btpe", "b"]},
    # First conditional p = 0.82 > 0.5, so random_binomial takes the complement
    # branch and evaluates the sampler threshold on q, not p.
    {"name": "btpe_flip_gt_half", "n": 4000, "pvals": norm([0.82, 0.12, 0.06]),
     "coords": ["btpe", "flip"]},
    # Straddles the boundary: p*n == 30 exactly goes to INVERSION (<=), 31 to BTPE.
    {"name": "boundary_pn_30", "n": 60, "pvals": [0.5, 0.5], "coords": ["edge", "30"]},
    {"name": "boundary_pn_31", "n": 62, "pvals": [0.5, 0.5], "coords": ["edge", "31"]},
    {"name": "btpe_large_rotation", "n": 3000, "pvals": ROTATION_15, "coords": ["btpe", "rot"]},

    # --- early exhaustion: the tail draws nothing ---------------------------
    {"name": "exhaust_small_n_long_tail", "n": 3, "pvals": ROTATION_15, "coords": ["ex", "a"]},
    {"name": "exhaust_front_loaded", "n": 5, "pvals": norm([0.97, 0.01, 0.01, 0.005, 0.005]),
     "coords": ["ex", "b"]},

    # --- degenerate ---------------------------------------------------------
    {"name": "degenerate_zero_n", "n": 0, "pvals": ROTATION_8, "coords": ["deg", "zero"]},
    {"name": "degenerate_zero_share", "n": 50, "pvals": norm([0.5, 0.0, 0.3, 0.0, 0.2]),
     "coords": ["deg", "share"]},
    {"name": "degenerate_single_category", "n": 40, "pvals": [1.0], "coords": ["deg", "one"]},
    {"name": "degenerate_near_certain", "n": 90, "pvals": norm([0.999, 0.001]),
     "coords": ["deg", "certain"]},
]

# Many draws off ONE stream, in order. The realistic one is the expected-mode
# p10/p90 pattern; the rest are volume, which is the only way BTPE's rare
# regions get reached at all.
SEQUENCES: list[dict] = [
    {
        "name": "sequence_expected_pts_alloc",
        "coords": ["seq", "DEN"],
        "pvals": ROTATION_15,
        "ns": [108, 121, 99, 115, 130, 87, 112, 104, 118, 95],
    },
    # 300 BTPE draws at the symmetric shape: reaches the triangle region's
    # `v > 1` rejection, both tail regions, and the squeeze.
    {
        "name": "sequence_btpe_two_way",
        "coords": ["seq", "btpe2"],
        "pvals": [0.5, 0.5],
        "ns": [10000] * 300,
    },
    # Skewed, so the first conditional p is 0.7 (> 0.5, complement flip) and
    # the second is 0.2/0.3 — two different BTPE setups per draw.
    {
        "name": "sequence_btpe_skewed",
        "coords": ["seq", "btpe3"],
        "pvals": norm([0.7, 0.2, 0.1]),
        "ns": [4000] * 200,
    },
    # Small nrq, so |y - m| stays inside the exact-ratio test rather than the
    # Stirling squeeze — the other half of step 50.
    {
        "name": "sequence_btpe_small_nrq",
        "coords": ["seq", "btpeS"],
        "pvals": [0.5, 0.5],
        "ns": [70] * 200,
    },
    # A full 15-man rotation at realistic box-score totals, 200 times over —
    # every conditional stays on the inversion path.
    {
        "name": "sequence_inversion_rotation",
        "coords": ["seq", "inv15"],
        "pvals": ROTATION_15,
        "ns": [95 + (i * 7) % 45 for i in range(200)],
    },
    # Walks n across the p*n == 30 threshold one step at a time, at p = 0.5:
    # n = 58..66 straddles it, so an off-by-one in the branch test shows up as
    # a whole-sequence mismatch rather than needing luck on a single draw.
    {
        "name": "sequence_threshold_straddle",
        "coords": ["seq", "edge"],
        "pvals": [0.5, 0.5],
        "ns": [n for _ in range(20) for n in range(58, 67)],
    },
]


def main() -> int:
    cases = []
    for c in CASES:
        s = rng.stream(RUN_ID, "multinomial-fixture", *c["coords"])
        draw = s.multinomial(c["n"], np.asarray(c["pvals"], dtype=float))
        assert int(draw.sum()) == c["n"], f"{c['name']}: multinomial did not preserve n"
        cases.append({
            "name": c["name"],
            "coords": c["coords"],
            "n": c["n"],
            "pvals": c["pvals"],
            "expected": [int(v) for v in draw],
        })

    sequences = []
    for sq in SEQUENCES:
        s = rng.stream(RUN_ID, "multinomial-fixture", *sq["coords"])
        pv = np.asarray(sq["pvals"], dtype=float)
        draws = []
        for n in sq["ns"]:
            d = s.multinomial(int(n), pv)
            assert int(d.sum()) == n
            draws.append([int(v) for v in d])
        sequences.append({**sq, "expected": draws})

    payload = {
        "generator": "scripts/gen_multinomial_cases.py",
        "numpy_version": np.__version__,
        "rng_namespace": rng._NAMESPACE,
        "run_id": RUN_ID,
        "purpose": "multinomial-fixture",
        "cases": cases,
        "sequences": sequences,
    }
    OUT.write_text(json.dumps(payload, indent=1) + "\n")
    total = sum(len(s["expected"]) for s in sequences)
    print(f"wrote {OUT} — {len(cases)} cases + {len(sequences)} sequences ({total} draws)")
    print(f"numpy {np.__version__}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
