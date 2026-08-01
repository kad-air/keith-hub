# Hoops — implementation plan

> A full NBA simulation & what-if studio, living as a section of The Feed.
> Self-contained: fit on the Mac Mini, commit the data, run the engine in the browser.

**Status:** PLAN (no code yet). Decision recorded 2026-07-31.
**Supersedes:** hoops-sim's `docs/IDEA_hub-sandbox.md` (the "toy sandbox" idea), **deleted
2026-07-31** — recoverable from that repo's git history at commit `8c85b64`. This doc scopes the
*full* product (db + api + engine + full UI/UX), not just a single-game toy; everything from that
doc that still binds is carried forward below.

---

## 0. The decision

Reproduce hoops-sim's functionality inside keith-hub as a real product section, **self-contained
with zero runtime dependency on the Mac Mini** (chosen over a live Tailscale bridge and over a
hybrid). This is the `/comics` pattern scaled up: heavy work runs offline in the sibling repo, the
output is committed data, and the app (browser + Next API) is the whole thing.

**Why not a live bridge to the Mini:** seconds per tap, needs the Mini awake with the HDD spun up,
and it kills the live-while-editing sandbox that is the whole point of the studio. The Mini's hoops
MCP tools already exist and can back a *later* Tier-3 add (see §11), but v1 does not touch them.

### Prior decisions carried forward (from the deleted idea doc)

1. **Not a feed category — its own section.** Owner decision 2026-07-30: *"not in the feed — as
   like a toy that is a separate area in the app."* It matches The Feed's own principles: the feed
   is **triage, not consumption**, and a simulator is something you go to *in order to* consume.
   `/comics` is the existing precedent for a non-feed area and is structurally the right template.
2. **The sizing that made client-side viable** (this is why §0's decision is the *cheap* option,
   not the ambitious one): measured engine throughput **2.16M possessions/sec**; a full game is
   **~200 possessions**; a **2000-replicate distribution ≈ 400k possessions** → tens to a few
   hundred ms in JS even assuming a scalar port runs 10–50× slower than vectorized numpy. The
   parameter blob is **≈18,000 floats ≈ 144 KB float64, under 50 KB gzipped** as rounded JSON —
   smaller than one feed card's image, and cacheable by the service worker keith-hub already ships.
   **Consequence that decides the UX:** at ~100ms for a full distribution you get live re-simulation
   *while editing*, which is the entire difference between a studio and a form submit.
3. **The `sim.py` seam is what makes any of this possible** — and it must not be dissolved. See §6.
4. ⚠️ **One deliberate reversal to re-confirm.** The parked doc *dropped* a "sim vs Vegas" surface
   on the grounds that M1 measured the market at MAE 10.812 and the sim at ~11.38–11.39 — the market
   beats the model, so anything implying an edge would be the confident-wrong-answer this project is
   built against. This plan **reintroduces it** as `/hoops/tonight`, framed strictly as *the sim's
   read*, a curiosity, never an edge (§8). That framing is load-bearing; if it can't be held in the
   UI, cut the screen rather than soften the framing.

---

## 1. The constraint that shapes everything

keith-hub runs on Railway (cloud, SQLite, ~small). hoops-sim's real spine — a 20GB+ DuckDB over
parquet on the 8TB HDD, plus Python fitting — **cannot move to Railway.** So "db + api + code" is a
faithful *reproduction*, not a lift-and-shift. It's possible because of one seam hoops-sim already
built and enforces: `src/hoops/sim.py` is pure numpy that never touches DuckDB (asserted every run
by `hoops.verify.check_m2_in_season_safety`). The **engine ports**; only the **fitting stays
behind**.

### Three tiers; v1 is Tier 1 + Tier 2

| Tier | Capability | Home in keith-hub | Answers |
|---|---|---|---|
| **1 — Engine** | sim, boxscore, whatif, season+playoffs, ratings/roster-edit application, projected lines | TS port in `lib/hoops/`, run **both** client-side (live editing) and inside API routes (SSR, shareable links) | **the code** |
| **2 — Read-model** | team ratings (results/roster/blend), rosters + player rates, schedule, recent real finals, closing lines | published snapshot → keith-hub **SQLite**, refreshed by a generator on demand | **the db** |
| **3 — Full spine** *(deferred)* | replay an arbitrary historical game, full historical box scores, scorecard/evaluation backtests | optional live bridge to the Mini's existing hoops MCP tools | later |

