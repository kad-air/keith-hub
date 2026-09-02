// Pure, DB-free port of hoops-sim's roster-pricing formula — no fs, no
// SQLite, same "pure helpers" discipline as rating.ts.
//
// Ported from (read, not modified — that repo is out of scope for this
// change): ~/Code/hoops-sim's src/hoops/minutesmodel.py
// (`allocate_minutes`, `allocate_minutes_with_absorption`) and
// src/hoops/rosterratings.py (`raw_team_strength`, `team_net_rating`), plus
// src/hoops/availability.py's `_side_value`.
//
// Built for kad-air/hoops-sim#24's "pricing fixture" — the wire contract's
// last section: the pricing layer doesn't have a cross-implementation
// fixture yet, the way the possession engine already does
// (hoops_fixture.json / lib/hoops/engine.ts). See
// scripts/check-hoops-pricing-fixture.ts for how this gets asserted against
// the sender's fixture once it lands.
//
// 🔴 Nothing here hardcodes a constant VALUE. Every constant this formula
// needs is a named field on `PricingConstants`, read off the wire contract's
// `constants` block — see lib/hoops/contract.ts's REQUIRED_CONSTANTS, which
// is exactly this interface's key set.
//
// 🔴 `net` here is a RAW, uncentered strength. `league_mean_raw` (the
// recentering constant) is deliberately never sent over the wire —
// kad-air/keith-hub#66 — so this module can only ever compute a raw strength
// or a delta between two raw strengths, never an absolute recentered rating.
// `off = net/2`, `def = -net/2` is the `symmetric_off_def` feature — a
// positive `def` means points ALLOWED above average (lib/hoops/rating.ts's
// own convention, unchanged, carried through here).
//
// ── hub-v2: what the two new feature tokens change here ──────────────────
//
//   split_off_def — a player's OFFENCE lands on his new team's offence and
//   his DEFENCE on its defence, instead of half his net landing on each. The
//   arithmetic is a SECOND minutes-weighted sum, over each man's
//   offence-minus-defence lean ("tilt"), alongside the net sum that was
//   already here — the net is computed by the untouched original lines and is
//   never derived from the two sides, which is what makes it structurally
//   impossible for this feature to move a margin or a win probability.
//   Ported from hoops-sim's `rosterratings.split_off_def` /
//   `_make_roster_tilt_of`.
//
//   depth_chart_minutes — a real NBA rotation is top-heavy, and plain
//   proportional shares are not: a star's minutes get bid down by a crowded
//   bench exactly as easily as a 14th man's get bid up. The fix is a fitted
//   ROTATION CURVE (mean real minutes at each rotation rank), blended into
//   each man's own expected minutes at weight `depth_chart_w` and then
//   renormalised to 240 through the SAME allocateMinutes call as before.
//   Ported from hoops-sim's `minutesmodel._depth_chart_blend` /
//   `allocate_minutes_depth_chart` / `allocate_minutes_with_absorption_depth_chart`
//   and `rosterratings._depth_chart_rank_key`.
//
// 🔴 WHAT IS DELIBERATELY *NOT* PORTED: the dressed-list soft cut
// (`minutesmodel.allocate_minutes_dressed`, hoops-sim issue #45). Evidence,
// not caution: hoops-sim's own trade pricer (`rosterratings.price_trial_move`)
// and its `whatif`/`seasonwhatif` paired arms all price an edit through
// `team_net_rating`, which takes no `dressed_probs` at all — the dressed
// weighting is applied only by the 30-team baseline pass
// (`compute_all_roster_ratings`), whose output this receiver TRANSPORTS rather
// than re-derives. Porting it would give the hub a pricing function that no
// hoops-sim surface has, which is the second-implementation trap this
// fixture exists to prevent. It stays server-side.

