// The receiver's half of the hoops-sim -> keith-hub wire contract.
//
// Interface spec: kad-air/hoops-sim#24 (authoritative — implement against
// that document, not against kad-air/keith-hub#73's prose where they
// differ). The sender (kad-air/hoops-sim#23) implements the same document
// independently; neither side redefines it unilaterally.
//
// The compatibility rules are ASYMMETRIC on purpose (#24's own framing): the
// sender may add features/constants freely, the receiver must understand
// everything it's handed a decision about.
//
//   1. unknown `feature`            -> REJECT, naming it
//   2. unknown `constant`           -> IGNORE (never rejected, never required)
//   3. missing REQUIRED `constant`  -> REJECT, naming it (never defaulted)
//   4. `pricing_version` too high   -> REJECT (lower is fine)
//   5. `generated_at` older than stored -> REJECT (stale replay)
//   6. `content_hash` unchanged     -> NO-OP (handled by the route, not here)

import crypto from "crypto";

/** This receiver's own wire/pricing versions. Bump only after confirming the
 *  receiver actually understands the new shape — never pre-emptively.
 *
 *  🔴 PRICING_VERSION 2 (hub-v2): lib/hoops/pricing.ts gained two things that
 *  change the arithmetic, which is exactly what this field is for — a per-SIDE
 *  path (a player's offence lands on his new team's offence and his defence on
 *  its defence, instead of half his net landing on each) and the Depth Chart
 *  minutes allocator (a real rotation is top-heavy; plain proportional shares
 *  are not). Rule 4 is one-directional: a bundle at pricing_version 1 still
 *  imports and is still priced by the v1 formula, unchanged. */
export const SUPPORTED_WIRE_VERSION = 1;
export const SUPPORTED_PRICING_VERSION = 3;

/**
 * Every feature token this receiver implements. 🔴 The spelling is a
 * CROSS-REPO CONTRACT — hoops-sim's `src/hoops/exporthub.py` declares from the
 * same six literals, and rule 1 makes an unknown token reject the whole
 * publish. This set must therefore be a SUPERSET of whatever the sender can
 * declare, and DEPLOYED FIRST. That ordering is the whole reason these tokens
 * land here before hoops-sim flips its own `FEATURES` to v2.
 *
 *   symmetric_off_def   v1 — price a roster edit as off = net/2, def = -net/2
 *   split_off_def       v2 — price it per side, from value_off/def_per36
 *   depth_chart_minutes v2 — allocate minutes off the fitted rotation curve
 *   nightly_strength    v2 — prefer the last-ten-games team read for pricing
 *   absorption          a departed man's minutes partly go to a replacement
 *   fictional_values    a declared per-36 value is honoured unconverted
 *   goto_scorer         v3 — a team built around one big scorer is worth more
 *                       than its five men summed (hoops-sim issue #73): add
 *                       star_goto_premium x (clamp(leading scorer's share of
 *                       projected points) - star_goto_league_share) to the raw
 *                       strength, the share projected from each man's
 *                       pts_per36 over his allocated minutes
 */
export const SUPPORTED_FEATURES: ReadonlySet<string> = new Set([
  "symmetric_off_def",
  "split_off_def",
  "depth_chart_minutes",
  "nightly_strength",
  "absorption",
  "fictional_values",
  "goto_scorer",
]);

/**
 * Constants a declared feature CANNOT be honoured without.
 *
 * Rule 3 says a required constant that is missing must reject, naming it — but
 * what is "required" depends on what the bundle declares. Demanding
 * `depth_chart_w` of every bundle would reject every v1 bundle that exists
 * today, which rule 2 explicitly forbids. So REQUIRED_CONSTANTS below stays
 * exactly as it was (the v1 floor, demanded of everything), and this table
 * adds to it only for the features actually on the wire.
 */
export const FEATURE_CONSTANTS: Readonly<Record<string, readonly string[]>> = {
  split_off_def: ["replacement_tilt_per36"],
  depth_chart_minutes: ["depth_chart_w", "depth_chart_curve"],
  goto_scorer: ["star_goto_premium", "star_goto_league_share", "star_goto_share_band"],
};

