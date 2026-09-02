#!/usr/bin/env node
//
// The wire-contract negotiation gate (kad-air/hoops-sim#24, hub-v2).
//
//   npm run check:hoops:contract   (standalone)
//   npm run build                  (runs via prebuild)
//
// WHAT THIS PROVES. The import endpoint is the one place a bad bundle can
// replace the entire hoops read model. Its defence is lib/hoops/contract.ts,
// and the failure mode that matters is not a crash — it is a bundle that gets
// ACCEPTED and then priced by a formula it was not built for. Nobody would see
// that on screen: every number would still look like a plausible NBA number.
//
// 🔴 THE FIRST DUTY IS BACKWARD COMPATIBILITY. hoops-sim has been publishing
// the v1 contract since 2026-08-05 and — by the deploy order this whole design
// rests on — will go on publishing it until a human flips the sender, some time
// AFTER this receiver is live. So the very first case below is the literal v1
// contract block, and it must sail straight through. A receiver that learns a
// new formula and forgets the old one takes the site down on its own deploy.
//
// Every case drives the REAL exported functions, never a restatement of them.

import {
  ContractRejection,
  FEATURE_CONSTANTS,
  NO_CONTRACT_FALLBACK,
  SUPPORTED_FEATURES,
  SUPPORTED_PRICING_VERSION,
  checkFeatureCoherence,
  checkFeatureConstants,
  checkFeatures,
  checkPricingVersion,
  checkRequiredConstants,
  pricingModeOf,
  resolveContract,
} from "../lib/hoops/contract.ts";

const problems: string[] = [];
const notes: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) problems.push(msg);
};

/** The v1 constants block, exactly as hoops-sim has been sending it. */
const V1_CONSTANTS: Record<string, unknown> = {
  total_team_minutes: 240.0,
  bench_default_minutes: 12.0,
  absorption_phi: 0.146,
  absorption_rotation_floor_minutes: 12.0,
  ghost_athlete_id: -1,
  blend_weight: 0.81,
  playoff_alpha: 1.45,
  replacement_percentile: 0.1,
  replacement_per36: -0.675,
};

/** The v2 constants block: v1 plus what the two new formulas need. */
const V2_CONSTANTS: Record<string, unknown> = {
  ...V1_CONSTANTS,
  replacement_tilt_per36: 0.8925,
  depth_chart_w: 0.4,
  depth_chart_max_rank: 15,
  depth_chart_curve: { "1": 34.257, "15": 5.559 },
};

const V1_FEATURES = ["symmetric_off_def", "absorption", "fictional_values"];
const V2_FEATURES = [
  "split_off_def",
  "depth_chart_minutes",
  "nightly_strength",
  "absorption",
  "fictional_values",
];

/** Run the full negotiation the import route runs, in the same order. */
function negotiate(
  features: string[],
  pricingVersion: number,
  constants: Record<string, unknown>,
): string | null {
  try {
    checkFeatures(features);
    checkFeatureCoherence(features);
    checkPricingVersion(pricingVersion);
    checkRequiredConstants(constants);
    checkFeatureConstants(features, constants);
    return null;
  } catch (err) {
    if (err instanceof ContractRejection) return err.message;
    throw err;
  }
}

// ── 1. backward compatibility: the v1 bundle still imports ────────────────
{
  const rejected = negotiate(V1_FEATURES, 1, V1_CONSTANTS);
  check(
    rejected === null,
    `the v1 contract block was REJECTED — "${rejected}". hoops-sim is still sending exactly ` +
      `this, and will be until a human flips it after this receiver deploys.`,
  );
  const mode = pricingModeOf(V1_FEATURES);
  check(
    !mode.split && !mode.depthChart && !mode.nightly,
    `a v1 bundle resolved to pricing mode ${JSON.stringify(mode)} — it must take none of the ` +
      `v2 paths, or an old bundle is silently re-priced by a formula it was not built for`,
  );
  notes.push("backward compatibility: the live v1 contract block imports and prices as v1");
}

// ── 2. no contract block at all ───────────────────────────────────────────
{
  const resolved = resolveContract(undefined, "2026-08-01T00:00:00Z");
  check(resolved.usedFallback, "a missing contract block did not use NO_CONTRACT_FALLBACK");
  check(
    negotiate(resolved.features, resolved.pricingVersion, V1_CONSTANTS) === null,
    "the no-contract fallback does not pass its own negotiation",
  );
  const mode = pricingModeOf(resolved.features);
  check(
    !mode.split && !mode.depthChart && !mode.nightly,
    "the no-contract fallback must resolve to v1 pricing, never a v2 path",
  );
  check(
    NO_CONTRACT_FALLBACK.pricingVersion === 1,
    `NO_CONTRACT_FALLBACK.pricingVersion is ${NO_CONTRACT_FALLBACK.pricingVersion}; a bundle ` +
      `too old to carry a contract block cannot be assumed to use the newest formula`,
  );
  notes.push("no-contract fallback: still v1, still passes its own negotiation");
}