export interface PricingConstants {
  total_team_minutes: number;
  bench_default_minutes: number;
  absorption_phi: number;
  ghost_athlete_id: number;
  replacement_per36: number;
  /** hub-v2, `split_off_def` only: the offence-minus-defence lean handed to
   *  anybody the per-side model has no opinion about — a no-history bench man,
   *  a fictional add carrying only a declared net, and the absorption ghost.
   *  🔴 Pointedly NOT 0: every team's tilt is recentred against the 30-team
   *  mean, so handing an unknown player 0 while every known player carries the
   *  pool's own non-zero mean would give a team a spurious tilt in proportion
   *  to how many unknowns it rosters — an artefact of ignorance read as a
   *  claim about that team's style. */
  replacement_tilt_per36?: number;
  /** hub-v2, `depth_chart_minutes` only. `depth_chart_curve` is keyed by rank
   *  as a STRING ("1".."15"), which is what JSON gives us; ranks past the last
   *  key all share that last value. */
  depth_chart_w?: number;
  depth_chart_curve?: Record<string, number>;
}

export interface PricingPlayer {
  athlete_id: number;
  /** Raw expected minutes (season-typical / trailing average), BEFORE
   *  allocation. null/undefined -> falls back to bench_default_minutes,
   *  exactly like a no-history player on the hoops-sim side. */
  raw_minutes: number | null | undefined;
  /** Net value production per 36 minutes. null/undefined -> replacement_per36. */
  value_per36: number | null | undefined;
  /** hub-v2, `split_off_def`: his two sides. They ADD to value_per36 and a
   *  POSITIVE def is GOOD defence — the opposite of the TEAM convention above,
   *  and the same inversion hoops_players/hoops_teams already carry. Both
   *  null/absent -> he is handed `replacement_tilt_per36`. */
  value_off_per36?: number | null;
  value_def_per36?: number | null;
  /** hub-v2, `depth_chart_minutes`: does he have a real minutes history on
   *  THIS team? A man who does keeps his own expected minutes as his rotation
   *  rank; a man who does not (a trade arrival, a rookie, a fictional add) is
   *  slotted by interpolating his VALUE against his history-having teammates'
   *  own (minutes, value) pairs, so a star arrival lands near the top of the
   *  rotation instead of stranded at bench-tier rank.
   *
   *  Defaults to `raw_minutes != null`, which is right for a real player: the
   *  bundle's `minutes` field falls back to bench_default_minutes exactly when
   *  there is no history. A fictional add must say `false` explicitly — he has
   *  stated minutes and no history, and nothing else can tell the two apart. */
  has_history?: boolean;
}

export interface AllocationResult {
  /** athlete_id -> allocated minutes. Sums to `budget` (allocateMinutes) or
   *  `budget - ghostMinutes` (allocateMinutesWithAbsorption). */
  shares: Map<number, number>;
  ghostMinutes: number;
}

/** hoops.minutesmodel.allocate_minutes — proportional renormalization to the
 *  team minutes budget. Equal split on a degenerate (all-zero/empty) input,
 *  matching the Python fallback exactly. */
export function allocateMinutes(raw: Map<number, number>, budget: number): Map<number, number> {
  let total = 0;
  for (const v of raw.values()) total += v;
  const out = new Map<number, number>();
  if (total <= 0) {
    const n = raw.size;
    for (const a of raw.keys()) out.set(a, n > 0 ? budget / n : 0);
    return out;
  }
  for (const [a, v] of raw) out.set(a, (budget * v) / total);
  return out;
}

/**
 * hoops.minutesmodel.allocate_minutes_with_absorption. `phi` of the absent
 * pool's raw minutes goes to a synthetic ghost slot (NOT included in the
 * returned map — callers add `{ghost_athlete_id: ghostMinutes}` themselves,
 * same convention as raw_team_strength); the remaining `1-phi` redistributes
 * proportionally across `remainingRaw`, same as plain allocateMinutes would.
 *
 * Bit-identical to `allocateMinutes(remainingRaw, budget)` (ghostMinutes=0)
 * whenever `absentRaw` is empty or sums to <=0 — delegates to that exact
 * function rather than reducing to it algebraically, matching hoops-sim's
 * own no-absence bit-identity guarantee.
 */