/**
 * Pairs of tokens that contradict each other about the SAME formula. A bundle
 * declaring both `symmetric_off_def` and `split_off_def` is telling this
 * receiver to halve a net and not to halve it; there is no defensible way to
 * pick one, and silently picking is how a wrong number ships looking right.
 */
const MUTUALLY_EXCLUSIVE: ReadonlyArray<readonly [string, string]> = [
  ["symmetric_off_def", "split_off_def"],
];

/** What the declared features mean for the pricing formula, resolved once so no
 *  call site re-derives it from raw string comparisons. */
export interface PricingMode {
  /** Price a roster edit per side, not by halving a net. */
  split: boolean;
  /** Allocate minutes off the fitted rotation curve, not proportionally. */
  depthChart: boolean;
  /** Prefer the last-ten-games team read where the bundle carries one. */
  nightly: boolean;
  /** v3: charge the go-to-scorer term on a roster's raw strength. */
  goto: boolean;
}

export function pricingModeOf(features: readonly string[]): PricingMode {
  return {
    split: features.includes("split_off_def"),
    depthChart: features.includes("depth_chart_minutes"),
    nightly: features.includes("nightly_strength"),
    goto: features.includes("goto_scorer"),
  };
}

/**
 * Constants this receiver's pricing formula actually reads by name
 * (lib/hoops/pricing.ts) — #24's "Constants" table. Nothing else about the
 * formula is hardcoded: every one of these is read off the payload, never a
 * literal in this codebase. `league_mean_raw` is deliberately absent from
 * this list — #24 says the sender must never send it (kad-air/keith-hub#66),
 * and requiring it here would be asking for the one computation that issue
 * exists to make impossible.
 */
export const REQUIRED_CONSTANTS: readonly string[] = [
  "total_team_minutes",
  "bench_default_minutes",
  "absorption_phi",
  "ghost_athlete_id",
  "replacement_per36",
];

/**
 * 🔴 The ONE named place the no-contract fallback lives (#73's brief,
 * verbatim). A bundle with no `contract` block at all — the sender may land
 * after this receiver — is treated as exactly this, nothing else. Do not
 * inline this elsewhere.
 */
export const NO_CONTRACT_FALLBACK = {
  wireVersion: SUPPORTED_WIRE_VERSION,
  pricingVersion: 1,
  features: ["symmetric_off_def", "absorption"] as string[],
};

export class ContractRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractRejection";
  }
}

