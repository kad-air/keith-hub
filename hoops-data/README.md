# hoops-data — the committed hoops-sim export

Generated data. **Do not hand-edit any JSON in this directory.**

These eight files are the entire boundary between `~/Code/hoops-sim` (the Mac
Mini: 20GB DuckDB over 8TB of parquet, Python model fitting) and The Feed's
Hoops section. The fitting stays there; the engine ports here; this bundle is
the only thing that crosses. Zero runtime dependency on the Mini.

## Regenerate

**Two commands, both from `~/Code/hoops-sim`.** The second is not optional — the
real-blob engine cases are pinned to the blob's sha256 and the build fails
loudly if they drift apart.

```bash
cd ~/Code/hoops-sim
uv run hoops export-hub ~/Code/keith-hub/hoops-data
uv run python ~/Code/keith-hub/scripts/gen_real_blob_cases.py

cd ~/Code/keith-hub && npm run check:hoops && npm run check:hoops:fixture
git add hoops-data && git commit -m "hoops: refresh the committed export"
```

Manual cadence, on your schedule — deliberately **not** wired into the
background poller. The exporter is read-only (`connect(read_only=True)`, no
view rebuild) and runs its own freshness/consistency gate before writing; it
exits non-zero if the export is dirty.

The importer picks a new bundle up automatically: `lib/hoops/import.ts` keys
on a content hash of these files, so the first hoops page load after a deploy
rewrites the read-model tables and an unchanged bundle costs one `SELECT`.

## The files

| File | Contents |
|---|---|
| `hoops_params.json` | the fitted `ParameterSet` — the possession model itself |
| `hoops_teams.json` | 30 teams × 3 rating modes (results/roster/blend), off/def |
| `hoops_players.json` | every rostered player's minutes, per-36 rates, and value |
| `hoops_schedule.json` | the 1,230-game season fixture list |
| `hoops_results.json` | the 200 most recent real finals |
| `hoops_lines.json` | closing spread/total per game — **lines only, no scores** |
| `hoops_fixture.json` | the Python half of the cross-implementation RNG fixture |
| `hoops_realblob_cases.json` | Python engine results over THIS blob — the other half of the engine check |

## Two landmines these files encode

- **`hoops_lines.json` carries no score columns, on purpose.** The line
  provider's own scores disagree with the truth on 3 of 1,315 games. Real
  finals live in `hoops_results.json` only, sourced from `dim_game`. If a
  score column ever reappears here, `npm run check:hoops` fails.
- **No result may be a tie.** An NBA game cannot end tied, so a tied final is
  the signature of reading a stale "End of period" play-by-play row instead of
  `dim_game` (one 2025-26 game reads 60–55 against a true 112–123 that way).
  Also asserted by the check.

## The two engine fixtures are not redundant

Established by falsification, not assumption. `hoops_fixture.json` is the only
check that exercises `pace_sigma`/`efficiency_sigma` — production ships both at
0.0, so against the real blob you can delete both latents and nothing notices.
`hoops_realblob_cases.json` is the only one that reaches overtime, the end-game
time buckets and the margin buckets, which 8 replicates never do. Both ship.

## `hoops_fixture.json` is not read-model data

It's the shared cross-implementation fixture: a fixed `run_id` + a deliberately
**synthetic** `ParameterSet` → a known result, pinned in hoops-sim's
`hoops verify` and (from milestone 2a) in the TypeScript engine port. Its
parameter set is synthetic so the pinned result doesn't move every time the
model is re-fit — the check asserts it never becomes the production fit.