export function allocateMinutesWithAbsorption(
  remainingRaw: Map<number, number>,
  absentRaw: Map<number, number>,
  budget: number,
  phi: number,
): AllocationResult {
  let totalAbsent = 0;
  for (const v of absentRaw.values()) totalAbsent += v;
  if (totalAbsent <= 0) {
    return { shares: allocateMinutes(remainingRaw, budget), ghostMinutes: 0 };
  }

  let totalRemaining = 0;
  for (const v of remainingRaw.values()) totalRemaining += v;
  const totalAll = totalRemaining + totalAbsent;

  if (totalAll <= 0) {
    const shares = new Map<number, number>();
    for (const a of remainingRaw.keys()) shares.set(a, 0);
    return { shares, ghostMinutes: budget };
  }
  if (totalRemaining <= 0) {
    const shares = new Map<number, number>();
    for (const a of remainingRaw.keys()) shares.set(a, 0);
    return { shares, ghostMinutes: (budget * totalAbsent) / totalAll };
  }

  const ghostMinutes = (phi * budget * totalAbsent) / totalAll;
  const absorbedFactor = ((1 - phi) * budget * totalAbsent) / totalAll;
  const shares = new Map<number, number>();
  for (const [a, raw] of remainingRaw) {
    shares.set(a, (budget * raw) / totalAll + absorbedFactor * (raw / totalRemaining));
  }
  return { shares, ghostMinutes };
}

// ── The Depth Chart (hub-v2, `depth_chart_minutes`) ──────────────────────

/**
 * numpy.interp for one scalar against ASCENDING `xp` — piecewise linear, held
 * flat outside the range at both ends. Faithful to numpy's own
 * `compiled_interp` down to its NaN fallback, because that is what fires when
 * two calibration points share an x value (a zero-width segment gives an
 * infinite slope), and a port that quietly returned NaN there would disagree
 * with hoops-sim on exactly the roster where it mattered.
 *
 * 🔴 KNOWN NON-PORTABLE EDGE, recorded rather than papered over: the CALLER
 * (`depthChartRankKey`) builds `xp` by sorting teammates on value, and
 * hoops-sim builds the same list by sorting a Python SET, whose iteration
 * order for equal values is hash-derived and not reproducible here. So two
 * history-having teammates with EXACTLY equal value_per36 can order
 * differently on the two sides. Distinct values — every real roster, and every
 * fixture case — are fully deterministic and byte-for-byte matched.
 */
export function interpolate(x: number, xp: number[], fp: number[]): number {
  const n = xp.length;
  if (n === 0) return NaN;
  if (n === 1) return fp[0];
  if (x < xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  // Largest j with xp[j] <= x, clamped so j+1 is always in range — numpy's own
  // binary_search_with_guess contract.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid;
  }
  const slope = (fp[lo + 1] - fp[lo]) / (xp[lo + 1] - xp[lo]);
  let res = slope * (x - xp[lo]) + fp[lo];
  if (Number.isNaN(res)) {
    res = slope * (x - xp[lo + 1]) + fp[lo + 1];
    if (Number.isNaN(res) && fp[lo] === fp[lo + 1]) res = fp[lo];
  }
  return res;
}

/**
 * hoops.rosterratings._depth_chart_rank_key — what each man is RANKED by when
 * the rotation curve is applied.
 *
 * A man with a real minutes history on this team keeps his own expected
 * minutes (so his rank is just where he sits in the rotation). A man without
 * one — a trade arrival, a rookie, a fictional add — has no minutes signal to
 * rank by at all: they would all share bench_default_minutes, which is not a
 * rank. His key is instead INTERPOLATED from his own value against his
 * history-having teammates' (value, minutes) pairs, so a high-value arrival
 * slots near the top of the rotation.
 *
 * Falls back to the raw minutes unchanged when nobody on the roster has any
 * history to calibrate against (an all-new team) — a soft fallback, never a
 * throw, matching the Python.
 */
