// Project a hoops-sim export into the SQLite read model.
//
// Two byte sources, one write path (`writeBundle`):
//
//   SEED  — the committed hoops-data/*.json in this repo. Cold-start only:
//           `ensureHoopsImport()` reaches for it exactly once, when the
//           volume has never held ANY hoops data at all, so a fresh Railway
//           deploy doesn't ship a blank /hoops. See "cold start" below.
//   PUSH  — POST /api/hoops/import (kad-air/keith-hub#73), the Mac Mini
//           pushing a fresh bundle at will. This is the PRODUCTION byte
//           source going forward — see CLAUDE.md's "Hoops" section.
//
// 🔴 Cold-start choice, stated explicitly: committed bundle as fallback, with
// VOLUME STATE WINNING once anything real has landed. `hoops_params.
// import_source` records which family produced the current data ('seed' or
// 'push'). The instant a push lands, the disk path is permanently disabled
// for that volume — ensureHoopsImport() checks import_source FIRST and
// returns immediately if it's already 'push', never even reading disk. That
// is what makes "Mini pushes stale committed bytes back over a fresh push on
// the next redeploy" structurally impossible rather than merely unlikely:
// there's a redeploy on every push to main, and a real trade could land on
// the Mini in between.
//
// Until the first push, behaviour is UNCHANGED from before this milestone:
// a redeploy carrying a refreshed committed bundle still auto-imports it
// (hash comparison, as always) — this is what keeps /hoops non-blank between
// "the repo has a section" and "the Mini has pushed for the first time".
//
// 🔴 The USER tables (hoops_scratch, hoops_runs) are NOT touched here. The
// data flows one way only: Mini → hub. Nothing in keith-hub ever writes back
// to hoops-sim.

import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { bundleHash, loadBundle, readParamsBlobText } from "./data";
import { decodeParams } from "./params";
import { playerRowsFromBundle } from "./playervalue.ts";
import type { HoopsBundle } from "./types";

export type ImportSource = "seed" | "push";

export interface ImportSummary {
  imported: boolean;
  reason: "unchanged" | "first-import" | "content-changed" | "push-authoritative";
  paramVersion: string;
  generatedAt: string;
  contentHash: string;
  importSource: ImportSource;
  counts: {
    teams: number;
    players: number;
    schedule: number;
    results: number;
    lines: number;
  };
}

interface StoredState {
  hash: string;
  generatedAt: string;
  count: number;
  importSource: ImportSource;
  /** false for a row written before kad-air/keith-hub#73's migration added
   *  hca_pts/replacement_per36/value_as_of — see the no-op check below. */
  hasScalars: boolean;
  /** false when no player row carries value_off_per36 — i.e. this read model
   *  was written by the importer as it stood before /hoops/players, which
   *  dropped the split. Same purpose as hasScalars: force one rewrite so an
   *  existing volume backfills instead of serving null forever. */
  hasPlayerSplit: boolean;
  /** Same trick again, for the stack rating / value-per-game fields: false
   *  when no player row carries value_pg, i.e. this read model predates that
   *  milestone. Marker column is value_pg (not stack_net_per36) so a bundle
   *  that ships the stack rate without a minutes read still forces a rewrite. */
  hasStackFields: boolean;
  /** And a fourth time, for the nightly team read (hub-v2). Same reason: the
   *  migration in lib/db.ts adds the columns but leaves every value NULL, and
   *  an unchanged content hash would otherwise keep them that way forever, so
   *  an existing volume would show three rating lenses when the bundle carries
   *  four. */
  hasNightly: boolean;
  /** A fifth time, for the explain sidecar (the player page's "how we got
   *  here" block). Marker column is explain_json on hoops_players. */
  hasExplain: boolean;
  /** And a sixth, for the nightly movers (the team page's "what moved").
   *  Marker column is nightly_movers_json on hoops_teams — the blob itself
   *  rather than one of the scalars beside it, because the blob is the thing
   *  the block cannot be rendered without. */
  hasMovers: boolean;
  /** And a seventh, for the two REPLACEMENT-LEVEL display fields (issue #70
   *  F5): false when no player row carries value_per_game_above_replacement,
   *  i.e. this read model predates the owner's "0 = replacement player"
   *  decision. Same trick, same reason: the migration adds the columns but
   *  leaves every value NULL, and an unchanged content hash would otherwise
   *  keep it that way forever. */
  hasAboveReplacement: boolean;
  /** And an eighth, for `replacement_tilt_per36` (issue #70 F5 round 2,
   *  2026-09-04, "one scale on every player surface"): a pre-existing DB
   *  already past the hasScalars/hasAboveReplacement migrations would
   *  otherwise never learn this bundle-level scalar exists, since it rides
   *  on `hoops_params` alongside `hca_pts` but arrived in a LATER migration.
   *  Read directly off `hoops_params`, not derived from `hasScalars`. */
  hasReplacementTilt: boolean;
}

