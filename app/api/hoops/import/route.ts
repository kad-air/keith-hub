// POST /api/hoops/import — the Mac Mini pushes a fresh hoops-sim export here.
//
// kad-air/keith-hub#73, implemented against the wire contract in
// kad-air/hoops-sim#24 (the interface spec both repos build against — read
// that document for the envelope shape and the compatibility rules; this
// file is the receiver half of it).
//
// 🔴 FAIL CLOSED. middleware.ts's FEED_PASSWORD gate deliberately fails OPEN
// when unset (local dev without a password is fine — nobody but the owner
// can reach it). This route is the opposite ON PURPOSE: it rewrites the
// ENTIRE hoops read model from an untrusted POST body, so a missing
// HOOPS_IMPORT_TOKEN in production must mean "refuse every request," never
// "accept them." Do not "fix" this to match middleware.ts's convention — see
// the auth design comment on #73 for why they're deliberately different.
// This route is also exempted from middleware.ts's matcher (alongside
// api/auth) and does its own auth entirely, so this check is the ONLY line
// of defence — if it's ever dropped or short-circuited, the endpoint is open
// on the public internet.

import crypto from "crypto";
import zlib from "zlib";
import { NextRequest, NextResponse } from "next/server";
import { BUNDLE_FILES } from "@/lib/hoops/data";
import {
  ContractRejection,
  checkFeatures,
  checkPricingVersion,
  checkRequiredConstants,
  computeContentHash,
  resolveContract,
} from "@/lib/hoops/contract";
import { importPushedBundle } from "@/lib/hoops/import";
import { decodeParams, StaleBlobError } from "@/lib/hoops/params";
import { BundleRejection, validatePushedBundle } from "@/lib/hoops/bundleValidation";
import { getDb } from "@/lib/db";
import type {
  HoopsBundle,
  RawLinesFile,
  RawParamsFile,
  RawPlayersFile,
  RawResultsFile,
  RawScheduleFile,
  RawTeamsFile,
} from "@/lib/hoops/types";

export const dynamic = "force-dynamic";

function extractBearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Timing-safe bearer check. Length check FIRST — `crypto.timingSafeEqual`
 * throws on mismatched-length buffers, and throwing on a wrong-length token
 * would itself be a (crude) timing/behavioural signal. `expected` unset
 * always fails — see the FAIL CLOSED note at the top of this file.
 */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.HOOPS_IMPORT_TOKEN;
  if (!expected) return false;
  const provided = extractBearerToken(req);
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 🔴 The sender gzips the bundle and sets `Content-Encoding: gzip` (hoops-sim's
  // `hoops.exporthub`, ~1.2 MB raw -> ~145 KB on the wire). `req.json()` does NOT
  // transparently inflate a gzipped REQUEST body — fetch decompresses *response*
  // bodies, not request bodies — so reading it directly fails with "invalid JSON
  // body" on every real publish. Found on the first live publish after both halves
  // shipped; the wire contract (kad-air/hoops-sim#24) said "gzip" without saying
  // how, and each side picked a different half of the answer.
  //
  // Read raw bytes and inflate when the header says to. An UNCOMPRESSED body still
  // works, so a hand-rolled `curl -d @bundle.json` for debugging is unaffected.
  let body: unknown;
  try {
    const raw = Buffer.from(await req.arrayBuffer());
    const encoding = (req.headers.get("content-encoding") ?? "").toLowerCase();
    const text = encoding.includes("gzip")
      ? zlib.gunzipSync(raw).toString("utf8")
      : raw.toString("utf8");
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!isPlainObject(body) || !isPlainObject(body.files)) {
    return NextResponse.json({ error: "bundle missing `files`" }, { status: 400 });
  }
  const files = body.files;

  const missingFiles = BUNDLE_FILES.filter((f) => !(f in files));
  if (missingFiles.length > 0) {
    return NextResponse.json(
      { error: `bundle missing file(s): ${missingFiles.join(", ")}` },
      { status: 400 },
    );
  }

  const bundle: HoopsBundle = {
    params: files["hoops_params.json"] as RawParamsFile,
    teams: files["hoops_teams.json"] as RawTeamsFile,
    players: files["hoops_players.json"] as RawPlayersFile,
    schedule: files["hoops_schedule.json"] as RawScheduleFile,
    results: files["hoops_results.json"] as RawResultsFile,
    lines: files["hoops_lines.json"] as RawLinesFile,
  };

  if (!isPlainObject(bundle.params) || !isPlainObject(bundle.params.parameter_set)) {
    return NextResponse.json({ error: "hoops_params.json: missing parameter_set" }, { status: 400 });
  }

  // The fallback generated_at when there's no `contract` block at all, or the
  // block doesn't carry its own — hoops_params.json's own generated_at, which
  // every export has always had.
  const fallbackGeneratedAt =
    typeof bundle.params.generated_at === "string" ? bundle.params.generated_at : new Date().toISOString();

  // 🔴 Transitional tolerance, NOT part of #24 itself: if the envelope has no
  // top-level `constants` block yet (an early sender that hasn't promoted its
  // per-file hoops_params.json.constants to the envelope level), fall back to
  // that nested object, merging in `replacement_per36` from hoops_players.json
  // since that's where it lives today (players.json's own top-level field,
  // not inside constants) but #24's contract table names it as a required
  // wire-level constant. Once the sender ships a real top-level `constants`
  // block this merge is inert — body.constants wins outright.
  const nestedConstants = (bundle.params.constants ?? {}) as unknown as Record<string, unknown>;
  const constants: Record<string, unknown> = isPlainObject(body.constants)
    ? { ...body.constants }
    : { ...nestedConstants };
  if (constants.replacement_per36 == null && typeof bundle.players?.replacement_per36 === "number") {
    constants.replacement_per36 = bundle.players.replacement_per36;
  }

  let contract;
  try {
    contract = resolveContract(body.contract, fallbackGeneratedAt);
    checkFeatures(contract.features);
    checkPricingVersion(contract.pricingVersion);
    checkRequiredConstants(constants);
  } catch (err) {
    if (err instanceof ContractRejection) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // content_hash: the sender's own if it supplied one, else computed here —
  // either way this is the idempotency key rule 6 (unchanged -> no-op) reads.
  const contentHash = contract.contentHash ?? computeContentHash({ constants, files });

  const db = getDb();
  const existing = db
    .prepare(`SELECT content_hash, generated_at FROM hoops_params WHERE id = 1`)
    .get() as { content_hash: string; generated_at: string } | undefined;

  // Rule 6's no-op has ONE exception, mirroring lib/hoops/import.ts's seed-path
  // `splitSettled` guard (added with /hoops/players): if the stored read model
  // predates the off/def split columns (every value NULL) but this bundle
  // carries them, an unchanged content hash must NOT freeze the columns NULL
  // forever -- fall through to the real write exactly once. Found live
  // 2026-08-21: the guard existed only on the seed path, and the push route's
  // rule-6 short-circuit ran first, so a same-hash re-POST could never
  // populate the split.
  const storedSplit = (
    db.prepare(`SELECT COUNT(*) AS n FROM hoops_players WHERE value_off_per36 IS NOT NULL`).get() as { n: number }
  ).n;
  const bundleCarriesSplit = (
    (files["hoops_players.json"] as RawPlayersFile | undefined)?.players ?? []
  ).some((p) => p.value_off_per36 != null);
  const splitSettled = !bundleCarriesSplit || storedSplit > 0;

  if (existing && existing.content_hash === contentHash && splitSettled) {
    return NextResponse.json({
      imported: false,
      reason: "unchanged",
      contentHash,
      generatedAt: existing.generated_at,
    });
  }

  if (existing && Date.parse(contract.generatedAt) < Date.parse(existing.generated_at)) {
    return NextResponse.json(
      {
        error:
          `stale replay: generated_at ${contract.generatedAt} is older than the currently ` +
          `stored ${existing.generated_at}`,
      },
      { status: 409 },
    );
  }

  // Structural / stale-blob validation BEFORE the write. decodeParams throws
  // on anything short of exactly what the engine expects — a genuinely
  // truncated or malformed hoops_params.json never gets near the transaction.
  try {
    decodeParams(bundle.params);
  } catch (err) {
    const message = err instanceof StaleBlobError || err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `invalid params: ${message}` }, { status: 400 });
  }

  // 🔴 Structural completeness gate, found necessary by falsification while
  // building this route: decodeParams alone says nothing about whether
  // hoops_teams/players/schedule/results/lines actually have a plausible
  // AMOUNT of content — a bundle truncated to 5 players parsed fine and
  // passed decodeParams. This is what catches that BEFORE the transaction.
  try {
    validatePushedBundle(bundle);
  } catch (err) {
    const message = err instanceof BundleRejection || err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `invalid bundle: ${message}` }, { status: 400 });
  }

  try {
    const summary = importPushedBundle(bundle, {
      hash: contentHash,
      generatedAt: contract.generatedAt,
      pricingVersion: contract.pricingVersion,
      features: contract.features,
      constants,
    });
    return NextResponse.json({
      imported: summary.imported,
      reason: summary.reason,
      paramVersion: summary.paramVersion,
      generatedAt: summary.generatedAt,
      contentHash: summary.contentHash,
      counts: summary.counts,
      contractUsedFallback: contract.usedFallback,
    });
  } catch (err) {
    // A malformed teams/players/schedule/results/lines file throws here
    // (e.g. better-sqlite3 refusing to bind an undefined field) — inside
    // db.transaction(), which ROLLS BACK on any thrown exception before
    // re-throwing, so the previous read model is guaranteed intact. See
    // lib/hoops/import.ts's importPushedBundle docstring.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/hoops/import] rejected:", message);
    return NextResponse.json({ error: `bundle rejected: ${message}` }, { status: 400 });
  }
}