export function depthChartRankKey(
  rawMinutes: Map<number, number>,
  hasHistory: Set<number>,
  valueOf: (athleteId: number) => number,
): Map<number, number> {
  const calibration: Array<[number, number]> = [];
  for (const aid of hasHistory) {
    const m = rawMinutes.get(aid);
    if (m !== undefined) calibration.push([valueOf(aid), m]);
  }
  const key = new Map(rawMinutes);
  if (calibration.length === 0) return key;
  calibration.sort((a, b) => a[0] - b[0]);
  const values = calibration.map((t) => t[0]);
  const minutes = calibration.map((t) => t[1]);
  for (const aid of rawMinutes.keys()) {
    if (hasHistory.has(aid)) continue;
    key.set(aid, interpolate(valueOf(aid), values, minutes));
  }
  return key;
}

/**
 * hoops.minutesmodel._depth_chart_blend — mix the fitted rotation curve's value
 * at each man's RANK into his own raw expected minutes at weight `w`. Returns a
 * NOT-yet-renormalised minutes-like map; callers renormalise through the same
 * allocateMinutes / allocateMinutesWithAbsorption as before, so the
 * sum-to-budget identity stays ONE implementation. `w = 0` reproduces the input
 * exactly.
 *
 * 🔴 THE RETURNED MAP IS IN RANK ORDER, not the input's order, because the
 * Python builds its dict that way and the renormalisation that follows sums
 * floats in iteration order. Same numbers, different order, different last
 * bits — and the fixture's 1e-6 tolerance would not always catch it. Do not
 * "tidy" this into the input order.
 */
export function depthChartBlend(
  raw: Map<number, number>,
  rankKey: Map<number, number> | null,
  w: number,
  curve: Record<string, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  if (raw.size === 0) return out;
  const key = rankKey && rankKey.size > 0 ? rankKey : raw;
  const keyOf = (a: number): number => key.get(a) ?? (raw.get(a) as number);
  // Descending by rank key. Array.prototype.sort is stable (ES2019+) and Map
  // preserves insertion order, so ties fall back to the input order exactly as
  // Python's stable `sorted` over `raw.keys()` does.
  const order = [...raw.keys()].sort((a, b) => keyOf(b) - keyOf(a));
  const ranks = Object.keys(curve).map(Number);
  const maxRank = Math.max(...ranks);
  const deepBench = curve[String(maxRank)];
  order.forEach((aid, i) => {
    const rank = i + 1;
    const c = curve[String(Math.min(rank, maxRank))] ?? deepBench;
    out.set(aid, Math.max(0, w * c + (1 - w) * (raw.get(aid) as number)));
  });
  return out;
}

/** hoops.minutesmodel.allocate_minutes_depth_chart. */
export function allocateMinutesDepthChart(
  raw: Map<number, number>,
  rankKey: Map<number, number> | null,
  budget: number,
  w: number,
  curve: Record<string, number>,
): Map<number, number> {
  return allocateMinutes(depthChartBlend(raw, rankKey, w, curve), budget);
}

/**
 * hoops.minutesmodel.allocate_minutes_with_absorption_depth_chart — the curve
 * is blended into the REMAINING men only, and the untouched absorption formula
 * then runs on that. 🔴 The order matters: blending after absorbing gives a
 * different answer, because absorption redistributes proportionally to the
 * vector it is handed.
 */
export function allocateMinutesWithAbsorptionDepthChart(
  remainingRaw: Map<number, number>,
  absentRaw: Map<number, number>,
  rankKey: Map<number, number> | null,
  budget: number,
  w: number,
  curve: Record<string, number>,
  phi: number,
): AllocationResult {
  return allocateMinutesWithAbsorption(
    depthChartBlend(remainingRaw, rankKey, w, curve),
    absentRaw,
    budget,
    phi,
  );
}