function currentState(db: Database.Database): StoredState | null {
  const row = db
    .prepare(
      `SELECT content_hash, generated_at, import_source, hca_pts, replacement_tilt_per36
         FROM hoops_params WHERE id = 1`,
    )
    .get() as
    | {
        content_hash: string;
        generated_at: string;
        import_source: ImportSource;
        hca_pts: number | null;
        replacement_tilt_per36: number | null;
      }
    | undefined;
  if (!row) return null;
  const count = (
    db.prepare(`SELECT COUNT(*) AS n FROM hoops_teams`).get() as { n: number }
  ).n;
  const split = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM hoops_players WHERE value_off_per36 IS NOT NULL`)
      .get() as { n: number }
  ).n;
  const stack = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM hoops_players WHERE value_pg IS NOT NULL`)
      .get() as { n: number }
  ).n;
  const nightly = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM hoops_teams WHERE nightly_off IS NOT NULL`)
      .get() as { n: number }
  ).n;
  const explain = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM hoops_players WHERE explain_json IS NOT NULL`)
      .get() as { n: number }
  ).n;
  const movers = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM hoops_teams WHERE nightly_movers_json IS NOT NULL`)
      .get() as { n: number }
  ).n;
  const aboveReplacement = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM hoops_players WHERE value_per_game_above_replacement IS NOT NULL`)
      .get() as { n: number }
  ).n;
  return {
    hash: row.content_hash,
    generatedAt: row.generated_at,
    count,
    importSource: row.import_source,
    hasScalars: row.hca_pts !== null,
    hasPlayerSplit: split > 0,
    hasStackFields: stack > 0,
    hasNightly: nightly > 0,
    hasExplain: explain > 0,
    hasMovers: movers > 0,
    hasAboveReplacement: aboveReplacement > 0,
    hasReplacementTilt: row.replacement_tilt_per36 !== null,
  };
}

interface WriteMeta {
  hash: string;
  generatedAt: string;
  importSource: ImportSource;
  paramsBlobText: string;
  /** Full, merged constants object for this write — stored verbatim (JSON) so
   *  a constant this receiver doesn't yet read by name is still preserved,
   *  never dropped, in case a future feature wants it (#24's design
   *  principle: push variability into the payload). null for the disk-seed
   *  path, which has no envelope-level constants block of its own — the
   *  engine's stale-blob guard already requires hoops_params.json's own
   *  nested `constants` regardless (see decodeParams). */
  constants: Record<string, unknown> | null;
  pricingVersion: number | null;
  features: string[] | null;
}