---

## 2. Repo split & data flow

```
hoops-sim (Mac Mini, DuckDB + 8TB HDD)          keith-hub (Railway, SQLite)
─────────────────────────────────────           ──────────────────────────────
fit ParameterSet ─┐                              lib/hoops/engine.ts  (TS port)
ridge values      ├─ generate-hoops-data ──►  ┌─ data seed  ──► SQLite read-model
team ratings      │   (committed JSON,        │  (hoops_params, hoops_teams,
shares / minutes  │    comics-style)          │   hoops_players, hoops_schedule,
schedule/results/ ┘                           │   hoops_results, hoops_lines)
odds                                          │
                                              └─ user scratch  (hoops_scratch, hoops_runs)
hoops verify  ── asserts shared fixture ──────── npm run build  asserts SAME fixture
```

Refresh cadence is manual (`npm run`-style, on Keith's schedule) — comics-style, **not** wired into
the background poller. Railway auto-deploys on push.

---

## 3. The generator (hoops-sim side)

New `~/Code/hoops-sim/scripts/generate-hoops-data.mjs` — no, it must run *Python* to read DuckDB,
so it's a new `hoops` CLI subcommand instead: **`uv run hoops export-hub <dest>`** (a sibling to the
other read-only entry points, `connect(read_only=True)`, never a view rebuild). It writes committed
JSON that keith-hub imports.

Exports:

| File | Contents | Source |
|---|---|---|
| `hoops_params.json` | the `ParameterSet` blob: `theta_grid` (47×G), `duration_cumprobs` (62×n_bins+1), `base_probs` (47×K), `base_mean_ppp`, `duration_table_mean`, transition/margin-feedback arrays, `grid_ppp`, `duration_bin_edges` | `hoops.params` fitted set |
| `hoops_teams.json` | 30 teams × 3 rating modes (results / roster / blend), off/def strength | `rosterratings`, `blend`, results ratings |
| `hoops_players.json` | ~500 players' shares / minutes / per-36 rates + ridge value | `attribution`, `minutesmodel`, `availability` |
| `hoops_schedule.json` | current-season schedule | `season.load_season_schedule` |
| `hoops_results.json` | recent real finals (trustworthy source — `max(score_*)`, **not** last event) | `dim_game` |
| `hoops_lines.json` | closing pointspread / total per game | `odds_lines` (lines only; scores from `dim_game`) |

**Constants that pin the blob shape** (from `hoops.params`, verified): `N_TABLES = 47`
(5 start types + 42 end-game cells), `N_DURATION_ROWS = 62`, PPP grid `GRID_PPP_MIN=0.15 →
GRID_PPP_MAX=2.20 @ 0.01`, duration bins `0→120 @ 1.0`. **`K` (the `base_probs` second axis) is
derived at fit time and must be measured on the generator's first run** — the payload estimate
(~50 KB gzipped) is robust to K anyway (K=20 adds only ~470 floats) but the doc's number stays an
estimate until measured. Round floats before emitting to keep the blob small and diff-friendly.

**Freshness/consistency check** baked into the export (fails loudly, per project convention):
team count == 30, all ratings finite, blob round-trips through decode, player rates present for
every rostered player, `PARAM_VERSION` recorded so a stale blob is detectable.

---

## 4. The DB (keith-hub SQLite)

Read-model tables (rewritten on import, like `sources`) + user-only tables (never sync back to
git — roster edits made on the phone must **not** write to hoops-sim's `data/roster_edits.json`,
which drives the CLI):

```
hoops_params    (singleton row: PARAM_VERSION, blob json, generated_at)
hoops_teams     (tri PK, conf, div, mode, off, def)         -- read-model
hoops_players   (player_id, tri, name, minutes, shares json, value)  -- read-model
hoops_schedule  (game_id, date, home, away, ...)            -- read-model
hoops_results   (game_id, home_score, away_score, ...)      -- read-model
hoops_lines     (game_id, spread, total, book, ...)         -- read-model
hoops_scratch   (id, name, edits json, updated_at)          -- USER scratch roster sets
hoops_runs      (run_id PK, home, away, edits json, result json, saved_at)  -- USER saved sims
```

