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
 *  receiver actually understands the new shape — never pre-emptively. */
export const SUPPORTED_WIRE_VERSION = 1;
export const SUPPORTED_PRICING_VERSION = 1;

/** Features (#24 "Features v1"). `split_off_def` is the anticipated v2
 *  feature — deliberately NOT in this set, so a sender that flips it on
 *  before this receiver understands it gets a loud REJECT naming it, not a
 *  silent wrong computation. */
export const SUPPORTED_FEATURES: ReadonlySet<string> = new Set([
  "symmetric_off_def",
  "absorption",
  "fictional_values",
]);

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