function writeBundle(db: Database.Database, bundle: HoopsBundle, meta: WriteMeta): void {
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Read-model only. hoops_scratch / hoops_runs are deliberately absent.
    db.exec(`
      DELETE FROM hoops_teams;
      DELETE FROM hoops_players;
      DELETE FROM hoops_schedule;
      DELETE FROM hoops_results;
      DELETE FROM hoops_lines;
      DELETE FROM hoops_params;
    `);

    db.prepare(
      `INSERT INTO hoops_params
         (id, param_version, blob, generated_at, imported_at, content_hash, import_source,
          hca_pts, replacement_per36, value_as_of, pricing_version, features_json, constants_json,
          nightly_as_of, nightly_value_source, nightly_last_n_games, nightly_priced,
          explain_model_json, nightly_league_typical_shift, replacement_tilt_per36)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bundle.params.parameter_set.param_version,
      meta.paramsBlobText,
      meta.generatedAt,
      now,
      meta.hash,
      meta.importSource,
      bundle.teams.hca_pts,
      bundle.players.replacement_per36,
      bundle.players.value_as_of,
      meta.pricingVersion,
      meta.features ? JSON.stringify(meta.features) : null,
      meta.constants ? JSON.stringify(meta.constants) : null,
      bundle.teams.nightly_as_of ?? null,
      bundle.teams.nightly_value_source ?? null,
      bundle.teams.nightly_last_n_games ?? null,
      // 🔴 The sender says whether its nightly read is fit to PRICE with (it
      // declares `nightly_strength`) as distinct from merely being present. The
      // block ships either way, so the site can show the number before it is
      // allowed to bet on it. NULL when the sender said nothing, which the
      // reader treats as "display only".
      bundle.teams.nightly_priced == null ? null : bundle.teams.nightly_priced ? 1 : 0,
      // The explain sidecar's league-level facts (tape window, memory, the
      // wage sheet in points per event). NULL when the bundle predates it.
      bundle.players.explain_model ? JSON.stringify(bundle.players.explain_model) : null,
      // How far the 30-team AVERAGE moved between the nightly reading and the
      // season-typical one. Deliberately NOT charged to any player — a mover's
      // number is his own team's change, and this is the level under all of
      // them. NULL when the sender said nothing.
      bundle.teams.nightly_league_typical_shift ?? null,
      // REPLACEMENT-ZERO ROUND 2 (issue #70 F5): the off-minus-def LEAN of a
      // replacement-level player, needed to split replacement_per36 the same
      // way every other player's net splits into off/def. NULL on a bundle
      // that predates it — every reader must fall back to the old rendering.
      bundle.players.replacement_tilt_per36 ?? null,
    );

    const insTeam = db.prepare(
      `INSERT INTO hoops_teams
         (tri, conference, division, results_off, results_def, roster_off, roster_def,
          blend_off, blend_def,
          nightly_off, nightly_def, nightly_results_w, nightly_n_basis_games, nightly_abstained,
          nightly_movers_json, nightly_delta_pre_mix, nightly_delta_post_mix,
          nightly_n_movers_total, nightly_movers_delta_sum)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [tri, t] of Object.entries(bundle.teams.teams)) {
      insTeam.run(
        tri,
        t.conference,
        t.division,
        t.results.off,
        t.results.def,
        t.roster.off,
        t.roster.def,
        t.blend.off,
        t.blend.def,
        // 🔴 NULL, never 0, when this bundle carries no nightly read for this
        // team — all-NULL is what tells the UI it has nothing to show, and a 0
        // would read on screen as "exactly average lately".
        t.nightly?.off ?? null,
        t.nightly?.def ?? null,
        t.nightly?.results_w ?? null,
        t.nightly?.n_basis_games ?? null,
        t.nightly ? (t.nightly.abstained ? 1 : 0) : null,
        // WHAT MOVED. Same NULL-never-zero discipline: the sender omits all six
        // on a team it abstained on (nothing was re-priced, so nothing moved to
        // explain), and an empty list here would read on screen as "nobody
        // moved". The blob is the marker column the no-op check watches.
        t.nightly?.movers ? JSON.stringify(t.nightly.movers) : null,
        t.nightly?.delta_pre_mix ?? null,
        t.nightly?.delta_post_mix ?? null,
        t.nightly?.n_movers_total ?? null,
        t.nightly?.movers_delta_sum ?? null,
      );
    }

    // 🔴 The projection lives in playervalue.ts, not inline here, so the build
    // gate can drive the REAL one over the REAL bundle. It is what decides
    // whether the offence/defence value split survives the trip from JSON into
    // SQLite — and before /hoops/players it silently did not: the exporter had
    // been shipping value_off_per36/value_def_per36 for months and this loop
    // dropped both on the floor.
    const insPlayer = db.prepare(
      `INSERT INTO hoops_players
         (athlete_id, nba_player_id, tri, name, minutes,
          value_per36, value_off_per36, value_def_per36, game_rates, per36,
          stack_net_per36, stack_off_per36, stack_def_per36, expected_minutes, value_pg, evidence,
          value_per36_above_replacement, value_per_game_above_replacement,
          explain_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of playerRowsFromBundle(bundle.players)) {
      insPlayer.run(
        p.athlete_id,
        p.nba_player_id,
        p.tri,
        p.name,
        p.minutes,
        p.value_per36,
        p.value_off_per36,
        p.value_def_per36,
        p.game_rates ? JSON.stringify(p.game_rates) : null,
        p.per36 ? JSON.stringify(p.per36) : null,
        p.stack_net_per36,
        p.stack_off_per36,
        p.stack_def_per36,
        p.expected_minutes,
        p.value_pg,
        p.evidence,
        // REPLACEMENT-ZERO (issue #70 F5): 0 = the last man a team could
        // find, not an average NBA player. Display fields only.
        p.value_per36_above_replacement,
        p.value_per_game_above_replacement,
        p.explain ? JSON.stringify(p.explain) : null,
      );
    }

    const insGame = db.prepare(
      `INSERT INTO hoops_schedule (game_id, date, home, away, neutral_site)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const g of bundle.schedule.games) {
      insGame.run(g.game_id, g.date, g.home, g.away, g.neutral_site ? 1 : 0);
    }

    const insResult = db.prepare(
      `INSERT INTO hoops_results (game_id, date, home, away, home_score, away_score, neutral_site)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const g of bundle.results.games) {
      insResult.run(
        g.game_id,
        g.date,
        g.home,
        g.away,
        g.home_score,
        g.away_score,
        g.neutral_site ? 1 : 0,
      );
    }

    const insLine = db.prepare(
      `INSERT INTO hoops_lines
         (game_id, date, home, away, home_spread, total, home_odds, away_odds, n_books_spread, n_books_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of bundle.lines.lines) {
      insLine.run(
        l.game_id,
        l.date,
        l.home,
        l.away,
        l.home_spread ?? null,
        l.total ?? null,
        l.home_odds ?? null,
        l.away_odds ?? null,
        l.n_books_spread ?? null,
        l.n_books_total ?? null,
      );
    }
  });

  tx();
}