/**
 * hoops.availability._side_value — minutes-share-weighted value_per36 sum,
 * scaled by `budget/36`. Defensively renormalizes `shares` to `athleteIds`'
 * own total rather than assuming it's already `budget` (matching the Python
 * original, which does the same even though every allocator above already
 * guarantees it by construction).
 */
export function sideValue(
  athleteIds: number[],
  shares: Map<number, number>,
  valueOf: (athleteId: number) => number,
  budget: number,
): number {
  let total = 0;
  for (const a of athleteIds) total += shares.get(a) ?? 0;
  if (total <= 0) return 0;
  let acc = 0;
  for (const a of athleteIds) {
    const s = shares.get(a);
    if (s === undefined) continue;
    acc += (s / total) * valueOf(a);
  }
  return (budget / 36) * acc;
}

export interface RawStrengthResult {
  rawStrength: number;
  /** hub-v2, `split_off_def`: the same minutes-weighted sum over each man's
   *  offence-minus-defence lean. 0 when the split is off. */
  rawTilt: number;
  ghostMinutes: number;
  shares: Map<number, number>;
}

/** Which of the hub-v2 pricing paths to take. Resolved from the bundle's
 *  declared features by `contract.pricingModeOf`; omitted entirely is v1, and
 *  every v1 result is bit-identical to before hub-v2 existed. */
export interface PricingOptions {
  split?: boolean;
  depthChart?: boolean;
}

/**
 * hoops.rosterratings.raw_team_strength, minus the DB/roster-frame plumbing —
 * callers already have each player's raw minutes + value resolved.
 * `absentRaw` (optional): players NOT in `players` at all (removed by an
 * edit, or declared out) whose absence should still be priced via the
 * absorption mechanic rather than silently vanishing. Empty/omitted is
 * bit-identical to a plain `allocateMinutes` call.
 *
 * 🔴 `rawStrength` (the NET) is computed by the untouched pre-hub-v2 lines and
 * is NEVER derived from the two sides — the same structural guarantee
 * hoops-sim gives, and what makes it impossible for `split` to move a margin
 * or a win probability.
 */
