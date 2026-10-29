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
  checkFeatureCoherence,
  checkFeatureConstants,
  checkFeatureFiles,
  checkFeatures,
  checkPricingVersion,
  checkRequiredConstants,
  computeContentHash,
  describeContract,
  resolveContract,
} from "@/lib/hoops/contract";
import { importPushedBundle } from "@/lib/hoops/import";
import { decodeParams, StaleBlobError } from "@/lib/hoops/params";
import { BundleRejection, validatePushedBundle } from "@/lib/hoops/bundleValidation";
import { ProjectionRejection, validateProjections } from "@/lib/hoops/projections";
import { storedProjectionGeneratedAt } from "@/lib/hoops/projectionStore";
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

/**
 * GET /api/hoops/import — DISCOVERY. What this receiver accepts, so the
 * sender can ask before it declares a token (the "receiver first" deploy
 * order: a token this receiver has never heard of rejects the whole push,
 * so hoops-sim probes this and only adds a token it sees listed). Same
 * bearer auth as the POST — the shape is not a secret, but the endpoint
 * must not become a public fingerprint of the deployment either. Also
 * reports what is currently stored, so the sender can tell whether its
 * last publish landed without reading the site.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getDb();
  const stored = db
    .prepare(`SELECT generated_at, content_hash, import_source FROM hoops_params WHERE id = 1`)
    .get() as { generated_at: string; content_hash: string; import_source: string } | undefined;
  const projection = db
    .prepare(`SELECT as_of_date, generated_at FROM hoops_projection_meta WHERE id = 1`)
    .get() as { as_of_date: string; generated_at: string } | undefined;
  // How whole the stored schedule is, so the sender can see whether its
  // partial slate landed (and how many games it still owes). NULL columns
  // mean a row from before `partial_schedule` existed: complete by the old
  // exact-1,230 rule.
  const sched = db
    .prepare(
      `SELECT schedule_complete, schedule_n_pending, schedule_season_start_year
         FROM hoops_params WHERE id = 1`,
    )
    .get() as
    | {
        schedule_complete: number | null;
        schedule_n_pending: number | null;
        schedule_season_start_year: number | null;
      }
    | undefined;
  const scheduled = (db.prepare(`SELECT COUNT(*) AS n FROM hoops_schedule`).get() as { n: number }).n;
  return NextResponse.json({
    ...describeContract(),
    stored: stored
      ? {
          generated_at: stored.generated_at,
          content_hash: stored.content_hash,
          import_source: stored.import_source,
          projection: projection
            ? { as_of_date: projection.as_of_date, generated_at: projection.generated_at }
            : null,
          schedule: {
            season_start_year: sched?.schedule_season_start_year ?? null,
            n_games: scheduled,
            complete: sched?.schedule_complete == null ? true : sched.schedule_complete === 1,
            n_pending: sched?.schedule_n_pending ?? 0,
          },
        }
      : null,
  });
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
    checkFeatureCoherence(contract.features);
    checkPricingVersion(contract.pricingVersion);
    checkRequiredConstants(constants);
    // Feature-scoped, so a v1 bundle is untouched — see FEATURE_CONSTANTS.
    checkFeatureConstants(contract.features, constants);
    // Same again for files: `season_projection` demands projections.json.
    checkFeatureFiles(contract.features, files);
  } catch (err) {
    if (err instanceof ContractRejection) {
      // The rejection body carries what IS accepted, so a sender that gets
      // refused for a token can read the answer off the refusal as well as
      // off the GET.
      return NextResponse.json({ error: err.message, accepts: describeContract() }, { status: 400 });
    }
    throw err;
  }

  // THE REST-OF-SEASON PROJECTION. Gated on the token, not on the file: a
  // sender that has not declared `season_projection` has not said the file is
  // fit to show, so an undeclared projections.json is ignored exactly as every
  // other unlisted file in `files` always has been. A DECLARED one is validated
  // in full (lib/hoops/projections.ts — the shape, the nesting, the league
  // identities) and a failure refuses the whole push, naming the first
  // problem, before anything is written.
  if (contract.features.includes("season_projection")) {
    try {
      bundle.projections = validateProjections(files["projections.json"]);
    } catch (err) {
      if (err instanceof ProjectionRejection) {
        return NextResponse.json({ error: `invalid projection: ${err.message}` }, { status: 400 });
      }
      throw err;
    }
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

  // The same exception again for the nightly team read (hub-v2): the migration
  // adds the columns but leaves them NULL, and a same-hash re-POST would
  // otherwise freeze them that way, so the site would show three rating lenses
  // when the bundle carries four. Falls through to one real write, once.
  const storedNightly = (
    db.prepare(`SELECT COUNT(*) AS n FROM hoops_teams WHERE nightly_off IS NOT NULL`).get() as {
      n: number;
    }
  ).n;
  const bundleCarriesNightly = Object.values(
    (files["hoops_teams.json"] as RawTeamsFile | undefined)?.teams ?? {},
  ).some((t) => t.nightly != null);
  const nightlySettled = !bundleCarriesNightly || storedNightly > 0;

  // PARTIAL SCHEDULE (`partial_schedule`): whether this bundle may be short
  // of 1,230 games. Decided by the TOKEN, never by the file's own fields —
  // validatePushedBundle below holds the schedule to the exact rule without
  // it, and to the per-team arithmetic with it (lib/hoops/schedule.ts).
  const partialSchedule = contract.features.includes("partial_schedule");

  // And once more for the projection: if THIS push carries one that the
  // stored copy does not match, a same-hash short-circuit must not drop it
  // (a sender whose content_hash scope forgot to include projections.json
  // would otherwise publish a fresh projection every night that never lands).
  const projectionSettled =
    !bundle.projections || storedProjectionGeneratedAt(db) === bundle.projections.generated_at;

  // And for the schedule status: a row written before the hub stored how
  // whole its schedule was has NULL there, and a same-hash re-POST must fall
  // through once so the columns stop reading NULL (the importer's seed-path
  // marker, mirrored here for the push path exactly as splitSettled is).
  const storedSchedule = db
    .prepare(`SELECT schedule_complete FROM hoops_params WHERE id = 1`)
    .get() as { schedule_complete: number | null } | undefined;
  const scheduleSettled = storedSchedule?.schedule_complete != null;

  if (existing && existing.content_hash === contentHash && splitSettled && nightlySettled && scheduleSettled && projectionSettled) {
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
    validatePushedBundle(bundle, { partialSchedule });
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
      projection: bundle.projections
        ? { as_of_date: bundle.projections.as_of_date, generated_at: bundle.projections.generated_at }
        : null,
      schedule: {
        n_games: bundle.schedule.games.length,
        complete: partialSchedule ? bundle.schedule.complete === true : true,
        n_pending: partialSchedule ? (bundle.schedule.n_pending ?? 0) : 0,
      },
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