function countsOf(bundle: HoopsBundle): ImportSummary["counts"] {
  return {
    teams: Object.keys(bundle.teams.teams).length,
    players: bundle.players.players.length,
    schedule: bundle.schedule.games.length,
    results: bundle.results.games.length,
    lines: bundle.lines.lines.length,
  };
}

function verifyWrite(db: Database.Database, counts: ImportSummary["counts"]): void {
  // Post-write verification: what landed must be what the bundle said. A
  // silent row shortfall (a failed insert, a UNIQUE collision) would show up
  // three screens later as a missing team, which is exactly the kind of
  // thing that's very hard to see afterwards.
  const wrote = {
    teams: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_teams`).get() as { n: number }).n,
    players: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_players`).get() as { n: number }).n,
    schedule: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_schedule`).get() as { n: number }).n,
    results: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_results`).get() as { n: number }).n,
    lines: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_lines`).get() as { n: number }).n,
  };
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (wrote[key] !== counts[key]) {
      throw new Error(
        `hoops import: wrote ${wrote[key]} ${key} rows but the bundle has ${counts[key]}`,
      );
    }
  }
}

/**
 * Import the committed disk bundle (hoops-data/*.json). `force` re-imports
 * even when the content hash is unchanged. Never overwrites a 'push'-sourced
 * read model, regardless of `force` — see the module docstring's cold-start
 * section. This is the ONLY thing that ever calls `loadBundle()` for a write.
 */
export function importHoopsData(force = false): ImportSummary {
  const db = getDb();
  const bundle = loadBundle();

  // 🔴 Stale-blob guard, on the write path. A blob the engine doesn't
  // recognise never reaches SQLite — decodeParams throws instead.
  decodeParams(bundle.params);

  const hash = bundleHash();
  const state = currentState(db);
  const counts = countsOf(bundle);

  if (state?.importSource === "push") {
    // A real push is always authoritative over the committed fallback, full
    // stop — see the module docstring. This is what a fresh git commit to
    // hoops-data/*.json (still possible during the transition, or after) can
    // never silently clobber.
    return {
      imported: false,
      reason: "push-authoritative",
      paramVersion: bundle.params.parameter_set.param_version,
      generatedAt: state.generatedAt,
      contentHash: state.hash,
      importSource: "push",
      counts,
    };
  }

  // `state.hasScalars` false means the stored row predates this migration
  // (hca_pts/replacement_per36/value_as_of were added to hoops_params here) —
  // fall through to a real rewrite even though the hash is unchanged, so an
  // existing prod DB backfills those columns on its next boot instead of
  // reading meta.replacementPer36 as null forever (getHoopsMeta no longer
  // has a disk fallback for it — see queries.ts).
  //
  // The same trick, for the same reason, on the offence/defence value split:
  // a read model written before /hoops/players has the columns (the migration
  // in lib/db.ts adds them) but every value is NULL, and an unchanged content
  // hash would otherwise keep it that way forever. Only demanded when THIS
  // bundle actually carries a split, so an older bundle that genuinely has
  // none doesn't trigger a pointless rewrite on every boot.
  const bundleHasSplit = bundle.players.players.some((p) => p.value_off_per36 != null);
  const splitSettled = !bundleHasSplit || state?.hasPlayerSplit === true;

  // Same trick a third time, for the stack rating / value-per-game fields
  // this milestone adds.
  const bundleHasStack = bundle.players.players.some((p) => p.value_pg != null);
  const stackSettled = !bundleHasStack || state?.hasStackFields === true;

  // A fourth time, for the nightly team read (hub-v2).
  const bundleHasNightly = Object.values(bundle.teams.teams).some((t) => t.nightly != null);
  const nightlySettled = !bundleHasNightly || state?.hasNightly === true;

  // A fifth time, for the explain sidecar (the player page).
  const bundleHasExplain = bundle.players.players.some((p) => p.explain != null);
  const explainSettled = !bundleHasExplain || state?.hasExplain === true;

  // A sixth time, for the nightly movers (the team page's "what moved").
  const bundleHasMovers = Object.values(bundle.teams.teams).some((t) => t.nightly?.movers != null);
  const moversSettled = !bundleHasMovers || state?.hasMovers === true;

  // A seventh time, for the two replacement-level display fields (issue #70
  // F5, "I would like 0 to be replacement player").
  const bundleHasAboveReplacement = bundle.players.players.some(
    (p) => p.value_per_game_above_replacement != null,
  );
  const aboveReplacementSettled = !bundleHasAboveReplacement || state?.hasAboveReplacement === true;

  // An eighth time, for replacement_tilt_per36 (issue #70 F5 round 2,
  // 2026-09-04, "one scale on every player surface"). A bundle-level scalar,
  // not per-player, so the presence check reads the file directly rather than
  // scanning `players`.
  const bundleHasReplacementTilt = bundle.players.replacement_tilt_per36 != null;
  const replacementTiltSettled = !bundleHasReplacementTilt || state?.hasReplacementTilt === true;

  if (
    !force &&
    state &&
    state.hash === hash &&
    state.count > 0 &&
    state.hasScalars &&
    splitSettled &&
    stackSettled &&
    nightlySettled &&
    explainSettled &&
    moversSettled &&
    aboveReplacementSettled &&
    replacementTiltSettled
  ) {
    return {
      imported: false,
      reason: "unchanged",
      paramVersion: bundle.params.parameter_set.param_version,
      generatedAt: bundle.params.generated_at,
      contentHash: hash,
      importSource: "seed",
      counts,
    };
  }

  writeBundle(db, bundle, {
    hash,
    generatedAt: bundle.params.generated_at,
    importSource: "seed",
    paramsBlobText: readParamsBlobText(),
    constants: (bundle.params.constants as unknown as Record<string, unknown>) ?? null,
    pricingVersion: null,
    features: null,
  });
  verifyWrite(db, counts);

  return {
    imported: true,
    reason: state ? "content-changed" : "first-import",
    paramVersion: bundle.params.parameter_set.param_version,
    generatedAt: bundle.params.generated_at,
    contentHash: hash,
    importSource: "seed",
    counts,
  };
}

export interface PushMeta {
  hash: string;
  generatedAt: string;
  pricingVersion: number;
  features: string[];
  /** The envelope's top-level (post-merge-with-fallback) constants object. */
  constants: Record<string, unknown>;
}

/**
 * Import a bundle pushed via POST /api/hoops/import. Always wins over the
 * disk seed (`importSource: 'push'`), and over an EARLIER push too — the
 * newest push is always what's live. Caller (the route handler) has already
 * run the wire-contract negotiation (features/pricing_version/required
 * constants/staleness) — this function does the structural stale-blob guard
 * and the actual transactional write, nothing else.
 *
 * Throws on a structurally invalid bundle (decodeParams, or a missing field
 * better-sqlite3 refuses to bind) BEFORE or DURING the transaction — either
 * way the transaction rolls back and the previous read model is untouched
 * (better-sqlite3's `db.transaction()` wraps the whole body and issues
 * ROLLBACK on any thrown exception, so this needs no separate try/catch of
 * its own to get that guarantee).
 */
export function importPushedBundle(bundle: HoopsBundle, meta: PushMeta): ImportSummary {
  const db = getDb();

  decodeParams(bundle.params);

  const counts = countsOf(bundle);
  writeBundle(db, bundle, {
    hash: meta.hash,
    generatedAt: meta.generatedAt,
    importSource: "push",
    paramsBlobText: JSON.stringify(bundle.params),
    constants: meta.constants,
    pricingVersion: meta.pricingVersion,
    features: meta.features,
  });
  verifyWrite(db, counts);

  const state = currentState(db);
  return {
    imported: true,
    reason: state && state.hash === meta.hash ? "content-changed" : "first-import",
    paramVersion: bundle.params.parameter_set.param_version,
    generatedAt: meta.generatedAt,
    contentHash: meta.hash,
    importSource: "push",
    counts,
  };
}

let ensured = false;

/**
 * Called by every hoops read. Cheap after the first call in a process — the
 * hash is computed once and memoized. Only ever touches disk (the committed
 * cold-start seed) — see the module docstring for why a push, once it has
 * landed, disables this permanently for the life of the volume.
 */
export function ensureHoopsImport(): void {
  if (ensured) return;
  const summary = importHoopsData();
  if (summary.imported) {
    console.log(
      `[hoops] imported export ${summary.generatedAt} (${summary.reason}): ` +
        `${summary.counts.teams} teams, ${summary.counts.players} players, ` +
        `${summary.counts.schedule} scheduled, ${summary.counts.results} results, ` +
        `${summary.counts.lines} lines — PARAM_VERSION ${summary.paramVersion}`,
    );
  } else if (summary.reason === "push-authoritative") {
    console.log(
      `[hoops] skipping committed seed — a pushed bundle (${summary.generatedAt}) is already live`,
    );
  }
  ensured = true;
}