export function rawTeamStrength(
  players: PricingPlayer[],
  constants: PricingConstants,
  absentRaw?: Map<number, number>,
  options?: PricingOptions,
): RawStrengthResult {
  const budget = constants.total_team_minutes;
  const split = options?.split === true;
  const depthChart = options?.depthChart === true;
  const raw = new Map<number, number>();
  const values = new Map<number, number>();
  const tilts = new Map<number, number>();
  const hasHistory = new Set<number>();
  for (const p of players) {
    raw.set(p.athlete_id, p.raw_minutes ?? constants.bench_default_minutes);
    if (p.value_per36 != null) values.set(p.athlete_id, p.value_per36);
    if (p.value_off_per36 != null && p.value_def_per36 != null) {
      tilts.set(p.athlete_id, p.value_off_per36 - p.value_def_per36);
    }
    if (p.has_history ?? p.raw_minutes != null) hasHistory.add(p.athlete_id);
  }

  const valueOf = (id: number): number => values.get(id) ?? constants.replacement_per36;

  let rankKey: Map<number, number> | null = null;
  let w = 0;
  let curve: Record<string, number> = {};
  if (depthChart) {
    w = constants.depth_chart_w as number;
    curve = constants.depth_chart_curve as Record<string, number>;
    if (typeof w !== "number" || !curve || Object.keys(curve).length === 0) {
      throw new Error(
        "pricing: depth_chart_minutes is in force but depth_chart_w / depth_chart_curve are " +
          "missing from the wire constants — contract.checkFeatureConstants should have rejected " +
          "this bundle before it got here",
      );
    }
    rankKey = depthChartRankKey(raw, hasHistory, valueOf);
  }

  let shares: Map<number, number>;
  let ghostMinutes = 0;
  if (absentRaw && absentRaw.size > 0) {
    const result = depthChart
      ? allocateMinutesWithAbsorptionDepthChart(
          raw, absentRaw, rankKey, budget, w, curve, constants.absorption_phi,
        )
      : allocateMinutesWithAbsorption(raw, absentRaw, budget, constants.absorption_phi);
    shares = result.shares;
    ghostMinutes = result.ghostMinutes;
  } else {
    shares = depthChart
      ? allocateMinutesDepthChart(raw, rankKey, budget, w, curve)
      : allocateMinutes(raw, budget);
  }

  const participantIds = players.map((p) => p.athlete_id);
  if (ghostMinutes > 0) {
    shares.set(constants.ghost_athlete_id, ghostMinutes);
    participantIds.push(constants.ghost_athlete_id);
    values.set(constants.ghost_athlete_id, constants.replacement_per36);
    // The ghost is a replacement-level man in every respect, including his
    // lean: he falls through to replacement_tilt_per36 the same way he falls
    // through to replacement_per36, so no special case is needed here.
  }

  const rawStrength = sideValue(participantIds, shares, valueOf, budget);
  // THE SPLIT: the SAME participants, the SAME shares, the SAME formula —
  // only the per-player quantity changes (net -> offence-minus-defence). Not
  // called at all when the split is off, which is what keeps a v1 bundle's
  // arithmetic bit-identical.
  const replacementTilt = constants.replacement_tilt_per36 ?? 0;
  const rawTilt = split
    ? sideValue(participantIds, shares, (id) => tilts.get(id) ?? replacementTilt, budget)
    : 0;

  return { rawStrength, rawTilt, ghostMinutes, shares };
}

export interface NetRatingResult {
  off: number;
  def: number;
  net: number;
  /** `off + def` — how many points this team adds to a game's TOTAL versus an
   *  average one. Structurally 0 under `symmetric_off_def`, which is exactly
   *  the defect `split_off_def` fixes. */
  tilt: number;
  rawStrength: number;
  ghostMinutes: number;
}

/**
 * hoops.rosterratings.split_off_def — the ONE place a team net rating becomes
 * the two numbers the engine reads. `tilt === 0` returns the two pre-hub-v2
 * expressions SPELLED OUT rather than computed, so the symmetric path needs no
 * reasoning about IEEE rounding to be bit-identical to what shipped before.
 */
export function splitOffDef(net: number, tilt: number): { off: number; def: number } {
  if (tilt === 0) return { off: net / 2, def: -net / 2 };
  const halfNet = net / 2;
  const halfTilt = tilt / 2;
  return { off: halfNet + halfTilt, def: halfTilt - halfNet };
}

/**
 * hoops.rosterratings.team_net_rating, given an externally supplied
 * recenter (0 when the caller has none — this receiver is never sent
 * `league_mean_raw`, by design; see the module docstring).
 * `net = rawStrength - leagueRecenter`.
 *
 * `leagueRecenterTilt` is the tilt's twin and is subject to exactly the same
 * discipline: fixed once from the unedited baseline and reused for BOTH arms
 * of a paired comparison, so an edit to one team never moves the other 29.
 */
export function teamNetRating(
  players: PricingPlayer[],
  constants: PricingConstants,
  leagueRecenter: number,
  absentRaw?: Map<number, number>,
  options?: PricingOptions,
  leagueRecenterTilt = 0,
): NetRatingResult {
  const { rawStrength, rawTilt, ghostMinutes } = rawTeamStrength(
    players, constants, absentRaw, options,
  );
  const net = rawStrength - leagueRecenter;
  const tilt = options?.split === true ? rawTilt - leagueRecenterTilt : 0;
  return { ...splitOffDef(net, tilt), net, tilt, rawStrength, ghostMinutes };
}