// ── 3. the v2 bundle imports ──────────────────────────────────────────────
{
  const rejected = negotiate(V2_FEATURES, 2, V2_CONSTANTS);
  check(rejected === null, `the v2 contract block was REJECTED — "${rejected}"`);
  const mode = pricingModeOf(V2_FEATURES);
  check(
    mode.split && mode.depthChart && mode.nightly,
    `a v2 bundle resolved to ${JSON.stringify(mode)} — all three paths must switch on`,
  );
  notes.push("v2: the Split, the Depth Chart and nightly strength all negotiate through");
}

// ── 4. an unknown token still refuses, naming it ──────────────────────────
{
  const rejected = negotiate([...V1_FEATURES, "shot_diet"], 1, V1_CONSTANTS);
  check(
    rejected !== null && rejected.includes("shot_diet"),
    `an unknown feature token was accepted (or rejected without naming it): ${rejected}`,
  );
  notes.push("rule 1: an unknown token refuses the publish and names itself");
}

// ── 5. contradictory tokens refuse ────────────────────────────────────────
{
  const rejected = negotiate(
    ["symmetric_off_def", "split_off_def", "absorption"],
    2,
    V2_CONSTANTS,
  );
  check(
    rejected !== null && rejected.includes("split_off_def"),
    `a bundle declaring BOTH symmetric_off_def and split_off_def was accepted: ${rejected}. ` +
      `They tell this receiver to halve a net and not to halve it; picking one silently is how ` +
      `a wrong number ships looking right.`,
  );
  notes.push("rule 1b: symmetric and split cannot both be declared");
}

// ── 6. pricing_version is one-directional ─────────────────────────────────
{
  check(
    negotiate(V1_FEATURES, SUPPORTED_PRICING_VERSION + 1, V1_CONSTANTS) !== null,
    "a pricing_version NEWER than this receiver understands was accepted",
  );
  check(
    negotiate(V1_FEATURES, 1, V1_CONSTANTS) === null,
    "a pricing_version OLDER than this receiver's was rejected — lower must always be fine",
  );
  notes.push(
    `rule 4: pricing_version <= ${SUPPORTED_PRICING_VERSION} accepted, ` +
      `${SUPPORTED_PRICING_VERSION + 1} refused`,
  );
}

// ── 7. a declared feature without its constants refuses, naming both ──────
{
  for (const [feature, needed] of Object.entries(FEATURE_CONSTANTS)) {
    for (const name of needed) {
      const stripped = { ...V2_CONSTANTS };
      delete stripped[name];
      const rejected = negotiate([feature, "absorption"], 2, stripped);
      check(
        rejected !== null && rejected.includes(name) && rejected.includes(feature),
        `feature "${feature}" was accepted without its required constant "${name}" ` +
          `(or the message named neither): ${rejected}`,
      );
    }
    // …and the SAME missing constant must NOT reject a bundle that does not
    // declare the feature. This is rule 2, and it is what keeps every v1
    // bundle importable forever.
    const rejected = negotiate(V1_FEATURES, 1, V1_CONSTANTS);
    check(
      rejected === null,
      `a v1 bundle was rejected for a constant only "${feature}" needs: ${rejected}`,
    );
  }
  notes.push(
    "rule 3, feature-scoped: a declared feature's constants are demanded; an undeclared one's " +
      "are not (so a v1 bundle never trips over them)",
  );
}

// ── 8. the sender's whole vocabulary is implemented here ──────────────────
{
  // 🔴 This list is hoops-sim's `exporthub.FEATURES_V1 + FEATURES_V2` — the
  // complete set of tokens the sender is CAPABLE of declaring. The deploy
  // order is receiver-first precisely so this can never be false: if a token
  // the sender can send is missing here, the publish that sends it takes the
  // live site's data with it.
  const SENDER_VOCABULARY = [
    "symmetric_off_def",
    "split_off_def",
    "depth_chart_minutes",
    "nightly_strength",
    "absorption",
    "fictional_values",
  ];
  for (const token of SENDER_VOCABULARY) {
    check(
      SUPPORTED_FEATURES.has(token),
      `hoops-sim can declare "${token}" and this receiver does not implement it — that publish ` +
        `would be refused outright`,
    );
  }
  notes.push(`vocabulary: all ${SENDER_VOCABULARY.length} sender tokens implemented here`);
}

for (const n of notes) console.log(`  · ${n}`);

if (problems.length > 0) {
  console.error(`\nHOOPS CONTRACT CHECK FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}

console.log("hoops wire-contract check: PASS");