Follows the `comic_state` precedent: hoops gets its **own** tables, entirely outside
`items`/`item_state` and outside the poller.

---

## 5. The API (Next.js route handlers)

Same idiom as `/api/items`, `/api/trackers`, `/api/comics`. The ported engine runs server-side
here, so every capability has a real endpoint (and the client can call the same TS module directly
for live editing):

```
POST /api/hoops/sim        {home, away, neutral, nSims}      -> winProb, scoreDist, spread, total
POST /api/hoops/boxscore   {home, away, mode, runId?}        -> expected | one sampled (integer-summing)
POST /api/hoops/whatif     {home, away, edits}               -> paired baseline-vs-edited, CALIBRATED delta+range
POST /api/hoops/season     {team?, edits?, replicates}       -> win-total quantiles, playoff odds, seeds, bracket
GET  /api/hoops/teams?mode=                                  -> 30 teams ranked
GET  /api/hoops/roster/[tri]                                 -> roster + per-player value
POST /api/hoops/roster/edit  {scratchId, op}                 -> mutate a scratch roster set
GET  /api/hoops/tonight                                      -> tonight's slate, sim read vs market
```

---

## 6. The engine port (TS, shared client + server)

New `lib/hoops/`:
- `engine.ts` — port of `sim.py::simulate_game` (the possession loop, `_grid_interp`,
  `_inverse_cdf_duration`, `_lineup_deltas`) and `boxscore.py`'s multinomial share allocation.
- `rng.ts` — port of `hoops.rng` (`stream`/`uniform`/`normal`/`spawn_run_id`), keyed by
  `(run_id, purpose, *coords)`.
- `season.ts` — port of `season.py::simulate_season_replicates` + the normal-margin playoff link
  (`sigma_margin`, seeding, play-in, best-of-7 bracket).
