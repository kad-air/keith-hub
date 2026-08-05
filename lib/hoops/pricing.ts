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

export interface PricingConstants {
  total_team_minutes: number;
  bench_default_minutes: number;
  absorption_phi: number;
  ghost_athlete_id: number;
  replacement_per36: number;
}

export interface PricingPlayer {
  athlete_id: number;
  /** Raw expected minutes (season-typical / trailing average), BEFORE
   *  allocation. null/undefined -> falls back to bench_default_minutes,
   *  exactly like a no-history player on the hoops-sim side. */
  raw_minutes: number | null | undefined;
  /** Net value production per 36 minutes. null/undefined -> replacement_per36. */
  value_per36: number | null | undefined;
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
  ghostMinutes: number;
  shares: Map<number, number>;
}

/**
 * hoops.rosterratings.raw_team_strength, minus the DB/roster-frame plumbing —
 * callers already have each player's raw minutes + value resolved.
 * `absentRaw` (optional): players NOT in `players` at all (removed by an
 * edit, or declared out) whose absence should still be priced via the
 * absorption mechanic rather than silently vanishing. Empty/omitted is
 * bit-identical to a plain `allocateMinutes` call.
 */
export function rawTeamStrength(
  players: PricingPlayer[],
  constants: PricingConstants,
  absentRaw?: Map<number, number>,
): RawStrengthResult {
  const budget = constants.total_team_minutes;
  const raw = new Map<number, number>();
  const values = new Map<number, number>();
  for (const p of players) {
    raw.set(p.athlete_id, p.raw_minutes ?? constants.bench_default_minutes);
    if (p.value_per36 != null) values.set(p.athlete_id, p.value_per36);
  }

  let shares: Map<number, number>;
  let ghostMinutes = 0;
  if (absentRaw && absentRaw.size > 0) {
    const result = allocateMinutesWithAbsorption(raw, absentRaw, budget, constants.absorption_phi);
    shares = result.shares;
    ghostMinutes = result.ghostMinutes;
  } else {
    shares = allocateMinutes(raw, budget);
  }

  const participantIds = players.map((p) => p.athlete_id);
  if (ghostMinutes > 0) {
    shares.set(constants.ghost_athlete_id, ghostMinutes);
    participantIds.push(constants.ghost_athlete_id);
    values.set(constants.ghost_athlete_id, constants.replacement_per36);
  }

  const rawStrength = sideValue(
    participantIds,
    shares,
    (id) => values.get(id) ?? constants.replacement_per36,
    budget,
  );

  return { rawStrength, ghostMinutes, shares };
}

export interface NetRatingResult {
  off: number;
  def: number;
  net: number;
  rawStrength: number;
  ghostMinutes: number;
}

/**
 * hoops.rosterratings.team_net_rating, given an externally supplied
 * recenter (0 when the caller has none — this receiver is never sent
 * `league_mean_raw`, by design; see the module docstring).
 * `net = rawStrength - leagueRecenter`.
 */
export function teamNetRating(
  players: PricingPlayer[],
  constants: PricingConstants,
  leagueRecenter: number,
  absentRaw?: Map<number, number>,
): NetRatingResult {
  const { rawStrength, ghostMinutes } = rawTeamStrength(players, constants, absentRaw);
  const net = rawStrength - leagueRecenter;
  return { off: net / 2, def: -net / 2, net, rawStrength, ghostMinutes };
}