export interface EffectiveContract {
  wireVersion: number;
  pricingVersion: number;
  features: string[];
  valueModel: string | null;
  valueAsOf: string | null;
  generatedAt: string;
  /** null when the sender didn't supply one — the route computes its own. */
  contentHash: string | null;
  /** true when body.contract was entirely absent and the fallback was used. */
  usedFallback: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolve the envelope's `contract` block into a typed, defaulted shape.
 * `fallbackGeneratedAt` is used only when the block is absent (or absent its
 * own `generated_at`) — normally `files["hoops_params.json"].generated_at`,
 * which every export has always carried, contract block or not.
 */
export function resolveContract(raw: unknown, fallbackGeneratedAt: string): EffectiveContract {
  if (raw === undefined || raw === null) {
    return {
      wireVersion: NO_CONTRACT_FALLBACK.wireVersion,
      pricingVersion: NO_CONTRACT_FALLBACK.pricingVersion,
      features: [...NO_CONTRACT_FALLBACK.features],
      valueModel: null,
      valueAsOf: null,
      generatedAt: fallbackGeneratedAt,
      contentHash: null,
      usedFallback: true,
    };
  }
  if (!isPlainObject(raw)) {
    throw new ContractRejection("contract: expected an object");
  }
  const features = Array.isArray(raw.features) ? raw.features.map(String) : [];
  const generatedAt = typeof raw.generated_at === "string" ? raw.generated_at : fallbackGeneratedAt;
  const pricingVersion =
    typeof raw.pricing_version === "number" ? raw.pricing_version : NO_CONTRACT_FALLBACK.pricingVersion;
  const wireVersion =
    typeof raw.wire_version === "number" ? raw.wire_version : NO_CONTRACT_FALLBACK.wireVersion;
  const contentHash = typeof raw.content_hash === "string" ? raw.content_hash : null;
  return {
    wireVersion,
    pricingVersion,
    features,
    valueModel: typeof raw.value_model === "string" ? raw.value_model : null,
    valueAsOf: typeof raw.value_as_of === "string" ? raw.value_as_of : null,
    generatedAt,
    contentHash,
    usedFallback: false,
  };
}

/** Rule 1: unknown feature -> REJECT, naming it. */
export function checkFeatures(features: string[]): void {
  for (const f of features) {
    if (!SUPPORTED_FEATURES.has(f)) {
      throw new ContractRejection(
        `unsupported feature "${f}" — this receiver does not implement it. ` +
          `Supported: ${[...SUPPORTED_FEATURES].join(", ")}.`,
      );
    }
  }
}

/**
 * Rule 1, second half: two declared tokens that contradict each other about
 * the same formula -> REJECT, naming both. Not in #24's original text because
 * v1 had only one formula to describe; added with hub-v2, where there are two
 * and exactly one of them must be in force.
 */
export function checkFeatureCoherence(features: string[]): void {
  const set = new Set(features);
  for (const [a, b] of MUTUALLY_EXCLUSIVE) {
    if (set.has(a) && set.has(b)) {
      throw new ContractRejection(
        `features "${a}" and "${b}" contradict each other — they describe the same pricing ` +
          `formula two different ways. Declare exactly one.`,
      );
    }
  }
}

/**
 * Rule 3, feature-scoped: a constant that a DECLARED feature cannot be
 * honoured without -> REJECT, naming both the constant and the feature that
 * demanded it. A bundle that does not declare the feature is untouched, which
 * is what keeps a v1 bundle importable forever.
 */
export function checkFeatureConstants(
  features: string[],
  constants: Record<string, unknown> | null | undefined,
): void {
  for (const feature of features) {
    for (const name of FEATURE_CONSTANTS[feature] ?? []) {
      const v = constants ? constants[name] : undefined;
      if (v === undefined || v === null) {
        throw new ContractRejection(
          `feature "${feature}" is declared but required constant "${name}" is missing`,
        );
      }
    }
  }
}

/** Rule 4: pricing_version higher than supported -> REJECT. Lower is fine. */
export function checkPricingVersion(pricingVersion: number): void {
  if (pricingVersion > SUPPORTED_PRICING_VERSION) {
    throw new ContractRejection(
      `pricing_version ${pricingVersion} is newer than this receiver understands ` +
        `(supports up to ${SUPPORTED_PRICING_VERSION}). Deploy a receiver update first.`,
    );
  }
}

/**
 * Rule 3: a constant the receiver NEEDS but is missing -> REJECT, naming it.
 * Rule 2 (unknown constant -> ignore) needs no code: anything not in
 * REQUIRED_CONSTANTS is simply never looked at here.
 */
export function checkRequiredConstants(constants: Record<string, unknown> | null | undefined): void {
  for (const name of REQUIRED_CONSTANTS) {
    const v = constants ? constants[name] : undefined;
    if (v === undefined || v === null) {
      throw new ContractRejection(`missing required constant "${name}"`);
    }
  }
}

/** Deterministic key ordering so the same logical payload always hashes the
 *  same way regardless of property insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * Fallback content-hash computation, used only when the sender's `contract`
 * block didn't supply one (rule 6 needs SOME idempotency key regardless of
 * whether the sender has caught up to #24 yet). Over the canonicalized
 * `{constants, files}` payload — the same scope #24 describes ("excluding
 * [content_hash] itself", which is trivially true here since it's not part
 * of this input at all).
 */
export function computeContentHash(payload: { constants: unknown; files: unknown }): string {
  const json = JSON.stringify(canonicalize(payload));
  return `sha256:${crypto.createHash("sha256").update(json).digest("hex")}`;
}