- `params.ts` — decode `hoops_params.json` into typed arrays.
- `ratings.ts` — apply ratings mode + roster edits to team strength (delta-only for skill edits,
  matching L2's design).

**Ports:** the possession loop, share allocation, rng keying, ratings/roster-edit application, the
season/playoff link. **Does not port:** anything touching DuckDB — that boundary is already drawn.

### 🔴 The #1 technical risk: bit-exact RNG parity

`hoops.rng` seeds a numpy PCG64 `Generator` from a digest of `(run_id, purpose, coords)`. For a
**shared** fixture (§7) to pass in TS, the TS RNG must produce the *identical* stream — which means
porting both the digest keying **and** PCG64 itself, bit-for-bit. This is the crux of the
self-contained approach. Mitigation: a reference PCG64 port + the exact seeding digest, proven by
the fixture on day one of the port (build the fixture first, not last).

---

## 7. 🔴 The shared cross-implementation fixture (non-negotiable)

A TS port is a **second implementation** of a validated engine, and this project has repeatedly
caught two implementations of one thing silently disagreeing (the units bug between `whatif` and
`rosterratings`; the stale-score landmine inside a *green* acceptance table). So the same change
must ship:

> a fixed `run_id` + a fixed `ParameterSet` → a known box score, asserted **both** in
> `hoops verify` (Python) and in keith-hub's `npm run build` (TS).

This is a genuine cross-implementation check — stronger than the internal consistency this project
explicitly rejects. It is the deliverable's real acceptance criterion, and it must exist before the
UI is trusted.

---

## 8. The UI/UX (mobile-first PWA, The Feed's magazine language)

### Wiring
- New section in `lib/sections.ts`: `HOOPS_SECTION` in the **Library** group (alongside Comics),
  its own `cat.hoops` token added to `tailwind.config.ts` (never hardcode hexes).
- Sub-nav via `SubBar` (the real nav is `Masthead` / `SubBar` / `Contents` — **not** the
  `HeaderNav`/`BottomNav` that keith-hub's CLAUDE.md still wrongly names; fix that drift alongside).
- Visual language reused: **Newsreader** for scores/names, **JetBrains Mono** for stats / kickers /
  `run_id`, ink-on-cream, accent reserved for the primary **Sim** action.
- PWA gotchas preserved: hand-rolled manifest link, anchor-click (not `window.open`) for any
  external handoff. Keyboard layer reused (`lib/useKeyboard.ts`).

### Sitemap

| Screen | Route | What you do |
|---|---|---|
| **Matchup** (home) | `/hoops` | Home/away pickers + neutral toggle → **Sim**. Win prob, projected spread + total, score-distribution histogram, expected box score. The core verb. |
| **Studio** (flagship) | `/hoops/studio` | Roster editor (remove / add real / trade / add fictional / availability / skill) with the line and win prob **re-simming live as you edit** (client-side, ~100ms). Calibrated delta + honest range. |
| **Result** | `/hoops/game/[runId]` | One sampled game — final score, OT count, integer box lines that sum exactly, shareable `run_id` deep link. Reproducible. |
| **Season** | `/hoops/season` | Pick a team (or league) → 82-game win-total quantiles, playoff odds, seed distribution, an interactive bracket. Runs on edited rosters too. |
| **Teams** | `/hoops/teams`, `/hoops/teams/[tri]` | 30 teams ranked (results/roster/blend toggle); tap for roster + per-player value, editable into the studio. |
| **Tonight** | `/hoops/tonight` | Tonight's real slate: the sim's read vs the market — framed as **curiosity, not an edge** (M1: market MAE 10.8 beats the sim's 11.4). |

### Non-negotiable UX carries (correctness, not polish)
- **Variance-honesty note on every box score** — player spread *understates* real game-to-game
  variance (no hot/cold nights, no minutes variance). Printed on every CLI output today; must
  render in the UI too.
- **`run_id` always visible and shareable** — free reproducibility.
- **Ratings-mode choice exposed** with its churn caveat (bottom-up noise floor ~3.6 MAE on
  low-churn teams; a caveat fires above 30% churn).
- **Counterfactual deltas shown as calibrated central + range** (M6.5 shipped → the old
  "unvalidated" caveat is paid; `CALIBRATION_K=2.217`). Never a silent multiply.
- **Never imply a betting edge** — the market beats the model; the "sim vs Vegas" view is framed as
  the sim's read.

---

## 9. Build / verify gates (every milestone ships one)

- `npm run build` — the type gate (keith-hub has no test suite).
- The **shared fixture** (§7), asserted in both repos.
- The **generator freshness/consistency check** (§3).
- A keith-hub-side check that the imported blob decodes and `PARAM_VERSION` matches what the engine
  expects (a stale-blob guard).

---

## 10. Implementation milestones (each ends with a runnable check)

1. **Export + import spine.** `hoops export-hub` writes the JSON; keith-hub imports into SQLite;
   `/api/hoops/teams` and `/hoops/teams` render 30 teams. *Check:* generator consistency + blob
   decode on build.
2. **Engine port + fixture.** Port `rng.ts` + `engine.ts`; stand up the shared fixture in both
   repos. *Check:* the fixture (the load-bearing one — do this before any UI is trusted).
3. **Matchup + boxscore.** `/api/hoops/sim`, `/api/hoops/boxscore`, `/hoops`, `/hoops/game/[runId]`.
   *Check:* sampled box lines sum to the final score (integer identity) in a build-time assertion.
4. **Studio (whatif).** Roster scratch state, live re-sim, calibrated delta. *Check:* an unedited
   roster is bit-identical to baseline (the delta-only invariant).
5. **Season + playoffs.** `season.ts`, `/hoops/season`, bracket. *Check:* playoff structural
   invariants (bracket topology, seed counts) at build time.
6. **Tonight + polish.** Slate view, honesty framing, keyboard shortcuts, PWA verification via
   `scripts/inspect.mjs html`.

---

## 11. Deferred (Tier 3) & open questions

- **Tier 3 (real-spine features)** — replay an arbitrary historical game, full historical box
  scores, scorecard/evaluation — need the 20GB DuckDB and would arrive via a thin HTTP proxy to the
  Mini's existing hoops MCP tools (`hoops_replay_game`, etc.). Out of v1 scope.
- **Measure K** before quoting the payload size as fact (§3).
- **Mobile roster-editor interaction** is the real unsketched design work (trade / add / availability
  on a phone) — worth a mockup against the real theme tokens before building milestone 4.
- **Doc drift to fix alongside:** keith-hub's CLAUDE.md still names `HeaderNav.tsx`/`BottomNav.tsx`
  (gone; real nav is `Masthead`/`SubBar`/`Contents`).
